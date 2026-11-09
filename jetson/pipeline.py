"""
AeroShield - threaded capture / inference split.

WHY THIS EXISTS
The serial loop in live_detect.py does one cap.read() per detect() call, so the
video frame rate IS the detection rate: ~1.2 FPS at 640, ~5-6 FPS with the rect
engine. You cannot show 30 FPS video that way, no matter how fast inference gets.

This module decouples them:

    thread A (capture)     reads every camera frame, draws the newest boxes on it,
                           publishes it to the MJPEG preview      -> 30 FPS video
    thread B (inference)   grabs the newest frame, runs detect(), geotags/logs/
                           queues the result                      -> ~5-6 FPS
    BackendUplink worker   already exists in uplink.py; drains the upload queue

THE ONE RULE THAT MATTERS
Every shared slot here is DEPTH 1: a plain variable behind a lock. Producers
overwrite whatever is there and consumers take whatever is newest. Nothing ever
queues, so the pipeline cannot accumulate lag - it drops frames instead. That is
deliberate: preview latency stays constant instead of growing without bound on a
board that can only infer 5 frames a second.

COORDINATE SPACE
Box coordinates are in the space of the frame that was DETECTED. Drawing happens
on that same frame (or a scaled copy of it), so no rescaling is needed. If the
capture resolution ever stops matching the inference resolution, the boxes must
be scaled or they will silently drift.

Python 3.6 only - no dataclasses, no walrus, no f-strings-with-= in the code
base style. Keep it that way; this runs on the Nano.
"""

import sys
import threading
import time


class Slot(object):
    """Depth-1 hand-off slot. Overwrite wins; consumers get the newest value."""

    def __init__(self):
        self._lock = threading.Lock()
        self._value = None
        self._seq = 0

    def put(self, value):
        """Publish a value. Any unconsumed previous value is discarded."""
        with self._lock:
            self._value = value
            self._seq += 1
            return self._seq

    def get(self):
        """Return (seq, value). value is None until the first put()."""
        with self._lock:
            return self._seq, self._value

    def get_if_newer(self, last_seq):
        """Return (seq, value) only if something arrived since last_seq."""
        with self._lock:
            if self._seq != last_seq and self._value is not None:
                return self._seq, self._value
            return last_seq, None

    def peek_seq(self):
        with self._lock:
            return self._seq


class PipelineStats(object):
    """Counters for the summary. Plain attribute reads/writes across threads are
    fine here - these are independent integers sampled for a final report, and
    a torn read on Python 3.6 would only ever mis-report a count, never crash."""

    def __init__(self):
        self.t_start = time.time()
        self.frames_captured = 0
        self.frames_inferred = 0
        self.frames_skipped = 0      # captured, but never picked up by inference
        self.detections = 0
        self.last_infer_s = 0.0
        self.infer_total_s = 0.0
        self.capture_fps = 0.0
        self.detect_fps = 0.0
        self.render_total_s = 0.0
        #: How the inference thread attached to the GPU, or why it could not.
        #: Reported in the summary so "inferred 0" is never unexplained.
        self.cuda_context = "not requested"
        #: True once the worker has attached a context (or has nothing to attach).
        self.context_ready = False
        #: True if the worker thread had to be abandoned at shutdown.
        self.worker_hung = False

    def elapsed(self):
        return time.time() - self.t_start

    def refresh_rates(self):
        """Recompute true wall-clock throughput for both threads.

        frames_skipped is DERIVED here rather than counted incrementally.
        Counting gaps as the worker consumes frames misses every frame captured
        after the worker's last pick (and the first frame of the run), so it
        under-reports drops - which is the opposite of what you want from a
        metric whose entire job is to tell you how much you are losing.
        """
        elapsed = self.elapsed()
        if elapsed > 0:
            self.capture_fps = self.frames_captured / elapsed
            self.detect_fps = self.frames_inferred / elapsed
        self.frames_skipped = max(0, self.frames_captured - self.frames_inferred)
        return self

    def __str__(self):
        text = ("capture {0} frames | inferred {1} | skipped {2} | "
                "{3} detections").format(
            self.frames_captured, self.frames_inferred,
            self.frames_skipped, self.detections)
        # Surface a dead worker. "inferred 0" on its own is the exact string
        # this bug printed for hours while the cause sat in the CUDA context,
        # so the reason rides along with the count.
        if self.frames_captured and not self.frames_inferred:
            text += "\n           inference produced NOTHING - {0}".format(
                self.cuda_context)
        if self.worker_hung:
            text += "\n           inference thread was abandoned at shutdown"
        return text


