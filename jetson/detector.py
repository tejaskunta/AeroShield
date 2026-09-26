#!/usr/bin/env python3
"""
AeroShield - detector abstraction (Week 4).

One interface, three backends, so the live pipeline is identical on every machine
it has to run on:

    TrtDetector          Jetson Nano. Wraps TrtYolo from infer_trt.py.
    UltralyticsDetector  Training PC / laptop. Real .pt weights, no TensorRT.
    MockDetector         Anywhere. Synthetic boxes, no model, no GPU.

Why this exists: without it, Week 4 could not be tested until the Nano was built,
the engine compiled and the airframe wired. With it, the whole camera -> GPS ->
geotag -> uplink chain is runnable on a laptop with a webcam today, and switching
to the drone is one flag.

Usage:
    from detector import make_detector
    det = make_detector("ultralytics", weights="weights/best.pt", conf=0.25)
    for d in det.detect(frame):
        print(d.class_name, d.confidence, d.x1, d.y1, d.x2, d.y2)

PYTHON 3.6 ONLY for module scope - see the note at the top of infer_trt.py.
UltralyticsDetector imports ultralytics lazily because that package cannot be
installed on the Nano at all (jetson/README.md explains why).
"""

import math
import sys
import time
from typing import List, NamedTuple, Optional, Sequence


