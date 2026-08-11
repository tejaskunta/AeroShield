#!/usr/bin/env python3
"""
SafeMine - standalone ONNX exporter.

week3_train_yolov8.py already exports at the end of training. Use this when
that step failed, or when you want to re-export an older checkpoint with
different settings.

    python scripts/export_onnx.py --weights weights/best.pt
    python scripts/export_onnx.py --weights weights/best.pt --imgsz 512 --opset 11

Why ONNX and not a .engine straight from here:
a TensorRT engine is compiled for one specific GPU architecture + TensorRT
version. An engine built on your RTX 4070 (Ada, TRT 10.x) will NOT load on the
Jetson Nano (Maxwell, TRT 8.2). ONNX is the portable intermediate; the engine
gets built on the Nano itself. See jetson/README.md.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser(description="Export a YOLOv8 .pt to ONNX for the Jetson.")
    ap.add_argument("--weights", default="weights/best.pt", help="Path to the .pt checkpoint")
    ap.add_argument("--imgsz", type=int, default=640,
                    help="MUST match what you train with and what trtexec builds")
    ap.add_argument("--opset", type=int, default=12,
                    help="12 is the safe ceiling for TensorRT 8.2 / JetPack 4.6")
    ap.add_argument("--dynamic", action="store_true",
                    help="Dynamic batch axis. Leave off for the Nano - fixed shapes are faster and safer")
    ap.add_argument("--half", action="store_true",
                    help="Export FP16 weights. Usually unnecessary - prefer trtexec --fp16 on the Nano")
    ap.add_argument("--device", default="0")
    ap.add_argument("--verify", action="store_true",
                    help="Run onnxruntime on a dummy input to prove the graph loads")
    args = ap.parse_args()

    w = Path(args.weights).expanduser()
    if not w.is_absolute():
        w = (REPO_ROOT / w).resolve()
    if not w.exists():
        print(f"ERROR: weights not found: {w}", file=sys.stderr)
        print("       Train first, or point --weights at a runs/detect/*/weights/best.pt")
        return 1

    from ultralytics import YOLO

    print(f"Loading  : {w}")
    model = YOLO(str(w))

    print(f"Exporting: onnx, imgsz={args.imgsz}, opset={args.opset}, "
          f"dynamic={args.dynamic}, half={args.half}")
    out = Path(model.export(
        format="onnx",
        imgsz=args.imgsz,
        opset=args.opset,
        simplify=True,
        dynamic=args.dynamic,
        half=args.half,
        device=args.device,
    ))
    print(f"Written  : {out}  ({out.stat().st_size / 1e6:.1f} MB)")

    if args.verify:
        print("\nVerifying the graph with onnxruntime...")
        try:
            import numpy as np
            import onnxruntime as ort

            sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
            inp = sess.get_inputs()[0]
            print(f"  input  : {inp.name} {inp.shape} {inp.type}")
            for o in sess.get_outputs():
                print(f"  output : {o.name} {o.shape}")
            dummy = np.zeros([d if isinstance(d, int) else 1 for d in inp.shape], dtype=np.float32)
            res = sess.run(None, {inp.name: dummy})
            print(f"  forward pass OK, output shape {res[0].shape}")
        except ImportError:
            print("  onnxruntime not installed - skip (pip install onnxruntime)")
        except Exception as exc:  # noqa: BLE001
            print(f"  VERIFY FAILED: {exc}")
            return 1

    dest = REPO_ROOT / "weights"
    dest.mkdir(exist_ok=True)
    if out.resolve() != (dest / "best.onnx").resolve():
        shutil.copy2(out, dest / "best.onnx")
        print(f"\nCopied to weights/best.onnx")

    print("""
Next - on the Jetson Nano:
    scp weights/best.onnx  <user>@<nano-ip>:~/safemine/
    ssh <user>@<nano-ip>
    cd ~/safemine && bash build_engine.sh best.onnx
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
