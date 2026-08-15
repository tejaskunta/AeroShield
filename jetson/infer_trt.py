#!/usr/bin/env python3
"""
SafeMine - TensorRT inference on the Jetson Nano.

Runs the .engine built by build_engine.sh. This is Week 4/5 code, included now
so the handoff from training is complete and testable the day the Nano is ready.

    python3 infer_trt.py --engine best.engine --source 0          # USB camera
    python3 infer_trt.py --engine best.engine --source frame.jpg  # single image

Dependencies on the Nano (JetPack 4.6):
    sudo apt-get install python3-libnvinfer python3-opencv
    pip3 install pycuda numpy

Note: this deliberately does NOT use `ultralytics`. Modern Ultralytics does not
install on JetPack 4.6's Python 3.6 / PyTorch 1.10 ceiling. Raw TensorRT +
pycuda has no such constraint, which is exactly why we export to ONNX.
"""

from __future__ import annotations

import argparse
import sys
import time

import cv2
import numpy as np

try:
    import pycuda.autoinit  # noqa: F401  (this import initialises the CUDA context)
    import pycuda.driver as cuda
    import tensorrt as trt
except ImportError as exc:
    print(f"Missing a Jetson dependency: {exc}", file=sys.stderr)
    print("  sudo apt-get install python3-libnvinfer", file=sys.stderr)
    print("  pip3 install pycuda", file=sys.stderr)
    sys.exit(1)

TRT_LOGGER = trt.Logger(trt.Logger.WARNING)


class TrtYolo:
    """Minimal TensorRT runner for a fixed-shape YOLOv8 ONNX export."""

    def __init__(self, engine_path: str):
        with open(engine_path, "rb") as f, trt.Runtime(TRT_LOGGER) as runtime:
            self.engine = runtime.deserialize_cuda_engine(f.read())
        if self.engine is None:
            raise RuntimeError(
                f"Could not load {engine_path}. An engine is tied to the exact GPU "
                "and TensorRT version that built it - rebuild it on THIS device "
                "with build_engine.sh."
            )
        self.context = self.engine.create_execution_context()
        self.stream = cuda.Stream()

        self.inputs, self.outputs, self.bindings = [], [], []
        for binding in self.engine:
            shape = self.engine.get_binding_shape(binding)
            dtype = trt.nptype(self.engine.get_binding_dtype(binding))
            size = int(np.prod(shape))
            host = cuda.pagelocked_empty(size, dtype)
            device = cuda.mem_alloc(host.nbytes)
            self.bindings.append(int(device))
            entry = {"host": host, "device": device, "shape": tuple(shape)}
            if self.engine.binding_is_input(binding):
                self.inputs.append(entry)
                self.input_shape = tuple(shape)   # (1, 3, H, W)
            else:
                self.outputs.append(entry)

        _, _, self.in_h, self.in_w = self.input_shape

    def preprocess(self, img: np.ndarray) -> tuple[np.ndarray, float, int, int]:
        """Letterbox to the engine's fixed input size, BGR->RGB, 0-1, CHW."""
        h, w = img.shape[:2]
        r = min(self.in_h / h, self.in_w / w)
        nw, nh = int(round(w * r)), int(round(h * r))
        resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)

        canvas = np.full((self.in_h, self.in_w, 3), 114, dtype=np.uint8)
        dw, dh = (self.in_w - nw) // 2, (self.in_h - nh) // 2
        canvas[dh:dh + nh, dw:dw + nw] = resized

        blob = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        blob = np.transpose(blob, (2, 0, 1))[None]     # HWC -> NCHW
        return np.ascontiguousarray(blob), r, dw, dh

    def infer(self, blob: np.ndarray) -> np.ndarray:
        np.copyto(self.inputs[0]["host"], blob.ravel())
        cuda.memcpy_htod_async(self.inputs[0]["device"], self.inputs[0]["host"], self.stream)
        self.context.execute_async_v2(bindings=self.bindings, stream_handle=self.stream.handle)
        for out in self.outputs:
            cuda.memcpy_dtoh_async(out["host"], out["device"], self.stream)
        self.stream.synchronize()
        o = self.outputs[0]
        return o["host"].reshape(o["shape"])

    def postprocess(self, raw: np.ndarray, r: float, dw: int, dh: int,
                    conf_thres: float, iou_thres: float):
        """YOLOv8 head is (1, 4+nc, N): xywh in pixels + per-class scores."""
        pred = raw[0]
        if pred.shape[0] < pred.shape[1]:
            pred = pred.T                      # (N, 4+nc)

        boxes_xywh = pred[:, :4]
        scores_all = pred[:, 4:]
        class_ids = scores_all.argmax(axis=1)
        scores = scores_all.max(axis=1)

        keep = scores > conf_thres
        if not keep.any():
            return [], [], []
        boxes_xywh, scores, class_ids = boxes_xywh[keep], scores[keep], class_ids[keep]

        # xywh (letterboxed pixels) -> xyxy in the ORIGINAL image
        cx, cy, bw, bh = boxes_xywh.T
        x1 = (cx - bw / 2 - dw) / r
        y1 = (cy - bh / 2 - dh) / r
        x2 = (cx + bw / 2 - dw) / r
        y2 = (cy + bh / 2 - dh) / r
        boxes = np.stack([x1, y1, x2 - x1, y2 - y1], axis=1)   # xywh for cv2 NMS

        idx = cv2.dnn.NMSBoxes(boxes.tolist(), scores.tolist(), conf_thres, iou_thres)
        if len(idx) == 0:
            return [], [], []
        idx = np.array(idx).flatten()
        final = boxes[idx]
        final[:, 2] += final[:, 0]   # back to xyxy
        final[:, 3] += final[:, 1]
        return final.astype(int).tolist(), scores[idx].tolist(), class_ids[idx].tolist()


