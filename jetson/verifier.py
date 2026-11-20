#!/usr/bin/env python3
"""
AeroShield - stage-2 crop verifier (two-stage detect-then-verify).

Stage 1 (detector.py) proposes boxes at a LOW confidence c0, favouring recall.
Stage 2 (this file) scores a square crop around each BORDERLINE proposal with a
MobileNetV3-Large binary classifier and vetoes the ones that look like
background. Proposals at or above the protection threshold `protect` bypass the
classifier entirely, so the verifier can only remove borderline boxes, never a
confident one:

    keep(det) = conf >= c0  and  (conf >= protect  or  cls_p >= tau)

This is the decision rule evaluated in the SafeMine paper
(SafeMineAI-main/src/common/two_stage_eval.py:keep). The crop geometry and the
normalisation below mirror SafeMineAI-main/src/common/two_stage_eval.py:build_records
and mnv3_shared.preprocess_uint8 byte for byte, because a verifier fed crops cut
differently from its training crops is a different model.

    crop side = max(box_w, box_h) * (1 + 2 * pad)      pad = 0.2 (20% context)
    clipped to the frame, resized to 224x224 (bilinear), BGR -> RGB,
    /255, ImageNet mean/std, NCHW float32

Backends (same interface):
    OnnxVerifier   any PC / laptop: onnxruntime if installed, else OpenCV DNN.
    TrtVerifier    Jetson Nano: a TensorRT engine built ON THE DEVICE from the
                   exported ONNX (build_engine.sh). NOT yet executed on the Nano:
                   the bench unit's hardware failed before integration, so this
                   backend is written against the TensorRT 8.2 API used by
                   infer_trt.py and is untested on device.
    MockVerifier   tests: deterministic scores, no model.

The ONNX graph is exported by SafeMineAI-main/scripts/export_stage2_onnx.py
(opset 12, dynamic batch, logit output - the sigmoid is applied here).

PYTHON 3.6 ONLY at module scope - see the note at the top of infer_trt.py.
"""

import math
import time
from typing import Callable, List, Optional, Sequence

import numpy as np

from detector import Detection, Detector

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 3, 1, 1)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 3, 1, 1)


# ----------------------------------------------------------------------------- geometry

def crop_window(box, frame_w, frame_h, pad=0.2):
    """Square context window around an xyxy box, clipped to the frame.

    Mirrors two_stage_eval.build_records: int() truncation of the clipped
    corners, so the window is identical to the evaluated pipeline.
    Returns (a, b, c, d) = (x1, y1, x2, y2), possibly empty after clipping.
    """
    x1, y1, x2, y2 = [float(v) for v in box]
    bw, bh = x2 - x1, y2 - y1
    side = max(bw, bh) * (1 + 2 * pad)
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    a = int(max(0.0, cx - side / 2.0))
    b = int(max(0.0, cy - side / 2.0))
    c = int(min(float(frame_w), cx + side / 2.0))
    d = int(min(float(frame_h), cy + side / 2.0))
    return a, b, c, d


def extract_crops(frame_bgr, boxes, pad=0.2, size=224):
    """(N, size, size, 3) uint8 RGB crops; a degenerate window yields a grey crop."""
    import cv2

    h, w = frame_bgr.shape[:2]
    out = np.full((len(boxes), size, size, 3), 114, dtype=np.uint8)
    for i, box in enumerate(boxes):
        a, b, c, d = crop_window(box, w, h, pad)
        if c - a < 1 or d - b < 1:
            continue
        crop = cv2.resize(frame_bgr[b:d, a:c], (size, size))
        out[i] = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    return out


def preprocess(crops_rgb_u8):
    """(N, H, W, 3) uint8 RGB -> (N, 3, H, W) float32 ImageNet-normalised."""
    x = crops_rgb_u8.astype(np.float32).transpose(0, 3, 1, 2) / 255.0
    return np.ascontiguousarray((x - IMAGENET_MEAN) / IMAGENET_STD, dtype=np.float32)


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def keep_rule(conf, cls_p, c0, protect, tau):
    """The paper's decision rule. cls_p may be None only when conf >= protect."""
    if conf < c0:
        return False
    if conf >= protect:
        return True
    return cls_p is not None and cls_p >= tau


# ----------------------------------------------------------------------------- backends

class Verifier(object):
    name = "base"
    pad = 0.2
    size = 224

    def _logits(self, x):
        raise NotImplementedError

    def score(self, frame_bgr, boxes) -> np.ndarray:
        """Probability that each box holds a mine, shape (N,)."""
        if len(boxes) == 0:
            return np.zeros(0, dtype=np.float32)
        x = preprocess(extract_crops(frame_bgr, boxes, self.pad, self.size))
        return sigmoid(np.asarray(self._logits(x), dtype=np.float32).reshape(-1))

    def close(self):
        pass


class OnnxVerifier(Verifier):
    name = "onnx"

    def __init__(self, weights, pad=0.2, size=224, prefer="onnxruntime"):
        self.pad, self.size = pad, size
        self._ort = None
        self._net = None
        if prefer == "onnxruntime":
            try:
                import onnxruntime as ort
                self._ort = ort.InferenceSession(weights, providers=["CPUExecutionProvider"])
                self._in = self._ort.get_inputs()[0].name
            except ImportError:
                self._ort = None
        if self._ort is None:
            import cv2
            self._net = cv2.dnn.readNetFromONNX(weights)

    def _logits(self, x):
        if self._ort is not None:
            return self._ort.run(None, {self._in: x})[0]
        self._net.setInput(x)
        return self._net.forward()


