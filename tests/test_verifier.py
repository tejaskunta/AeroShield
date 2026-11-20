"""Tests for verifier.py: the stage-2 crop verifier and the two-stage wrapper.

What must never regress:
  1. Protection: a proposal at or above `protect` is kept WITHOUT being scored,
     so the verifier can only veto borderline boxes (the recall-safety property
     the paper's result depends on).
  2. Veto: a borderline proposal is kept iff cls_p >= tau; below c0 it is gone.
  3. Crop geometry is identical to the evaluated pipeline
     (SafeMineAI two_stage_eval.build_records): square, 20% context, int-truncated
     clipping at frame edges. A verifier fed differently cut crops is a different model.
  4. Preprocessing is ImageNet-normalised NCHW float32, RGB order.
"""

import numpy as np
import pytest

import detector as detector_mod
import verifier as V


class _FixedDetector(detector_mod.Detector):
    name = "fixed"

    def __init__(self, dets):
        self._dets = dets

    def detect(self, frame):
        return list(self._dets)


def _det(conf, box=(10, 10, 50, 50)):
    return detector_mod.Detection(0, "landmine", conf, *box)


def _frame(h=360, w=640):
    return np.full((h, w, 3), 90, dtype=np.uint8)


# ------------------------------------------------------------------ decision rule

def test_keep_rule_matches_paper_rule():
    # conf below c0 is always dropped, even with a perfect classifier score
    assert not V.keep_rule(0.01, 1.0, c0=0.02, protect=0.4, tau=0.1)
    # protected: kept regardless of (missing) classifier score
    assert V.keep_rule(0.4, None, c0=0.02, protect=0.4, tau=0.99)
    # borderline: decided by the classifier
    assert V.keep_rule(0.2, 0.10, c0=0.02, protect=0.4, tau=0.10)
    assert not V.keep_rule(0.2, 0.09, c0=0.02, protect=0.4, tau=0.10)
    assert not V.keep_rule(0.2, None, c0=0.02, protect=0.4, tau=0.10)


def test_protected_boxes_are_never_scored_or_vetoed():
    mock = V.MockVerifier(lambda box: 0.0)        # would veto everything it sees
    dets = [_det(0.9), _det(0.4)]
    vd = V.VerifiedDetector(_FixedDetector(dets), mock, c0=0.02, protect=0.4, tau=0.5)
    out = vd.detect(_frame())
    assert [d.confidence for d in out] == [0.9, 0.4]
    assert all(d.cls_p is None for d in out)
    assert mock.calls == 0                         # nothing borderline -> verifier never ran


def test_borderline_boxes_are_vetoed_by_score():
    scores = {(10, 10, 50, 50): 0.8, (100, 100, 140, 140): 0.05}
    mock = V.MockVerifier(lambda box: scores[tuple(box)])
    dets = [_det(0.2, (10, 10, 50, 50)), _det(0.2, (100, 100, 140, 140)), _det(0.01)]
    vd = V.VerifiedDetector(_FixedDetector(dets), mock, c0=0.02, protect=0.4, tau=0.5)
    out = vd.detect(_frame())
    assert len(out) == 1
    assert out[0].cls_p == pytest.approx(0.8)
    assert vd.last_timing["n_verified"] == 2
    assert vd.last_timing["n_vetoed"] == 1         # the classifier's veto; the sub-c0 box never was a proposal


# ------------------------------------------------------------------ geometry

def test_crop_window_is_square_with_twenty_percent_context():
    a, b, c, d = V.crop_window((100, 100, 140, 120), 640, 360, pad=0.2)
    # side = max(40, 20) * 1.4 = 56, centred on (120, 110)
    assert (a, b, c, d) == (92, 82, 148, 138)
    assert c - a == d - b == 56


def test_crop_window_clips_at_frame_edges():
    a, b, c, d = V.crop_window((0, 0, 30, 30), 640, 360, pad=0.2)
    assert (a, b) == (0, 0)
    assert c == int(15 + 21) and d == int(15 + 21)
    a, b, c, d = V.crop_window((620, 340, 640, 360), 640, 360, pad=0.2)
    assert (c, d) == (640, 360)


def test_crop_window_matches_evaluated_pipeline_formula():
    """Same arithmetic as SafeMineAI two_stage_eval.build_records, float box input."""
    box, w, h, pad = (33.7, 51.2, 98.4, 77.9), 640, 360, 0.2
    bw, bh = box[2] - box[0], box[3] - box[1]
    side = max(bw, bh) * (1 + 2 * pad)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    ref = (int(max(0, cx - side / 2)), int(max(0, cy - side / 2)),
           int(min(w, cx + side / 2)), int(min(h, cy + side / 2)))
    assert V.crop_window(box, w, h, pad) == ref


def test_extract_and_preprocess_shapes_and_channel_order():
    frame = np.zeros((360, 640, 3), dtype=np.uint8)
    frame[:, :, 2] = 255                            # pure red in BGR
    crops = V.extract_crops(frame, [(100, 100, 140, 140)], size=224)
    assert crops.shape == (1, 224, 224, 3)
    assert crops[0, 0, 0].tolist() == [255, 0, 0]   # RGB after conversion
    x = V.preprocess(crops)
    assert x.shape == (1, 3, 224, 224) and x.dtype == np.float32
    assert x[0, 0, 0, 0] == pytest.approx((1.0 - 0.485) / 0.229, rel=1e-5)
    assert x[0, 1, 0, 0] == pytest.approx((0.0 - 0.456) / 0.224, rel=1e-5)


# ------------------------------------------------------------------ factory

def test_factory_wraps_detector_with_mock_verifier():
    det = detector_mod.make_detector("mock", every_n=1, conf=0.02,
                                     verifier_backend="mock", protect=0.4, tau=0.6)
    assert isinstance(det, V.VerifiedDetector)
    assert det.c0 == 0.02 and det.protect == 0.4 and det.tau == 0.6


def test_factory_requires_validation_chosen_thresholds():
    with pytest.raises(ValueError):
        detector_mod.make_detector("mock", verifier_backend="mock", protect=0.4)


def test_factory_without_verifier_is_unchanged():
    det = detector_mod.make_detector("mock")
    assert isinstance(det, detector_mod.MockDetector)
    out = det.detect(_frame()) or []
    assert all(d.cls_p is None for d in out)
