"""Tests for detector.py's factory and the mock's delay knob.

These are the two things that made the decoupling hard to reason about:

  1. `make_detector` silently DISCARDS unknown kwargs. That is deliberate - the
     CLI passes one flat option bag and each backend takes what it needs - but
     it means a misspelled or unwired flag does nothing at all instead of
     erroring. `--imgsz` is a no-op for --detector trt for exactly this reason,
     and that cost real debugging time. These tests pin the filter down.

  2. `MockDetector.delay_s` is what lets the decoupled pipeline be proven on a
     CPU with no GPU, no model and no Nano: a mock that returns instantly never
     applies back-pressure, so a broken pipeline looks perfect. If the delay
     stops being wired, the proof silently becomes worthless.
"""

import time

import pytest

import detector as detector_mod


def test_mock_delay_defaults_to_zero():
    """Default must stay instant - every existing test and call site relies on it."""
    d = detector_mod.MockDetector()
    assert d.delay_s == 0.0


def test_mock_delay_slows_every_call_not_just_detecting_ones():
    """The sleep must be paid on frames that emit NO box, or the mock is not
    modelling inference cost and the pipeline never sees back-pressure."""
    d = detector_mod.MockDetector(every_n=5, delay_s=0.05)
    frame = _fake_frame()

    start = time.time()
    for _ in range(5):  # only the 5th call emits a box
        d.detect(frame)
    elapsed = time.time() - start

    # 5 calls on a 50 ms mock must cost ~250 ms. If the sleep sat behind the
    # every_n gate this would be well under 100 ms.
    assert elapsed >= 0.20, "5 delayed calls took {0:.3f}s".format(elapsed)


def test_mock_delay_accepts_negative_without_crashing():
    """A negative delay is a typo, not a request to time-travel."""
    assert detector_mod.MockDetector(delay_s=-1.0).delay_s == 0.0


def test_mock_still_detects_when_delayed():
    """Delaying must not change what is detected."""
    d = detector_mod.MockDetector(every_n=1, delay_s=0.001, box_size=40)
    dets = d.detect(_fake_frame())

    assert len(dets) == 1
    assert dets[0].class_name == "landmine_metal"
    assert dets[0].x2 > dets[0].x1


def test_factory_forwards_delay_s_to_the_mock():
    """The CLI passes delay_s on every invocation; losing it silently disables
    the only CPU-side way to reproduce engine latency."""
    d = detector_mod.make_detector("mock", delay_s=0.25, every_n=2)

    assert isinstance(d, detector_mod.MockDetector)
    assert d.delay_s == 0.25
    assert d.every_n == 2


def test_factory_drops_kwargs_the_backend_does_not_accept():
    """Make the discarding behaviour explicit rather than surprising.

    Passing trt-only kwargs to the mock must not raise; it must ignore them.
    """
    d = detector_mod.make_detector(
        "mock",
        delay_s=0.01,
        engine="weights/best.engine",   # trt only
        imgsz=640,                      # onnx/ultralytics only
    )

    assert isinstance(d, detector_mod.MockDetector)
    assert d.delay_s == 0.01
    assert not hasattr(d, "engine")


def test_factory_rejects_an_unknown_backend():
    with pytest.raises(ValueError) as exc:
        detector_mod.make_detector("resnet")

    assert "resnet" in str(exc.value)


def test_factory_defaults_to_mock_on_empty_kind():
    """`--detector ''` should degrade to the safe, model-free backend."""
    assert isinstance(detector_mod.make_detector(""), detector_mod.MockDetector)


def _fake_frame():
    """Small BGR frame. numpy only - this must not need OpenCV or a camera."""
    numpy = pytest.importorskip("numpy")
    return numpy.zeros((288, 512, 3), dtype=numpy.uint8)