class DetectorThread(threading.Thread):
    """Thread B. Pulls the newest frame, detects, then geotags/logs/queues it.

    on_detections(frame, dets, inference_s) runs ON THIS THREAD, so the JPEG
    encode + upload submit never stall the capture loop.

    This thread is the ONLY producer for the uplink queue. Nothing that thread A
    draws (persisted or interpolated boxes) is ever uploaded - those are display
    state, not measurements, and uploading them would put guessed coordinates in
    the database.

    CUDA CONTEXT - the reason this class is not trivial
    infer_trt.py imports ``pycuda.autoinit``, which creates the CUDA context and
    leaves it current on whichever thread did the importing - the main thread.
    TensorRT then allocates its stream and device buffers there too. A CUDA
    context is current per-THREAD, so the very first ``execute_async_v2`` on this
    worker would fail with "invalid resource handle" even though the engine loaded
    fine. So the context is captured on the main thread at construction time and
    pushed onto this thread for the duration of the loop.

    The push/pop is wrapped and optional: the ONNX, Ultralytics and mock backends
    (and anything running on a laptop) have no pycuda at all and simply skip it.
    """

    def __init__(self, detector, frame_slot, det_slot, stop_event, stats,
                 on_detections=None, quiet=False):
        threading.Thread.__init__(self, name="detector-inference")
        self.daemon = True
        self.detector = detector
        self.frame_slot = frame_slot
        self.det_slot = det_slot
        self.stop_event = stop_event
        self.stats = stats
        self.on_detections = on_detections
        self.quiet = quiet
        self.error = None
        # Capture the caller's CUDA context NOW, while we are still on the thread
        # that ran pycuda.autoinit.
        #
        # `verbose` is on only for the TensorRT backend: an ONNX/Ultralytics/mock
        # detector has no use for a context, and warning about one on a laptop
        # with pycuda installed but no GPU would be noise.
        wants_cuda = getattr(detector, "name", "") == "trt"
        self._cuda_ctx = _current_cuda_context(verbose=wants_cuda)
        self._wants_cuda = wants_cuda

    def run(self):
        pushed = False
        if self._cuda_ctx is not None:
            try:
                self._cuda_ctx.push()
                pushed = True
                self.stats.cuda_context = "attached via {0}".format(
                    _CUDA_CTX_REASON or "unknown strategy")
            except Exception as exc:  # noqa: BLE001
                self.stats.cuda_context = "push() FAILED: {0}".format(exc)
                print("WARNING: could not attach the CUDA context to the inference "
                      "thread ({0}); falling back to the calling thread's".format(exc),
                      file=sys.stderr)
        elif self._wants_cuda:
            # This is the field failure. Say it plainly, once, here - because the
            # symptom downstream is a silent hang, not an exception.
            self.stats.cuda_context = _CUDA_CTX_REASON or "no context found"
            print("ERROR: the TensorRT backend has NO CUDA context on the inference "
                  "thread ({0}).".format(self.stats.cuda_context), file=sys.stderr)
            print("       Inference will hang or fail on this thread. Run "
                  "`make probe-cuda` on the aircraft.", file=sys.stderr)
            print("       Workaround: run with DECOUPLED=0 so inference stays on "
                  "the thread that created the context.", file=sys.stderr)
        else:
            self.stats.cuda_context = "not needed ({0} backend)".format(
                getattr(self.detector, "name", "unknown"))
        self.stats.context_ready = True

        last_seq = -1
        try:
            while not self.stop_event.is_set():
                seq, frame = self.frame_slot.get_if_newer(last_seq)
                if frame is None:
                    # Nothing new yet (or nothing at all). Sleep briefly rather
                    # than spinning - a busy-wait here steals cycles from
                    # capture, which is the thread that has to hit 30 FPS.
                    time.sleep(0.002)
                    continue

                if last_seq >= 0:
                    # Note only the ones we know we dropped; the tail is
                    # reconciled exactly by PipelineStats.refresh_rates().
                    gap = seq - last_seq - 1
                    if gap > 0:
                        self.stats.frames_skipped += gap
                last_seq = seq

                t0 = time.time()
                try:
                    dets = self.detector.detect(frame)
                except Exception as exc:  # noqa: BLE001 - keep the video alive
                    self.error = exc
                    print("WARNING: detect() failed, frame skipped: {0}".format(exc),
                          file=sys.stderr)
                    continue

                if self.stop_event.is_set():
                    # Shutting down: do not post to the uplink after its worker
                    # has been asked to close, or the record lands nowhere.
                    break

                inference_s = time.time() - t0
                self.stats.last_infer_s = inference_s
                self.stats.infer_total_s += inference_s
                self.stats.frames_inferred += 1
                self.stats.detections += len(dets)

                # Publish for display FIRST so the boxes refresh as early as
                # possible, then do the slower logging/upload work.
                self.det_slot.put((frame, dets, inference_s))

                if self.on_detections is not None:
                    try:
                        self.on_detections(frame, dets, inference_s)
                    except Exception as exc:  # noqa: BLE001
                        print("WARNING: detection handling failed: {0}".format(exc),
                              file=sys.stderr)
        finally:
            if pushed:
                try:
                    self._cuda_ctx.pop()
                except Exception:  # noqa: BLE001 - teardown must not raise
                    pass


