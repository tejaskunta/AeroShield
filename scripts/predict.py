#!/usr/bin/env python3
"""
SafeMine - inference sanity checker.

Run this on a few real images right after training to visually confirm
the model learned the right thing. It writes an annotated copy beside
each input; no GUI is required, so it works over SSH / SSH -X.

Usage:
    python scripts/predict.py --source datasets/unified_dataset/test/images
    python scripts/predict.py --source path/to/one/image.jpg
    python scripts/predict.py --source video_feed.mp4 --save-video
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def parse_imgsz(tokens):
    """Parse --imgsz into an int or an (h, w) list for ultralytics.

    Accepts the same forms as export_onnx.py / live_detect.py / detector.py so a
    single spelling works everywhere:
        640          -> 640
        "288 512"    -> [288, 512]   ([H W])
        "512x288"    -> [288, 512]   (WxH, flipped - models are H-first)
    """
    if isinstance(tokens, int):
        return tokens
    if not isinstance(tokens, (list, tuple)):
        tokens = [tokens]

    dims = []
    for tok in tokens:
        for part in str(tok).replace("x", " ").split():
            try:
                dims.append(int(part))
            except ValueError:
                print(f"ERROR: --imgsz must be ints, got {tokens}")
                raise SystemExit(2)

    if len(dims) == 1:
        return dims[0]
    if len(dims) == 2:
        # "512x288" is written W x H by humans; pass H, W to ultralytics.
        if "x" in "".join(str(t) for t in tokens):
            return [dims[1], dims[0]]
        return dims
    print(f"ERROR: --imgsz takes 1 or 2 ints, got {tokens}")
    raise SystemExit(2)


def main() -> int:
    ap = argparse.ArgumentParser(description="Run SafeMine inference and save annotated images.")
    ap.add_argument("--weights", default="weights/best.pt",
                    help="Absolute or repo-relative path to the .pt checkpoint or .onnx export")
    ap.add_argument("--source", required=True,
                    help="Folder of images, a single image, or a video file")
    ap.add_argument("--conf", type=float, default=0.25,
                    help="Detection threshold. Lower = more recalls, higher = fewer false positives")
    ap.add_argument("--imgsz", nargs="+", default=["640"],
                    help="640, '288 512' ([H W]) or '512x288' (WxH). Ignored for .onnx "
                         "exports built at a fixed shape - the file's shape wins.")
    ap.add_argument("--device", default="0")
    ap.add_argument("--project", default="runs/predict",
                    help="Directory to write the annotated images into")
    ap.add_argument("--name", default="safemine")
    ap.add_argument("--save-video", action="store_true",
                    help="Save the annotated video, not just a summary")
    args = ap.parse_args()

    w = Path(args.weights).expanduser()
    if not w.is_absolute():
        w = (REPO_ROOT / w).resolve()
    if not w.exists():
        print(f"ERROR: weights not found: {w}")
        print("       Train first (week3_train_yolov8.py), then copy to weights/best.pt")
        return 1

    from ultralytics import YOLO

    print(f"Loading model : {w}")
    model = YOLO(str(w))

    src = args.source
    if not Path(src).is_absolute():
        src = str((REPO_ROOT / src).resolve())

    print(f"Source        : {src}")
    print(f"Confidence    : {args.conf}")

    imgsz = parse_imgsz(args.imgsz)
    print(f"Image size    : {imgsz}")

    results = model.predict(
        source=src,
        imgsz=imgsz,
        conf=args.conf,
        device=args.device,
        project=args.project,
        name=args.name,
        save=True,
        save_txt=True,
        save_conf=True,
        line_width=2,
        show=False,
    )

    total_detections = sum(len(r.boxes) for r in results)
    out_dir = Path(args.project) / args.name
    print(f"\nProcessed {len(results)} frame(s), {total_detections} detections total.")
    print(f"Annotated outputs -> {out_dir}/")
    print(f"Label .txt files  -> {out_dir}/labels/")
    print("Open a few and check: are mines boxed, and non-mines left alone?")
    if total_detections == 0:
        print("\nZero detections. Before assuming the model is broken, retry with"
              f" --conf 0.05 — {args.conf} may just be too strict for a fresh model.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
