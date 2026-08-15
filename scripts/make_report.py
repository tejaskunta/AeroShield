#!/usr/bin/env python3
"""
SafeMine - PDF report generator.

Assembles training artifacts (curves, confusion matrix, validation predictions,
sample augmentations) into a single multi-page PDF with a cover page.

Usage:
    python scripts/make_report.py
    python scripts/make_report.py --run landmine_yolov8m_75ep
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def build_pdf(run_name: str, output_path: Path) -> None:
    from matplotlib.backends.backend_pdf import PdfPages
    from PIL import Image
    import matplotlib.pyplot as plt

    run_dir = REPO_ROOT / "runs" / "detect" / run_name
    if not run_dir.exists():
        run_dir = REPO_ROOT / "runs" / "detect" / "runs" / "detect" / run_name
    if not run_dir.exists():
        print(f"ERROR: run directory not found for '{run_name}'", file=sys.stderr)
        search_roots = [
            REPO_ROOT / "runs" / "detect",
            REPO_ROOT / "runs" / "detect" / "runs" / "detect",
        ]
        for root in search_roots:
            if root.exists():
                print(f"  Available in {root}:")
                for d in sorted(root.iterdir()):
                    if d.is_dir():
                        print(f"    {d.name}")
        sys.exit(1)

    summary_path = run_dir / "safemine_summary.json"
    summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}

    _parent = run_dir.parent
    run_dir_val = _parent / f"{run_name}_val"
    run_dir_test = _parent / f"{run_name}_test"

    image_specs = [
        (run_dir / "results.png", "Training Curves"),
        (run_dir / "confusion_matrix_normalized.png", "Confusion Matrix (Normalized)"),
        (run_dir / "BoxPR_curve.png", "Precision-Recall Curve"),
        (run_dir / "BoxP_curve.png", "Precision Curve"),
        (run_dir / "BoxR_curve.png", "Recall Curve"),
        (run_dir / "BoxF1_curve.png", "F1 Curve"),
        (run_dir_val / "val_batch0_labels.jpg", "Validation Ground Truth (batch 0)"),
        (run_dir_val / "val_batch0_pred.jpg", "Validation Predictions (batch 0)"),
        (run_dir_val / "val_batch1_labels.jpg", "Validation Ground Truth (batch 1)"),
        (run_dir_val / "val_batch1_pred.jpg", "Validation Predictions (batch 1)"),
        (run_dir_test / "val_batch0_labels.jpg", "Test Ground Truth (batch 0)"),
        (run_dir_test / "val_batch0_pred.jpg", "Test Predictions (batch 0)"),
        (run_dir_test / "val_batch1_labels.jpg", "Test Ground Truth (batch 1)"),
        (run_dir_test / "val_batch1_pred.jpg", "Test Predictions (batch 1)"),
        (run_dir / "train_batch0.jpg", "Training Augmentation Sample"),
    ]

    metrics = summary.get("metrics", {})
    val_m = metrics.get("val", {})
    test_m = metrics.get("test", {})

    fig = plt.figure(figsize=(8.5, 11))
    fig.patch.set_facecolor("white")
    plt.subplots_adjust(left=0.08, right=0.95, top=0.92, bottom=0.06)

    fig.text(0.5, 0.96, "SafeMine — Landmine Detection Model",
             ha="center", va="top", fontsize=20, fontweight="bold")

    fig.text(0.5, 0.91, "YOLOv8m Training Report",
             ha="center", va="top", fontsize=13, color="#555555")

    y = 0.82
    fig.text(0.08, y, "Training Configuration", ha="left", va="top",
             fontsize=11, fontweight="bold")
    y -= 0.03
    config_lines = [
        f"Model:           {summary.get('base_model', 'yolov8m.pt')}",
        f"Epochs:          {summary.get('epochs', 75)}",
        f"Image size:      {summary.get('imgsz', 640)} px",
        f"Batch size:      {summary.get('batch', 8)}",
        f"Training time:   {summary.get('train_time_human', 'unknown')}",
        f"Random seed:     0",
    ]
    for line in config_lines:
        fig.text(0.10, y, line, ha="left", va="top", fontsize=9, fontfamily="monospace")
        y -= 0.025

    y -= 0.02
    fig.text(0.08, y, "Hardware", ha="left", va="top",
             fontsize=11, fontweight="bold")
    y -= 0.03
    hw_lines = [
        "GPU:             NVIDIA GeForce RTX 4070 Laptop GPU",
        "VRAM:            8 GB",
        "PyTorch:         2.6.0+cu124",
        "Ultralytics:     8.4.117",
        "CUDA:            12.4",
    ]
    for line in hw_lines:
        fig.text(0.10, y, line, ha="left", va="top", fontsize=9, fontfamily="monospace")
        y -= 0.025

    y -= 0.02
    fig.text(0.08, y, "Dataset", ha="left", va="top",
             fontsize=11, fontweight="bold")
    y -= 0.03
    ds_lines = [
        "Path:            landmine_combined (C:/Users/Delta/Downloads/...)",
        "Train images:    5,723",
        "Val images:      455",
        "Test images:     221",
        "Classes:         1 (Landmine)",
        "Image size:      640x640 RGB",
    ]
    for line in ds_lines:
        fig.text(0.10, y, line, ha="left", va="top", fontsize=9, fontfamily="monospace")
        y -= 0.025

    y -= 0.03
    fig.text(0.08, y, "Final Metrics", ha="left", va="top",
             fontsize=11, fontweight="bold")
    y -= 0.025

    cell_text = [
        ["Metric", "Validation", "Test"],
        ["Precision", f"{val_m.get('precision', 0):.4f}", f"{test_m.get('precision', 0):.4f}"],
        ["Recall", f"{val_m.get('recall', 0):.4f}", f"{test_m.get('recall', 0):.4f}"],
        ["mAP@50", f"{val_m.get('mAP50', 0):.4f}", f"{test_m.get('mAP50', 0):.4f}"],
        ["mAP@50-95", f"{val_m.get('mAP50-95', 0):.4f}", f"{test_m.get('mAP50-95', 0):.4f}"],
    ]
    ax_table = fig.add_axes([0.01, 0.03, 0.87, 0.13])
    ax_table.axis("off")
    table = ax_table.table(cell_text, cellLoc="center", loc="upper center")
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1, 1.8)
    for (r, c), cell in table.get_celld().items():
        if r == 0:
            cell.set_facecolor("#333333")
            cell.set_text_props(color="white", fontweight="bold", fontsize=9)
        else:
            cell.set_facecolor("#f0f0f0" if r % 2 == 0 else "#ffffff")
            cell.set_text_props(fontsize=9)

    fig.text(0.08, 0.03, "Note: a missed mine is a safety failure, a false positive is an annoyance.",
             ha="left", va="top", fontsize=8, style="italic", color="#666666")

    with PdfPages(output_path) as pdf:
        pdf.savefig(fig)
        plt.close(fig)

        missing = []
        for img_path, label in image_specs:
            if not img_path.exists():
                missing.append(str(img_path))
                continue
            img = Image.open(img_path)
            dpi = 100
            w, h = img.size
            target_w, target_h = 8.5, 11
            iw, ih = w / dpi, h / dpi
            if iw > target_w:
                scale = target_w / iw
            elif ih > target_h:
                scale = target_h / ih
            else:
                scale = min(target_w / iw, target_h / ih)
            new_w, new_h = iw * scale, ih * scale
            fig = plt.figure(figsize=(new_w, new_h))
            fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
            plt.imshow(img)
            plt.axis("off")
            for ax in fig.axes:
                ax.axis("off")
            fig.text(0.5, 0.005, label, ha="center", va="bottom",
                     fontsize=10, fontweight="bold",
                     bbox=dict(boxstyle="round,pad=0.3", facecolor="white", alpha=0.8))
            pdf.savefig(fig)
            plt.close(fig)

        if missing:
            print("WARNING: these files were not found:", file=sys.stderr)
            for m in missing:
                print(f"  {m}", file=sys.stderr)
            print(f"\nIncluded {len(image_specs) - len(missing)} of {len(image_specs)} image pages.", file=sys.stderr)

    print(f"PDF written to: {output_path}")
    print(f"  Pages: cover + {len(image_specs)} images ({len(image_specs) - len(missing)} included, {len(missing)} missing)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate a PDF report from SafeMine YOLOv8 training artifacts.")
    ap.add_argument("--run", default="landmine_yolov8m_75ep",
                    help="Run directory name under runs/detect/")
    ap.add_argument("--output", default="safemine_report.pdf",
                    help="Output PDF path (relative to repo root)")
    args = ap.parse_args()

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = REPO_ROOT / output_path

    build_pdf(args.run, output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