#: Why _current_cuda_context() returned what it did. Set as a side effect so a
#: caller (and the end-of-run summary) can explain a Missing context instead of
#: reporting a silent zero. Read-only after the first call in practice.
_CUDA_CTX_REASON = ""


def _current_cuda_context(verbose=False):
    """The CUDA context current on THIS thread, or None if pycuda is absent.

    Called on the main thread before the inference thread starts. Never raises -
    a missing pycuda just means a non-TensorRT backend.

    STRATEGIES, IN ORDER (this is the bug fix - read it before editing)
    -----------------------------------------------------------------
    JetPack 4.6 ships pycuda 2019.1.2, which has NO ``Context.get_current``
    (that landed in pycuda 2020.1). The original implementation called it inside
    a bare ``except Exception: return None``, so on the aircraft every run took
    the None branch, the worker thread never attached a context, and the first
    ``execute_async_v2`` had nothing to execute on. The result was not an error:
    it was a HANG. ``detect()`` never returned, the worker never fed the display
    slot, and the run reported ``inferred 0`` with a clean exit.

    So we now try every API that has existed across pycuda versions:

      1. ``Context.get_current()``      pycuda >= 2020.1  (laptops, newer stacks)
      2. ``pycuda.autoinit.context``    every version      (the context autoinit
                                                           actually created)
      3. ``retain_primary_context()``   very old pycuda   (1.0-era Jetson images;
                                                           stores a context for
                                                           later push())
      4. ``make_default_context()``     last resort        (creates a NEW context
                                                           - only correct when
                                                           nothing else owns one,
                                                           because a TensorRT
                                                           engine built against
                                                           a different context
                                                           will reject it)

    Whatever is found is also checked for a ``push`` attribute, because a
    context that cannot be pushed is useless to the worker and is worse than an
    honest None: it would look like success.

    ``verbose=True`` prints the strategy table. Never raises.
    """
    global _CUDA_CTX_REASON

    try:
        import pycuda.driver as cuda
    except Exception as exc:  # noqa: BLE001 - ImportError, or no CUDA driver at all
        _CUDA_CTX_REASON = "pycuda not importable ({0})".format(exc)
        return None

    tried = []

    def _usable(name, ctx):
        """A context the worker can actually attach to itself."""
        if ctx is None:
            tried.append("{0}: None".format(name))
            return None
        if not hasattr(ctx, "push"):
            # e.g. a markered pointer, or an API that changed shape.
            tried.append("{0}: no push()".format(name))
            return None
        tried.append("{0}: OK".format(name))
        return ctx

    # 1. Modern pycuda: Context.get_current() landed in 2020.1.
    get_current = getattr(getattr(cuda, "Context", None), "get_current", None)
    if get_current is not None:
        try:
            ctx = _usable("get_current", get_current())
            if ctx is not None:
                _CUDA_CTX_REASON = "get_current"
                return ctx
        except Exception as exc:  # noqa: BLE001
            tried.append("get_current: raised {0}".format(exc))
    else:
        tried.append("get_current: absent (pycuda < 2020.1)")

    # 2. The context pycuda.autoinit created. Available on EVERY version, which
    #    is exactly why it is the reliable path on JetPack 4.6.
    try:
        import pycuda.autoinit as _autoinit
        ctx = _usable("autoinit.context", getattr(_autoinit, "context", None))
        if ctx is not None:
            _CUDA_CTX_REASON = "pycuda.autoinit.context"
            return ctx
    except Exception as exc:  # noqa: BLE001 - autoinit can fail with no GPU
        tried.append("autoinit: raised {0}".format(exc))

    # 3. Pre-autoinit pycuda: retain the primary context, push() it later.
    retain = getattr(cuda, "retain_primary_context", None)
    if retain is not None:
        try:
            ctx = _usable("retain_primary_context", retain())
            if ctx is not None:
                _CUDA_CTX_REASON = "retain_primary_context"
                return ctx
        except Exception as exc:  # noqa: BLE001
            tried.append("retain_primary_context: raised {0}".format(exc))
    else:
        tried.append("retain_primary_context: absent")

    # 4. Create one. LAST resort: an engine deserialized against a different
    #    context will refuse to run, so this only helps a fresh process.
    make_default = getattr(cuda, "make_default_context", None)
    if make_default is not None:
        try:
            ctx = _usable("make_default_context", make_default())
            if ctx is not None:
                _CUDA_CTX_REASON = "make_default_context (created a NEW context)"
                if verbose:
                    print("WARNING: no existing CUDA context was current; created a "
                          "new one. A TensorRT engine built against another context "
                          "will fail here. Run `make probe-cuda` to see why.",
                          file=sys.stderr)
                return ctx
        except Exception as exc:  # noqa: BLE001
            tried.append("make_default_context: raised {0}".format(exc))

    _CUDA_CTX_REASON = "; ".join(tried)
    if verbose:
        # LOUD. The old silent None is what turned a missing API into a 4-hour
        # hunt through a pipeline that looked merely slow.
        print("WARNING: pycuda is installed but no CUDA context could be "
              "acquired on this thread.", file=sys.stderr)
        for line in tried:
            print("           - {0}".format(line), file=sys.stderr)
        print("         The TensorRT backend needs one. Run `make probe-cuda`.",
              file=sys.stderr)
    return None