class Detection(NamedTuple):
    """One box from one frame. Pixels, in the ORIGINAL frame's coordinates."""

    class_id: int
    class_name: str
    confidence: float
    x1: int
    y1: int
    x2: int
    y2: int

    def centre(self):
        return (self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0


def _name_for(class_id: int, names: Optional[Sequence[str]]) -> str:
    """Resolve a class id to a label, falling back to a stable placeholder.

    A wrong --names order mislabels every detection confidently (jetson/README.md
    troubleshooting table), so we never invent a name we were not given.
    """
    if names and 0 <= class_id < len(names):
        return str(names[class_id])
    return "class{0}".format(class_id)


class Detector(object):
    """Base detector."""

    name = "base"

    def detect(self, frame) -> List[Detection]:
        raise NotImplementedError

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


class TrtDetector(Detector):
    """TensorRT on the Jetson Nano.

    Reuses TrtYolo from infer_trt.py exactly as jetson/README.md prescribes
    ("belongs in a separate module that imports TrtYolo from this file") rather
    than duplicating the pre/post-processing, which is where the subtle
    letterbox-coordinate bugs live.
    """

    name = "trt"

    def __init__(self, engine: str = "best.engine", conf: float = 0.25,
                 iou: float = 0.45, names: Optional[Sequence[str]] = None) -> None:
        try:
            from infer_trt import TrtYolo
        except ImportError as exc:
            raise RuntimeError(
                "Could not import TrtYolo from infer_trt.py ({0}).\n"
                "    This backend only works on the Jetson, and needs:\n"
                "      sudo apt-get install python3-libnvinfer python3-opencv\n"
                "      pip3 install pycuda numpy\n"
                "    On a laptop use --detector ultralytics or --detector mock.".format(exc)
            )
        self._model = TrtYolo(engine)
        self.conf = conf
        self.iou = iou
        self.names = names

    def detect(self, frame) -> List[Detection]:
        blob, r, dw, dh = self._model.preprocess(frame)
        raw = self._model.infer(blob)
        boxes, scores, ids = self._model.postprocess(raw, r, dw, dh, self.conf, self.iou)

        out = []
        for (x1, y1, x2, y2), score, cid in zip(boxes, scores, ids):
            out.append(Detection(
                class_id=int(cid),
                class_name=_name_for(int(cid), self.names),
                confidence=float(score),
                x1=int(x1), y1=int(y1), x2=int(x2), y2=int(y2),
            ))
        return out


class UltralyticsDetector(Detector):
    """Real weights on a machine that can actually run PyTorch.

    Same weights the Nano will run, just without the TensorRT conversion - so a
    detection here is a genuine model output, not a stub. This is what makes the
    Week 4 end-to-end test on a laptop meaningful.
    """

    name = "ultralytics"

    def __init__(self, weights: str = "weights/best.pt", conf: float = 0.25,
                 iou: float = 0.45, imgsz: int = 640, device: str = "cpu",
                 names: Optional[Sequence[str]] = None) -> None:
        try:
            from ultralytics import YOLO           # lazy: never importable on the Nano
        except ImportError:
            raise RuntimeError(
                "ultralytics is not installed.\n"
                "    pip install -r requirements.txt\n"
                "    Or run the pipeline with no model at all: --detector mock"
            )
        self._model = YOLO(weights)
        self.conf = conf
        self.iou = iou
        self.imgsz = imgsz
        self.device = device
        # Prefer the class names baked into the checkpoint - they are correct by
        # construction, unlike a hand-typed --names list.
        self.names = names or self._model_names()

    def _model_names(self) -> Optional[List[str]]:
        raw = getattr(self._model, "names", None)
        if isinstance(raw, dict):
            return [raw[k] for k in sorted(raw)]
        if isinstance(raw, (list, tuple)):
            return list(raw)
        return None

    def detect(self, frame) -> List[Detection]:
        results = self._model.predict(
            source=frame, conf=self.conf, iou=self.iou, imgsz=self.imgsz,
            device=self.device, verbose=False,
        )
        out = []
        for res in results:
            boxes = getattr(res, "boxes", None)
            if boxes is None:
                continue
            for box in boxes:
                x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                cid = int(box.cls[0].item())
                out.append(Detection(
                    class_id=cid,
                    class_name=_name_for(cid, self.names),
                    confidence=float(box.conf[0].item()),
                    x1=int(x1), y1=int(y1), x2=int(x2), y2=int(y2),
                ))
        return out


class MockDetector(Detector):
    """Synthetic detections. No model, no weights, no GPU.

    For proving the plumbing - GPS stamping, geotagging, uplink, retry, spool
    replay, database rows - without the model as a variable. When the mock chain
    works end to end and the real one does not, the problem is the model; when
    neither works, the problem is the plumbing. That separation is the point.

    Emits one box every `every_n` frames, drifting across the frame so successive
    detections land on different coordinates instead of stacking on one point.
    """

    name = "mock"

    def __init__(self, every_n: int = 15, confidence: float = 0.87,
                 class_id: int = 0, names: Optional[Sequence[str]] = None,
                 box_size: int = 90) -> None:
        self.every_n = max(1, every_n)
        self.confidence = confidence
        self.class_id = class_id
        self.names = names or ["landmine_metal", "landmine_plastic", "debris_negative"]
        self.box_size = box_size
        self._frame_no = 0

    def detect(self, frame) -> List[Detection]:
        self._frame_no += 1
        if self._frame_no % self.every_n != 0:
            return []

        h, w = frame.shape[:2]
        # Lissajous-ish drift so the box visits a spread of the frame, including
        # the edges where geolocation error is largest.
        t = self._frame_no / float(self.every_n)
        cx = int((0.5 + 0.35 * math.sin(t * 0.7)) * w)
        cy = int((0.5 + 0.35 * math.cos(t * 0.4)) * h)
        half = self.box_size // 2

        x1 = max(0, cx - half)
        y1 = max(0, cy - half)
        x2 = min(w - 1, cx + half)
        y2 = min(h - 1, cy + half)

        return [Detection(
            class_id=self.class_id,
            class_name=_name_for(self.class_id, self.names),
            confidence=self.confidence,
            x1=x1, y1=y1, x2=x2, y2=y2,
        )]


class OnnxDetector(Detector):
    """ONNX inference using OpenCV DNN.

    Runs on any laptop or PC with standard OpenCV, without requiring PyTorch
    or Ultralytics. Runs the exact exported best.onnx model that targets the Jetson.
    """

    name = "onnx"

    def __init__(self, weights: str = "weights/best.onnx", conf: float = 0.25,
                 iou: float = 0.45, imgsz: int = 640,
                 names: Optional[Sequence[str]] = None) -> None:
        import cv2
        try:
            self.net = cv2.dnn.readNetFromONNX(weights)
            # Optimize for CPU if possible
            self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        except Exception as exc:
            raise RuntimeError(
                "Could not load ONNX model from {0}: {1}".format(weights, exc)
            )
        # Overriding provided values with optimized ones for CPU/Nano real-time performance
        self.conf = 0.15  # Lower confidence to prioritize recall over precision
        self.iou = iou
        # MUST BE 640: YOLOv8 ONNX exports hardcode the output grid sizes (80x80 etc).
        # We cannot dynamically resize inputs for this model in OpenCV DNN.
        self.imgsz = 640
        self.names = names or ["landmine"]

    def detect(self, frame) -> List[Detection]:
        import cv2
        import numpy as np

        h, w = frame.shape[:2]
        blob = cv2.dnn.blobFromImage(frame, 1.0 / 255.0, (self.imgsz, self.imgsz), swapRB=True, crop=False)
        self.net.setInput(blob)
        raw = self.net.forward()
        if len(raw.shape) == 3:
            raw = raw[0]
        if raw.shape[0] < raw.shape[1]:
            raw = raw.T    # Shape: (num_boxes, 4 + num_classes)

        x_scale = float(w) / float(self.imgsz)
        y_scale = float(h) / float(self.imgsz)

        scores_all = raw[:, 4:]
        cids = scores_all.argmax(axis=1)
        max_scores = scores_all.max(axis=1)

        keep = max_scores >= self.conf
        if not keep.any():
            return []

        raw_keep = raw[keep]
        cids_keep = cids[keep]
        scores_keep = max_scores[keep]

        boxes = []
        scores = []
        class_ids = []

        for row, cid, score in zip(raw_keep, cids_keep, scores_keep):
            cx = row[0] * x_scale
            cy = row[1] * y_scale
            bw = row[2] * x_scale
            bh = row[3] * y_scale
            boxes.append([int(cx - bw / 2.0), int(cy - bh / 2.0), int(bw), int(bh)])
            scores.append(float(score))
            class_ids.append(int(cid))

        idx = cv2.dnn.NMSBoxes(boxes, scores, self.conf, self.iou)
        if len(idx) == 0:
            return []

        out = []
        for i in np.array(idx).flatten():
            bx, by, bw, bh = boxes[i]
            cid = class_ids[i]
            out.append(Detection(
                class_id=cid,
                class_name=_name_for(cid, self.names),
                confidence=float(scores[i]),
                x1=max(0, bx),
                y1=max(0, by),
                x2=min(w - 1, bx + bw),
                y2=min(h - 1, by + bh),
            ))
        return out


def make_detector(kind: str, **kwargs) -> Detector:
    """Factory for live_detect.py's --detector flag.

    Filters kwargs per backend so the CLI can pass one flat option bag.
    """
    kind = (kind or "mock").lower()

    if kind == "trt":
        allowed = ("engine", "conf", "iou", "names")
        return TrtDetector(**{k: v for k, v in kwargs.items() if k in allowed})

    if kind in ("onnx", "cv2"):
        allowed = ("weights", "conf", "iou", "imgsz", "names")
        return OnnxDetector(**{k: v for k, v in kwargs.items() if k in allowed})

    if kind in ("ultralytics", "yolo", "pt"):
        # Auto-fallback to OnnxDetector if weights is an .onnx file
        weights = kwargs.get("weights", "")
        if str(weights).lower().endswith(".onnx"):
            allowed = ("weights", "conf", "iou", "imgsz", "names")
            return OnnxDetector(**{k: v for k, v in kwargs.items() if k in allowed})
        allowed = ("weights", "conf", "iou", "imgsz", "device", "names")
        return UltralyticsDetector(**{k: v for k, v in kwargs.items() if k in allowed})

    if kind == "mock":
        allowed = ("every_n", "confidence", "class_id", "names", "box_size")
        return MockDetector(**{k: v for k, v in kwargs.items() if k in allowed})

    raise ValueError("Unknown detector '{0}'. Use trt, onnx, ultralytics or mock.".format(kind))


def main() -> int:
    """Smoke test a backend against a synthetic frame or a real image.

        python3 jetson/detector.py --detector mock
        python3 jetson/detector.py --detector ultralytics --weights weights/best.pt --source test.jpg
    """
    import argparse

    ap = argparse.ArgumentParser(
        description="AeroShield detector smoke test.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--detector", default="mock", choices=["trt", "ultralytics", "mock"])
    ap.add_argument("--weights", default="weights/best.pt")
    ap.add_argument("--engine", default="best.engine")
    ap.add_argument("--source", default=None, help="Image path; omitted = synthetic grey frame")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--frames", type=int, default=30)
    args = ap.parse_args()

    import numpy as np

    if args.source:
        import cv2
        frame = cv2.imread(args.source)
        if frame is None:
            print("ERROR: could not read {0}".format(args.source), file=sys.stderr)
            return 1
    else:
        frame = np.full((720, 1280, 3), 90, dtype=np.uint8)

    try:
        det = make_detector(args.detector, weights=args.weights, engine=args.engine,
                            conf=args.conf)
    except RuntimeError as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1

    print("backend: {0}   frame: {1}x{2}".format(det.name, frame.shape[1], frame.shape[0]))
    total = 0
    t0 = time.time()
    for i in range(args.frames):
        dets = det.detect(frame)
        total += len(dets)
        for d in dets:
            print("  frame {0:>3}  {1:<20} {2:.2f}  [{3},{4},{5},{6}]".format(
                i, d.class_name, d.confidence, d.x1, d.y1, d.x2, d.y2))
    dt = time.time() - t0
    print("{0} detections over {1} frames  ({2:.1f} ms/frame)".format(
        total, args.frames, dt * 1000.0 / max(1, args.frames)))
    det.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
