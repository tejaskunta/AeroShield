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


def main() -> int:
    ap = argparse.ArgumentParser(description="Run SafeMine inference and save annotated images.")
    ap.add_argument("--weights", default="weights/best.pt",
                    help="Absolute or repo-relative path to the .pt checkpoint")
    ap.add_argument("--source", required=True,
                    help="Folder of images, a single image, or a video file")
    ap.add_argument("--conf", type=float, default=0.25,
                    help="Detection threshold. Lower = more recalls, higher = fewer false positives")
    ap.add_argument("--imgsz", type=int, default=640)
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

    results = model.predict(
        source=src,
        imgsz=args.imgsz,
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