def run_threaded(cap, detector, stop_event, on_detections,
                 render_and_publish, max_frames=0, stats=None,
                 box_hold_s=1.0, quiet=False, worker_join_s=5.0):
    """Thread A: the capture loop. Returns when the camera ends or is stopped.

    render_and_publish(frame, boxes, fps, fresh, stats) draws the HUD and pushes
    the preview. It must draw on a COPY - `frame` is still handed to inference.

    `boxes` are the newest results from thread B, held over when a detection
    result comes back empty. `fresh` is True on the iteration that a new
    non-empty detection result first became available, which is the decoupled
    equivalent of "this frame contained detections" for --save-frames.

    Boxes are refreshed at the detection rate; the video runs at the capture
    rate. That is the entire deliverable.
    """
    if stats is None:
        stats = PipelineStats()

    frame_slot = Slot()
    det_slot = Slot()

    worker = DetectorThread(detector, frame_slot, det_slot, stop_event, stats,
                            on_detections=on_detections, quiet=quiet)
    worker.start()

    boxes = []
    last_det_seq = -1
    last_real_det_t = 0.0
    fresh = False
    fps = 0.0
    win_start = time.time()
    win_frames = 0

    try:
        while not stop_event.is_set():
            ok, frame = cap.read()
            if not ok:
                break

            stats.frames_captured += 1
            win_frames += 1

            # Hand the CLEAN frame to inference. cap.read() returns a fresh array
            # each call, so holding this reference is safe.
            frame_slot.put(frame)

            # Pick up the newest boxes if inference has produced any since last
            # time round. This never blocks - if detection is behind, the
            # previous boxes are simply drawn again, which is exactly the
            # "30 FPS video, boxes refreshed at the detection rate" behaviour.
            fresh = False
            dseq, payload = det_slot.get()
            if payload is not None and dseq != last_det_seq:
                last_det_seq = dseq
                if payload[1]:
                    boxes = payload[1]
                    last_real_det_t = time.time()
                    fresh = True
                # An empty result is NOT applied immediately: at 30 FPS capture
                # against ~5 Hz detection, a single blank result is far more
                # likely to be a missed frame than a cleared scene. Let the hold
                # below time it out instead.

            if boxes and (time.time() - last_real_det_t) > box_hold_s:
                boxes = []

            # Rolling capture FPS for the HUD (this is the number that must read
            # ~30). Recomputed once a second so the overlay does not jitter.
            now = time.time()
            elapsed = now - win_start
            if elapsed >= 1.0:
                fps = win_frames / elapsed
                win_frames = 0
                win_start = now
            stats.refresh_rates()

            t_ren = time.time()
            render_and_publish(frame, boxes, fps, fresh, stats)
            stats.render_total_s += time.time() - t_ren

            if max_frames and stats.frames_captured >= max_frames:
                break
    finally:
        stop_event.set()
        # A single detect() on the Nano is ~0.7 s, so this has to be generous
        # enough not to fire on a slow-but-working board. It must NOT be
        # infinite: a worker wedged inside execute_async_v2 ignores the stop
        # event entirely, and the only honest thing to do is report that.
        worker.join(timeout=worker_join_s)
        if worker.is_alive():
            stats.worker_hung = True
            print("WARNING: the inference thread did not stop within {0:.1f} s. It is "
                  "almost certainly blocked inside TensorRT (no usable CUDA context "
                  "on that thread) - it is a daemon thread, so the process can still "
                  "exit.".format(worker_join_s), file=sys.stderr)

    return stats.refresh_rates()