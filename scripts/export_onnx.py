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
    ap.add_argument("--imgsz", nargs="+", default=["640"],
                    help="Export size: '640' for square, '288 512' ([H W]) or "
                         "'512x288' (WxH) for rectangular. The Jetson pick is "
                         "512x288 landscape (exact 16:9, ~36%% of 640x640 "
                         "pixels), no retrain needed (v8 is fully convolutional).")
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

    # Accept '640', '288 512' ([H W]), or '512x288' (WxH, flipped to [H W]).
    # Ultralytics export takes [h, w]; landscape 512x288 -> [288, 512].
    # Both 288 and 512 are multiples of the 32px stride, so no padding surprise.
    raw = []
    flip_wh = False
    for tok in args.imgsz:
        s = str(tok).lower()
        if "x" in s:
            flip_wh = True
            s = s.replace("x", " ")
        raw.extend(s.split())
    try:
        dims = [int(v) for v in raw]
    except ValueError:
        print(f"ERROR: --imgsz must be ints, got {args.imgsz}", file=sys.stderr)
        return 1
    if len(dims) == 1:
        imgsz = dims[0]
    elif len(dims) == 2:
        if flip_wh:
            dims = [dims[1], dims[0]]
        imgsz = dims  # [h, w], e.g. [288, 512] for 512x288 landscape
    else:
        print(f"ERROR: --imgsz takes 1 or 2 ints, got {args.imgsz}", file=sys.stderr)
        return 1

    print(f"Exporting: onnx, imgsz={imgsz}, opset={args.opset}, "
          f"dynamic={args.dynamic}, half={args.half}")

    # ultralytics names its ONNX after the .pt file, so exporting at ANY size
    # writes weights/best.onnx - silently destroying a baseline exported at a
    # different size. Save whatever is already there before we touch it.
    canonical = REPO_ROOT / "weights" / "best.onnx"
    if canonical.exists():
        try:
            import onnx as _onnx

            want = [1, 3, imgsz, imgsz] if isinstance(imgsz, int) else [1, 3] + list(imgsz)
            _in = _onnx.load(str(canonical)).graph.input[0]
            have = [d.dim_value for d in _in.type.tensor_type.shape.dim]

            if len(have) == 4 and have != want:
                # Filename reports the shape the way humans write it: WxH.
                tag = f"{have[3]}x{have[2]}"
                backup = canonical.parent / f"best_{tag}.onnx"
                if not backup.exists():
                    shutil.copy2(canonical, backup)
                    print(f"Backed up existing {tag} baseline -> weights/{backup.name}")
        except Exception as exc:  # noqa: BLE001
            print(f"WARNING: could not inspect existing weights/best.onnx ({exc})")

    out = Path(model.export(
        format="onnx",
        imgsz=imgsz,
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

    # Name the artifact after its shape so a rect export cannot silently
    # overwrite the 640 baseline that the current engine was built from.
    #   640        -> best_640.onnx
    #   [288, 512] -> best_512x288.onnx   (filename is WxH, like the user sees)
    if isinstance(imgsz, (list, tuple)):
        tag = "{0}x{1}".format(imgsz[1], imgsz[0])
    else:
        tag = str(imgsz)
    target = dest / ("best_{0}.onnx".format(tag))

    if out.resolve() != target.resolve():
        if target.exists():
            print(f"\nNOTE: overwriting existing {target.name}")
        shutil.copy2(out, target)
        print(f"\nCopied to weights/{target.name}")

    # Keep weights/best.onnx pointing at the 640 export, since that is what
    # build_engine.sh builds by default and what the CMake/docs reference.
    if tag == "640" and out.resolve() != (dest / "best.onnx").resolve():
        shutil.copy2(out, dest / "best.onnx")
        print("Copied to weights/best.onnx (640 baseline)")

    print("""
Next - on the Jetson Nano:
    scp weights/{0}  <user>@<nano-ip>:~/aeroshield/weights/
    ssh <user>@<nano-ip>
    cd ~/aeroshield && bash build_engine.sh weights/{0}
""".format(target.name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