def main() -> int:
    ap = argparse.ArgumentParser(description="SafeMine TensorRT inference (Jetson Nano).")
    ap.add_argument("--engine", default="best.engine")
    ap.add_argument("--source", default="0", help="'0' for camera, or a path to an image/video")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--iou", type=float, default=0.45)
    ap.add_argument("--names", nargs="*", default=None,
                    help="Class names in training order, e.g. --names metal plastic")
    ap.add_argument("--save", default=None, help="Write the annotated result here")
    ap.add_argument("--headless", action="store_true", help="Never call cv2.imshow")
    args = ap.parse_args()

    print(f"Loading engine: {args.engine}")
    model = TrtYolo(args.engine)
    print(f"Input shape   : {model.input_shape}")

    source = int(args.source) if args.source.isdigit() else args.source
    is_stream = isinstance(source, int) or str(source).lower().endswith((".mp4", ".avi", ".mov"))

    if not is_stream:
        frame = cv2.imread(str(source))
        if frame is None:
            print(f"ERROR: could not read {source}", file=sys.stderr)
            return 1
        frames = [frame]
        cap = None
    else:
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            print(f"ERROR: could not open source {source}", file=sys.stderr)
            return 1
        frames = None

    fps_ema = 0.0
    try:
        while True:
            if cap is not None:
                ok, frame = cap.read()
                if not ok:
                    break
            else:
                frame = frames.pop(0)

            t0 = time.time()
            blob, r, dw, dh = model.preprocess(frame)
            raw = model.infer(blob)
            boxes, scores, ids = model.postprocess(raw, r, dw, dh, args.conf, args.iou)
            dt = time.time() - t0
            fps_ema = 0.9 * fps_ema + 0.1 * (1.0 / dt) if fps_ema else 1.0 / dt

            for (x1, y1, x2, y2), sc, cid in zip(boxes, scores, ids):
                label = args.names[cid] if args.names and cid < len(args.names) else f"class{cid}"
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(frame, f"{label} {sc:.2f}", (x1, max(15, y1 - 6)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

            cv2.putText(frame, f"{fps_ema:.1f} FPS  {len(boxes)} det",
                        (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)

            if args.save:
                cv2.imwrite(args.save, frame)
                print(f"Saved -> {args.save}  ({len(boxes)} detections, {dt * 1000:.0f} ms)")
            if not args.headless:
                cv2.imshow("SafeMine", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
            elif cap is None:
                print(f"{len(boxes)} detections in {dt * 1000:.0f} ms")

            if cap is None and not frames:
                break
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        if cap is not None:
            cap.release()
        cv2.destroyAllWindows()

    return 0


if __name__ == "__main__":
    sys.exit(main())
