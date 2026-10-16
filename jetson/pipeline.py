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
        return ("capture {0} frames | inferred {1} | skipped {2} | "
                "{3} detections").format(
            self.frames_captured, self.frames_inferred,
            self.frames_skipped, self.detections)


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
        self._cuda_ctx = _current_cuda_context()

    def run(self):
        pushed = False
        if self._cuda_ctx is not None:
            try:
                self._cuda_ctx.push()
                pushed = True
            except Exception as exc:  # noqa: BLE001
                print("WARNING: could not attach the CUDA context to the inference "
                      "thread ({0}); falling back to the calling thread's".format(exc),
                      file=sys.stderr)

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


def _current_cuda_context():
    """The CUDA context current on THIS thread, or None if pycuda is absent.

    Called on the main thread before the inference thread starts. Never raises -
    a missing pycuda just means a non-TensorRT backend.
    """
    try:
        import pycuda.driver as cuda
    except Exception:  # noqa: BLE001 - ImportError, or no CUDA driver at all
        return None
    try:
        return cuda.Context.get_current()
    except Exception:  # noqa: BLE001 - no context current on this thread
        return None


def run_threaded(cap, detector, stop_event, on_detections,
                 render_and_publish, max_frames=0, stats=None,
                 box_hold_s=1.0, quiet=False):
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
        worker.join(timeout=5.0)

    return stats.refresh_rates()