class TrtVerifier(Verifier):
    """TensorRT engine with a dynamic batch axis (TRT 8.2 binding API).

    Build on the Nano from the dynamic-batch ONNX, e.g.
        trtexec --onnx=verifier.onnx --saveEngine=verifier.engine --fp16 \
                --minShapes=crops:1x3x224x224 --optShapes=crops:4x3x224x224 \
                --maxShapes=crops:8x3x224x224
    Untested on device (see module docstring).
    """

    name = "trt"

    def __init__(self, engine, pad=0.2, size=224, max_batch=8):
        try:
            import pycuda.autoinit  # noqa: F401
            import pycuda.driver as cuda
            import tensorrt as trt
        except ImportError as exc:
            raise RuntimeError("TrtVerifier needs tensorrt + pycuda on the Jetson ({0}). "
                               "Use --verifier-backend onnx on a PC.".format(exc))
        self.pad, self.size, self.max_batch = pad, size, max_batch
        self._cuda = cuda
        logger = trt.Logger(trt.Logger.WARNING)
        with open(engine, "rb") as f, trt.Runtime(logger) as rt:
            self.engine = rt.deserialize_cuda_engine(f.read())
        if self.engine is None:
            raise RuntimeError("Could not load {0}; rebuild it on this device.".format(engine))
        self.context = self.engine.create_execution_context()
        self.stream = cuda.Stream()
        n_in = size * size * 3 * max_batch
        self.h_in = cuda.pagelocked_empty(n_in, np.float32)
        self.h_out = cuda.pagelocked_empty(max_batch, np.float32)
        self.d_in = cuda.mem_alloc(self.h_in.nbytes)
        self.d_out = cuda.mem_alloc(self.h_out.nbytes)

    def _logits(self, x):
        cuda = self._cuda
        out = []
        for s in range(0, len(x), self.max_batch):
            chunk = x[s:s + self.max_batch]
            n = len(chunk)
            self.context.set_binding_shape(0, (n, 3, self.size, self.size))
            np.copyto(self.h_in[:chunk.size], chunk.ravel())
            cuda.memcpy_htod_async(self.d_in, self.h_in, self.stream)
            self.context.execute_async_v2([int(self.d_in), int(self.d_out)], self.stream.handle)
            cuda.memcpy_dtoh_async(self.h_out, self.d_out, self.stream)
            self.stream.synchronize()
            out.append(self.h_out[:n].copy())
        return np.concatenate(out)


class MockVerifier(Verifier):
    """Deterministic scores for tests: fn(box) -> probability."""

    name = "mock"

    def __init__(self, fn: Optional[Callable] = None):
        self.fn = fn or (lambda box: 0.5)
        self.calls = 0

    def score(self, frame_bgr, boxes):
        self.calls += 1
        return np.array([float(self.fn(b)) for b in boxes], dtype=np.float32)


def make_verifier(kind, weights=None, engine=None, pad=0.2, size=224):
    kind = (kind or "onnx").lower()
    if kind == "onnx":
        return OnnxVerifier(weights, pad=pad, size=size)
    if kind == "trt":
        return TrtVerifier(engine, pad=pad, size=size)
    if kind == "mock":
        return MockVerifier()
    raise ValueError("Unknown verifier backend '{0}'. Use onnx, trt or mock.".format(kind))


# ----------------------------------------------------------------------------- two-stage

class VerifiedDetector(Detector):
    """Wraps any Detector with the protected stage-2 veto.

    The wrapped detector must run at conf <= c0 (make_detector sets it to c0).
    Only borderline proposals (c0 <= conf < protect) are cropped and scored, so
    the verifier's cost scales with the number of doubtful boxes, not with the
    number of detections. Kept detections carry cls_p (None when protected).
    `last_timing` holds the per-stage wall time of the most recent frame.
    """

    def __init__(self, base: Detector, verifier: Verifier, c0: float, protect: float, tau: float):
        self.base = base
        self.verifier = verifier
        self.c0 = float(c0)
        self.protect = float(protect)
        self.tau = float(tau)
        self.name = "{0}+verify-{1}".format(base.name, verifier.name)
        self.names = getattr(base, "names", None)
        self.last_timing = {"detect_ms": 0.0, "verify_ms": 0.0, "n_verified": 0, "n_vetoed": 0}

    def detect(self, frame) -> List[Detection]:
        t0 = time.perf_counter()
        props = [d for d in self.base.detect(frame) if d.confidence >= self.c0]
        t1 = time.perf_counter()
        border = [i for i, d in enumerate(props) if d.confidence < self.protect]
        probs = {}
        if border:
            scores = self.verifier.score(frame, [(props[i].x1, props[i].y1, props[i].x2, props[i].y2)
                                                 for i in border])
            probs = {i: float(p) for i, p in zip(border, scores)}
        t2 = time.perf_counter()
        out = []
        for i, d in enumerate(props):
            p = probs.get(i)
            if keep_rule(d.confidence, p, self.c0, self.protect, self.tau):
                out.append(d._replace(cls_p=p))
        self.last_timing = {"detect_ms": (t1 - t0) * 1000.0, "verify_ms": (t2 - t1) * 1000.0,
                            "n_verified": len(border), "n_vetoed": len(props) - len(out)}
        return out

    def close(self):
        self.base.close()
        self.verifier.close()
