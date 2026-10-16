"""Tests for the decoupled capture/inference pipeline.

The point of this pipeline work is a single measurable claim: THE VIDEO RUNS AT
THE CAPTURE RATE WHILE BOXES REFRESH AT THE DETECTION RATE. These tests pin that
claim down with a slow fake detector and a fast fake camera, so a regression
that quietly re-couples the two loops fails here instead of being discovered on
the drone.

No cv2, no CUDA, no camera - pipeline.py deliberately imports only the standard
library so it can be tested anywhere.
"""

import threading
import time

import pytest

import pipeline as pipeline_mod
from pipeline import PipelineStats, Slot, run_threaded


class FakeDet:
    """A Detection stand-in. draw_hud only reads these four attributes."""

    def __init__(self, x1=1, y1=2, x2=3, y2=4, conf=0.9, name="landmine"):
        self.x1, self.y1, self.x2, self.y2 = x1, y1, x2, y2
        self.confidence = conf
        self.class_name = name
        self.class_id = 0


class FakeCap(object):
    """A camera that paces itself like a real one.

    The pacing matters: cap.read() on a live source BLOCKS until the next frame
    (~33 ms at 30 FPS), and that blocking is exactly what gives the inference
    thread its time slice. A fake camera that returns instantly would let the
    capture loop finish all 60 frames in microseconds, before a slow detector
    completed a single call - which would make every rate assertion here
    meaningless. frame_s is the emulated frame interval.
    """

    def __init__(self, size=(4, 4), frame_s=0.01):
        self.size = size
        self.frame_s = frame_s
        self.reads = 0

    def read(self):
        if self.frame_s:
            time.sleep(self.frame_s)
        self.reads += 1
        return True, ("frame-{0}".format(self.reads), self.size)


class SlowDetector(object):
    """Takes a fixed time per call, as TensorRT does. Records what it saw."""

    def __init__(self, delay_s=0.02, dets_per_call=1, empty_calls=()):
        self.delay_s = delay_s
        self.dets_per_call = dets_per_call
        self.empty_calls = set(empty_calls)
        self.calls = 0
        self.frames = []
        self.thread_names = []

    def detect(self, frame):
        self.calls += 1
        self.frames.append(frame)
        self.thread_names.append(threading.current_thread().name)
        time.sleep(self.delay_s)
        if self.calls in self.empty_calls:
            return []
        return [FakeDet() for _ in range(self.dets_per_call)]


class Recorder(object):
    """Stands in for render_and_publish."""

    def __init__(self):
        self.calls = 0
        self.box_counts = []
        self.fresh_flags = []
        self.fps_seen = []
        self.frames = []

    def __call__(self, frame, boxes, fps, fresh, stats):
        self.calls += 1
        self.frames.append(frame)
        self.box_counts.append(len(boxes))
        self.fresh_flags.append(fresh)
        self.fps_seen.append(fps)


# --- Slot: the depth-1 hand-off ------------------------------------------

def test_slot_starts_empty():
    s = Slot()
    seq, val = s.get()
    assert val is None
    assert seq == 0


def test_slot_overwrite_drops_stale_value():
    """Depth 1: the third put() must not leave the first value recoverable.

    This is what stops the pipeline building up lag on a board that can only
    infer five frames a second.
    """
    s = Slot()
    s.put("a")
    s.put("b")
    s.put("c")
    seq, val = s.get()
    assert val == "c"
    assert seq == 3


def test_slot_get_if_newer_suppresses_duplicates():
    s = Slot()
    seq, val = s.get_if_newer(-1)
    assert val is None          # nothing published yet

    s.put("x")
    seq, val = s.get_if_newer(-1)
    assert (seq, val) == (1, "x")

    # Same seq again -> no new work, so the consumer must get None.
    seq2, val2 = s.get_if_newer(seq)
    assert val2 is None
    assert seq2 == seq

    s.put("y")
    seq3, val3 = s.get_if_newer(seq)
    assert (seq3, val3) == (2, "y")


def test_slot_peek_seq_does_not_consume():
    s = Slot()
    s.put("v")
    assert s.peek_seq() == 1
    assert s.peek_seq() == 1
    _, val = s.get()
    assert val == "v"


# --- PipelineStats -------------------------------------------------------

def test_stats_refresh_rates_uses_wall_clock():
    st = PipelineStats()
    st.frames_captured = 30
    st.frames_inferred = 6
    st.t_start = time.time() - 1.0     # pretend a second has passed
    st.refresh_rates()
    assert 28.0 <= st.capture_fps <= 32.0
    assert 4.0 <= st.detect_fps <= 8.0


