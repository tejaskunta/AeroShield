#!/usr/bin/env python3
"""
SafeMine - dataset verifier.

Catches the mistakes that otherwise show up as "mAP is 0.0 and I don't know why"
forty minutes into a training run:

  * data.yaml paths that don't resolve
  * images with no matching label file (silently treated as background by YOLO)
  * class ids outside 0..nc-1
  * coordinates not normalised to 0-1
  * zero-area or degenerate boxes
  * a class that exists in train but not in val/test
  * corrupt / unreadable images

Usage:
    python scripts/verify_dataset.py --data datasets/unified_dataset/data.yaml
    python scripts/verify_dataset.py --data ... --strict     # exit 1 on warnings too
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}

errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)
    if len(errors) <= 25:
        print(f"  ERROR  {msg}")


def warn(msg: str) -> None:
    warnings.append(msg)
    if len(warnings) <= 25:
        print(f"  WARN   {msg}")


def resolve_split(root: Path, value) -> list[Path]:
    """data.yaml split entries may be a str or a list, relative to `path`."""
    values = value if isinstance(value, list) else [value]
    out = []
    for v in values:
        p = Path(str(v))
        out.append(p if p.is_absolute() else (root / p))
    return out


def images_in(path: Path) -> list[Path]:
    """A split can point at a folder of images, a folder with images/ inside, or a .txt list."""
    if path.is_file() and path.suffix == ".txt":
        base = path.parent
        got = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                q = Path(line)
                got.append(q if q.is_absolute() else base / q)
        return got
    if not path.is_dir():
        return []
    search = path / "images" if (path / "images").is_dir() else path
    return sorted(p for p in search.rglob("*") if p.suffix.lower() in IMG_EXT)


def label_for(img: Path) -> Path:
    """YOLO's convention: swap the last 'images' path segment for 'labels'."""
    parts = list(img.parts)
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "images":
            parts[i] = "labels"
            break
    return Path(*parts).with_suffix(".txt")


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify a YOLO-format dataset.")
    ap.add_argument("--data", required=True, help="Path to data.yaml")
    ap.add_argument("--imgsz", type=int, default=640,
                    help="Planned training size, used for the tiny-box warning")
    ap.add_argument("--strict", action="store_true", help="Treat warnings as failures")
    ap.add_argument("--no-image-check", action="store_true",
                    help="Skip opening every image (much faster on big datasets)")
    args = ap.parse_args()

    try:
        import yaml
    except ImportError:
        print("PyYAML is required:  pip install pyyaml")
        return 1

    # Import Pillow once, up front. Importing it inside the per-image loop means
    # a missing Pillow gets caught by the per-image `except` and every single
    # image is falsely reported as corrupt.
    check_images = not args.no_image_check
    if check_images:
        try:
            from PIL import Image
        except ImportError:
            print("NOTE: Pillow not installed - skipping the corrupt-image check.")
            print("      pip install Pillow    (to enable it)\n")
            check_images = False

    data_yaml = Path(args.data).expanduser().resolve()
    if not data_yaml.exists():
        print(f"data.yaml not found: {data_yaml}")
        return 1

    cfg = yaml.safe_load(data_yaml.read_text(encoding="utf-8")) or {}

    print("=" * 70)
    print(f"Verifying {data_yaml}")
    print("=" * 70)

    # --- classes ----------------------------------------------------------
    names = cfg.get("names")
    if isinstance(names, dict):
        names = [names[k] for k in sorted(names)]
    if not names:
        err("data.yaml has no 'names' list")
        names = []
    nc = cfg.get("nc", len(names))
    if names and nc != len(names):
        err(f"nc={nc} but names has {len(names)} entries - these must match")
    print(f"\nclasses ({len(names)}): {', '.join(map(str, names)) or '(none)'}")

    # --- root -------------------------------------------------------------
    root = Path(str(cfg.get("path", data_yaml.parent)))
    if not root.is_absolute():
        root = (data_yaml.parent / root).resolve()
    print(f"dataset root   : {root}")
    if not root.exists():
        err(f"'path' in data.yaml does not exist: {root}")

    per_split_classes: dict[str, Counter] = {}
    totals: dict[str, dict[str, int]] = {}

    for split in ("train", "val", "test"):
        if split not in cfg:
            (warn if split == "test" else err)(f"data.yaml has no '{split}' key")
            continue

        print(f"\n--- {split} " + "-" * 55)
        imgs: list[Path] = []
        for d in resolve_split(root, cfg[split]):
            if not d.exists():
                err(f"{split}: path does not exist: {d}")
                continue
            imgs.extend(images_in(d))

        if not imgs:
            err(f"{split}: found 0 images")
            continue

        counts = Counter()
        n_boxes = n_missing = n_empty = n_corrupt = 0
        tiny = 0

        for img in imgs:
            if check_images:
                try:
                    with Image.open(img) as im:
                        im.verify()
                except Exception:  # noqa: BLE001
                    n_corrupt += 1
                    err(f"{split}: unreadable image {img.name}")
                    continue

            lbl = label_for(img)
            if not lbl.exists():
                n_missing += 1
                continue

            lines = [ln.strip() for ln in lbl.read_text(encoding="utf-8").splitlines() if ln.strip()]
            if not lines:
                n_empty += 1
                continue

            for lineno, ln in enumerate(lines, 1):
                bits = ln.split()
                # 5 fields = detection. More = segmentation polygon, which
                # trains fine as boxes but is worth knowing about.
                if len(bits) < 5:
                    err(f"{split}: {lbl.name}:{lineno} has {len(bits)} fields, expected 5")
                    continue
                if len(bits) > 5 and (len(bits) - 1) % 2 == 0:
                    warn(f"{split}: {lbl.name}:{lineno} looks like a segmentation polygon")
                try:
                    cid = int(float(bits[0]))
                    x, y, w, h = (float(v) for v in bits[1:5])
                except ValueError:
                    err(f"{split}: {lbl.name}:{lineno} non-numeric values")
                    continue

                if names and not (0 <= cid < len(names)):
                    err(f"{split}: {lbl.name}:{lineno} class id {cid} outside 0..{len(names) - 1}")
                if not all(-1e-6 <= v <= 1 + 1e-6 for v in (x, y, w, h)):
                    err(f"{split}: {lbl.name}:{lineno} coords not normalised 0-1 -> {x} {y} {w} {h}")
                if w <= 0 or h <= 0:
                    err(f"{split}: {lbl.name}:{lineno} zero/negative box size")
                elif min(w, h) * args.imgsz < 4:
                    tiny += 1

                counts[cid] += 1
                n_boxes += 1

        per_split_classes[split] = counts
        totals[split] = {"images": len(imgs), "boxes": n_boxes,
                         "missing_labels": n_missing, "empty_labels": n_empty}

        print(f"  images           : {len(imgs)}")
        print(f"  boxes            : {n_boxes}")
        print(f"  missing label    : {n_missing}")
        print(f"  empty label      : {n_empty}  (treated as background images)")
        if n_corrupt:
            print(f"  corrupt images   : {n_corrupt}")
        if tiny:
            warn(f"{split}: {tiny} boxes are under 4px at imgsz={args.imgsz} - "
                 "likely unlearnable; consider a larger imgsz or dropping them")

        if n_missing:
            frac = n_missing / len(imgs)
            msg = (f"{split}: {n_missing}/{len(imgs)} images ({frac:.0%}) have no label file. "
                   "YOLO reads these as 'contains nothing'. If they are actually "
                   "un-annotated, they are teaching the model to miss mines.")
            (err if frac > 0.10 else warn)(msg)

        if names and counts:
            print("  per class:")
            width = max(len(str(n)) for n in names)
            for i, cname in enumerate(names):
                bar = "#" * min(40, counts[i] * 40 // max(1, max(counts.values())))
                print(f"    {str(cname):<{width}}  {counts[i]:>6}  {bar}")

    # --- cross-split sanity ----------------------------------------------
    print("\n--- cross-split " + "-" * 47)
    if "train" in per_split_classes and names:
        train_c = per_split_classes["train"]
        for i, cname in enumerate(names):
            if train_c[i] == 0:
                err(f"class '{cname}' has 0 boxes in train - it can never be learned")
            elif train_c[i] < 20:
                warn(f"class '{cname}' has only {train_c[i]} training boxes")
            for split in ("val", "test"):
                if split in per_split_classes and per_split_classes[split][i] == 0:
                    warn(f"class '{cname}' has 0 boxes in {split} - its metrics will read 0")

    print("  split sizes: " + (", ".join(
        f"{s}={t['images']}" for s, t in totals.items()) or "(none)"))

    # --- verdict ----------------------------------------------------------
    print("\n" + "=" * 70)
    if len(errors) > 25:
        print(f"({len(errors) - 25} further errors suppressed)")
    if len(warnings) > 25:
        print(f"({len(warnings) - 25} further warnings suppressed)")
    print(f"RESULT: {len(errors)} error(s), {len(warnings)} warning(s)")
    if errors:
        print("Fix the errors before training - they will waste a full run.")
        return 1
    if warnings and args.strict:
        print("--strict: failing on warnings.")
        return 1
    print("Dataset looks trainable.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
