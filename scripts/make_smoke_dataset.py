#!/usr/bin/env python3
"""
SafeMine - smoke test dataset generator.

Creates a minimal synthetic dataset with two classes (metal, plastic) so you
can test the full train > validate > export pipeline end-to-end without
real images. Takes ~30 seconds to create; trains in ~2 minutes at 3 epochs.

Usage:
    python scripts/make_smoke_dataset.py
    python week3_train_yolov8.py --data datasets/smoke_test/data.yaml --epochs 3
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT = REPO_ROOT / "datasets" / "smoke_test"

NAMES = ["metal", "random_plastic_debris"]
NUM_TRAIN = 60
NUM_VAL = 20
NUM_TEST = 20
IMG_SZ = 200
MAX_BOXES = 3


def main() -> int:
    try:
        import numpy as np
        from PIL import Image, ImageDraw
    except ImportError as exc:
        print(f"Missing a dependency ({exc.name}). Install the requirements first:")
        print("    pip install -r requirements.txt")
        return 1

    rng = random.Random(42)
    np_rng = np.random.default_rng(42)

    for split, n in [("train", NUM_TRAIN), ("val", NUM_VAL), ("test", NUM_TEST)]:
        img_dir = OUT / split / "images"
        lbl_dir = OUT / split / "labels"
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        for i in range(n):
            arr = np_rng.integers(40, 220, (IMG_SZ, IMG_SZ, 3), dtype=np.uint8)
            img = Image.fromarray(arr)
            draw = ImageDraw.Draw(img)

            lines = []
            n_boxes = rng.randint(1, MAX_BOXES)
            for _ in range(n_boxes):
                cx = rng.uniform(0.15, 0.85)
                cy = rng.uniform(0.15, 0.85)
                bw = rng.uniform(0.08, 0.25)
                bh = rng.uniform(0.08, 0.25)
                cid = rng.randint(0, len(NAMES) - 1)
                color = [0, 200, 0] if cid == 0 else [200, 0, 0]

                x1, y1 = (cx - bw / 2) * IMG_SZ, (cy - bh / 2) * IMG_SZ
                x2, y2 = (cx + bw / 2) * IMG_SZ, (cy + bh / 2) * IMG_SZ
                draw.rectangle([x1, y1, x2, y2], fill=color, outline="white", width=2)

                lines.append(f"{cid} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")

            (img_dir / f"smoke_{i:04d}.png").save(img)
            (lbl_dir / f"smoke_{i:04d}.txt").write_text("\n".join(lines) + "\n")

        print(f"  {split:5}: {n} images -> {img_dir}")

    # Absolute `path` on purpose: Ultralytics resolves a *relative* path against
    # its own settings datasets_dir, not against this file, which is a classic
    # "images not found" trap. Absolute always works.
    (OUT / "data.yaml").write_text(
        f"path: {OUT.as_posix()}\n"
        "train: train/images\n"
        "val: val/images\n"
        "test: test/images\n"
        f"nc: {len(NAMES)}\n"
        f"names: {NAMES}\n"
    )
    print(f"\n  data.yaml -> {OUT / 'data.yaml'}")
    print("\nSmoke dataset ready. Try:")
    print(f"  python scripts/verify_dataset.py --data {OUT / 'data.yaml'}")
    print(f"  python week3_train_yolov8.py --data {OUT / 'data.yaml'} --epochs 3")
    return 0


if __name__ == "__main__":
    sys.exit(main())