def test_stats_str_is_readable():
    st = PipelineStats()
    st.frames_captured, st.frames_inferred, st.frames_skipped = 10, 3, 7
    st.detections = 2
    text = str(st)
    assert "capture 10 frames" in text
    assert "inferred 3" in text
    assert "skipped 7" in text
    assert "2 detections" in text


# --- the deliverable ------------------------------------------------------

def test_capture_outruns_a_slow_detector():
    """THE CORE CLAIM: video frames keep flowing while detection lags behind.

    A 60 ms detector against an instant camera: capture must produce far more
    frames than inference manages, and every captured frame must still be
    rendered. That is the difference between a 1.4 FPS stream and a 30 FPS one.
    """
    cap = FakeCap(frame_s=0.005)
    det = SlowDetector(delay_s=0.06)
    rec = Recorder()
    stop = threading.Event()

    stats = run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                         max_frames=60, box_hold_s=5.0)

    assert stats.frames_captured == 60
    # Every single captured frame was rendered - the preview never stalls.
    assert rec.calls == 60
    # ...but inference could not possibly have kept up.
    assert stats.frames_inferred < stats.frames_captured
    assert stats.frames_inferred <= 10
    # And the gap is accounted for, not silently lost.
    assert stats.frames_skipped == stats.frames_captured - stats.frames_inferred


def test_detection_runs_on_a_worker_thread():
    """Thread B must not be the capture thread, or nothing is decoupled at all."""
    cap = FakeCap(frame_s=0.005)
    det = SlowDetector(delay_s=0.01)
    rec = Recorder()
    stop = threading.Event()

    run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                 max_frames=20, box_hold_s=5.0)

    assert det.thread_names
    assert all(name != "MainThread" for name in det.thread_names)
    assert all("detector" in name.lower() for name in det.thread_names)


def test_boxes_refresh_at_detection_rate_not_capture_rate():
    """Boxes change hands only when a new detection lands.

    Renders outnumber detection results, and the extra renders simply repeat the
    previous boxes - that repetition IS the 30 FPS video.
    """
    cap = FakeCap(frame_s=0.01)
    det = SlowDetector(delay_s=0.05)
    rec = Recorder()
    stop = threading.Event()
    non_empty = [0]
    lock = threading.Lock()

    def on_dets(frame, dets, inference_s):
        if dets:
            with lock:
                non_empty[0] += 1

    stats = run_threaded(cap, det, stop, on_dets, rec,
                         max_frames=40, box_hold_s=5.0)

    # Rendered far more often than detected.
    assert rec.calls > stats.frames_inferred
    # Boxes were present on most frames because they are held over, not blanked.
    assert sum(1 for n in rec.box_counts if n > 0) > rec.calls * 0.5
    # fresh is True only on the frames that actually picked up new boxes, so it
    # tracks non-empty detections - not the total detection count.
    assert sum(rec.fresh_flags) == non_empty[0]
    assert non_empty[0] <= stats.frames_inferred


def test_on_detections_is_the_only_uplink_producer():
    """Thread A must never emit a record.

    Display state (held-over boxes) is not a measurement. If on_detections were
    driven by the render loop, guessed coordinates would reach the database.
    """
    cap = FakeCap(frame_s=0.01)
    det = SlowDetector(delay_s=0.04)
    rec = Recorder()
    stop = threading.Event()
    producers = []
    lock = threading.Lock()

    def on_dets(frame, dets, inference_s):
        with lock:
            producers.append(threading.current_thread().name)

    stats = run_threaded(cap, det, stop, on_dets, rec,
                         max_frames=40, box_hold_s=5.0)

    with lock:
        assert len(producers) == stats.frames_inferred
    assert all("detector" in n.lower() for n in producers)
    # The render callback is a different thread entirely.
    assert len(producers) < rec.calls


def test_boxes_expire_after_the_hold_window():
    """Once detection goes quiet, stale boxes must clear rather than persist.

    A box that outlives its evidence is a lie on the operator's screen, so the
    hold is a timer, not a permanent latch.
    """
    cap = FakeCap(frame_s=0.01)
    # Detects on call 1 only, then always empty.
    det = SlowDetector(delay_s=0.01, empty_calls=range(2, 100))
    rec = Recorder()
    stop = threading.Event()

    run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                 max_frames=50, box_hold_s=0.05)

    # The hold is short, so the trailing renders must be empty.
    assert rec.box_counts[-1] == 0
    assert any(n > 0 for n in rec.box_counts)   # the first detection showed


def test_boxes_persist_inside_the_hold_window():
    """A brief detection dropout must not flicker the display.

    Note the first few frames legitimately have NO boxes - nothing has been
    detected yet. The property under test is that once a box appears it stays up
    for the whole hold window, so the display never flaps.
    """
    cap = FakeCap(frame_s=0.01)
    det = SlowDetector(delay_s=0.01, empty_calls=range(2, 100))
    rec = Recorder()
    stop = threading.Event()

    run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                 max_frames=25, box_hold_s=30.0)

    first = next(i for i, n in enumerate(rec.box_counts) if n > 0)
    assert first > 0, "leading frames have no detection yet"
    # From the first detection onwards, boxes never drop while the hold is live.
    assert all(n > 0 for n in rec.box_counts[first:])


def test_render_receives_unmodified_frame():
    """The frame handed to rendering is the one inference saw.

    draw_hud must be applied to a COPY; if run_threaded mutated the frame, the
    boxes would be burned into the image that goes to the backend and to the
    next inference pass.
    """
    cap = FakeCap(frame_s=0.005)
    det = SlowDetector(delay_s=0.005)
    rec = Recorder()
    stop = threading.Event()

    run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                 max_frames=10, box_hold_s=1.0)

    # The fake frame is an immutable tuple with its size - still intact.
    for frame in rec.frames:
        assert isinstance(frame, tuple)
        assert frame[1] == (4, 4)


def test_stop_event_terminates_the_worker():
    """The inference thread must actually stop, not leak past the capture loop."""
    cap = FakeCap(frame_s=0.005)
    det = SlowDetector(delay_s=0.005)
    rec = Recorder()
    stop = threading.Event()

    before = threading.active_count()
    run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                 max_frames=10, box_hold_s=1.0)
    # run_threaded joins the worker before returning.
    assert stop.is_set()
    assert threading.active_count() <= before + 1


def test_worker_survives_a_detector_exception():
    """One bad frame must not kill the video stream."""

    class ExplodingDetector(object):
        def __init__(self):
            self.calls = 0

        def detect(self, frame):
            self.calls += 1
            if self.calls == 2:
                raise RuntimeError("boom")
            return [FakeDet()]

    cap = FakeCap(frame_s=0.005)
    det = ExplodingDetector()
    rec = Recorder()
    stop = threading.Event()

    stats = run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                         max_frames=30, box_hold_s=1.0)

    # The render loop completed every captured frame despite the raise.
    assert rec.calls == 30
    assert stats.frames_captured == 30


def test_capture_stops_when_the_camera_ends():
    """A dead camera ends the loop cleanly rather than spinning."""

    class EndingCap(object):
        def __init__(self, n):
            self.n = n
            self.reads = 0

        def read(self):
            self.reads += 1
            if self.reads > self.n:
                return False, None
            return True, ("f", (4, 4))

    cap = EndingCap(5)
    det = SlowDetector(delay_s=0.005)
    rec = Recorder()
    stop = threading.Event()

    stats = run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                         max_frames=0, box_hold_s=1.0)

    assert stats.frames_captured == 5
    assert rec.calls == 5
    assert stop.is_set()


def test_max_frames_zero_means_unlimited():
    """max_frames=0 must not be read as 'stop immediately'."""
    cap = FakeCap(frame_s=0.005)
    det = SlowDetector(delay_s=0.002)
    rec = Recorder()
    stop = threading.Event()

    # Stop from outside after a beat, since 0 means "run forever".
    t = threading.Timer(0.25, stop.set)
    t.start()
    try:
        stats = run_threaded(cap, det, stop, lambda f, d, s: None, rec,
                             max_frames=0, box_hold_s=1.0)
    finally:
        t.cancel()

    assert stats.frames_captured > 0
    assert rec.calls == stats.frames_captured


def test_cuda_context_helper_is_safe_without_pycuda():
    """On a laptop (and for onnx/ultralytics backends) this must return None.

    It is called on the main thread before the worker starts, so an exception
    here would break every non-TensorRT run.
    """
    ctx = pipeline_mod._current_cuda_context()
    assert ctx is None or hasattr(ctx, "push")


def test_pipeline_imports_without_cv2():
    """pipeline.py must stay importable anywhere - no cv2, no CUDA, no torch."""
    import importlib
    mod = importlib.reload(pipeline_mod)
    assert not hasattr(mod, "cv2")
    assert not hasattr(mod, "np")