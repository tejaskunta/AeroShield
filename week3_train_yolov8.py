#!/usr/bin/env python3
"""
SafeMine - Week 3: YOLOv8 training pipeline.

Train -> validate -> export to ONNX, in one run.

    Training PC        : RTX 4070 Laptop, 8 GB VRAM (device=0)
    Deployment target  : Jetson Nano P3450 4 GB, JetPack 4.6 / TensorRT 8.2

Quick start:
    python week3_train_yolov8.py --data datasets/unified_dataset/data.yaml

Everything has a sensible default, so this also works once DATA_YAML is set:
    python week3_train_yolov8.py

Artifacts land in:
    runs/detect/<run-name>/weights/best.pt      trained weights
    runs/detect/<run-name>/weights/best.onnx    ONNX for the Jetson
    runs/detect/<run-name>_val/                 validation report + curves
    weights/                                    stable copies of the above
"""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------
# TODO: >>> PUT YOUR REAL PATH HERE <<<
# This must point at the data.yaml produced by the Week 2 pipeline (step 04 -
# Split). It is the file listing your train/val/test folders and class names.
# You can also override it at runtime with:  --data path/to/data.yaml
#
# Windows note: use forward slashes ("C:/Users/you/...") or a raw string
# (r"C:\Users\you\..."). A plain backslash string will break.
DATA_YAML = "datasets/unified_dataset/data.yaml"

# 'yolov8s.pt' = the "small" model. It trains comfortably on an 8 GB RTX 4070
# and is still light enough to run on the Jetson Nano after TensorRT conversion.
# Downloaded automatically on first run (needs internet once).
# If the Nano turns out too slow, retrain with 'yolov8n.pt' - same script.
BASE_MODEL = "yolov8s.pt"

REPO_ROOT = Path(__file__).resolve().parent
WEIGHTS_DIR = REPO_ROOT / "weights"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def banner(step: str, text: str) -> None:
    """Print a loud, greppable step header."""
    print("\n" + "=" * 78)
    print(f"[{step}] {text}")
    print("=" * 78, flush=True)


def info(text: str) -> None:
    print(f"    {text}", flush=True)


def fail(text: str) -> None:
    print(f"\n!! ERROR: {text}\n", file=sys.stderr, flush=True)
    sys.exit(1)


def human_time(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m {s:02d}s" if h else f"{m}m {s:02d}s"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="SafeMine Week 3 - train, validate and export YOLOv8.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--data", default=DATA_YAML,
                   help="Path to your dataset's data.yaml")
    p.add_argument("--model", default=BASE_MODEL,
                   help="Starting checkpoint (yolov8n/s/m.pt) or a .yaml to train from scratch")
    p.add_argument("--epochs", type=int, default=50)
    p.add_argument("--imgsz", type=int, default=640,
                   help="Training image size. Keep 640 - the Jetson engine is built at this size")
    p.add_argument("--batch", type=int, default=16,
                   help="Batch size. 16 fits 8 GB VRAM for yolov8s@640. Use -1 for auto, or 8 on OOM")
    p.add_argument("--device", default="0",
                   help="'0' = first NVIDIA GPU, 'cpu' to force CPU (very slow)")
    p.add_argument("--workers", type=int, default=None,
                   help="Dataloader workers (default: 4 on Windows, 8 elsewhere)")
    p.add_argument("--patience", type=int, default=20,
                   help="Early-stop after N epochs with no val improvement. 0 disables it")
    p.add_argument("--name", default=None,
                   help="Run name under runs/detect/ (default: safemine_<timestamp>)")
    p.add_argument("--conf", type=float, default=0.25,
                   help="Validation confidence threshold. Lower = higher recall (see README)")
    p.add_argument("--opset", type=int, default=12,
                   help="ONNX opset. 12 is the safe ceiling for TensorRT 8.2 on JetPack 4.6")
    p.add_argument("--cache", default="False", choices=["False", "ram", "disk"],
                   help="Cache images for speed. 'ram' is fastest but needs free system RAM")
    p.add_argument("--resume", action="store_true",
                   help="Resume the run named by --name from its last.pt")
    p.add_argument("--no-export", action="store_true",
                   help="Skip the ONNX export step")
    p.add_argument("--seed", type=int, default=0)
    return p.parse_args()


def preflight(args: argparse.Namespace) -> Path:
    """Fail fast and loudly, before we burn an hour of GPU time."""
    banner("0/5", "Pre-flight checks")

    data_path = Path(args.data).expanduser()
    if not data_path.is_absolute():
        data_path = (REPO_ROOT / data_path).resolve()

    info(f"Python           : {platform.python_version()} ({platform.system()})")

    try:
        import torch
    except ImportError:
        fail("PyTorch is not installed. See README section 'Install (do this in order)'.")
        return data_path  # unreachable, keeps linters happy

    from ultralytics import __version__ as ultra_version

    info(f"PyTorch          : {torch.__version__}")
    info(f"Ultralytics      : {ultra_version}")

    if args.device != "cpu":
        if not torch.cuda.is_available():
            fail(
                "CUDA is NOT available, so --device 0 cannot work.\n"
                "   This almost always means pip installed the CPU-only build of torch.\n"
                "   Fix: pip uninstall -y torch torchvision\n"
                "        pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124\n"
                "   Or train on CPU anyway (hours, not minutes) with:  --device cpu"
            )
        idx = int(args.device.split(",")[0])
        props = torch.cuda.get_device_properties(idx)
        vram_gb = props.total_memory / (1024 ** 3)
        info(f"CUDA runtime     : {torch.version.cuda}")
        info(f"GPU              : {props.name} ({vram_gb:.1f} GB VRAM, sm_{props.major}{props.minor})")
        if vram_gb < 7.0 and args.batch >= 16:
            info("NOTE: <7 GB VRAM with batch=16. If you hit OOM, rerun with --batch 8.")
    else:
        info("GPU              : disabled (--device cpu)")

    if not data_path.exists():
        fail(
            f"data.yaml not found at:\n     {data_path}\n"
            "   Edit DATA_YAML at the top of this script, or pass --data <path>.\n"
            "   No dataset yet? Generate a fake one to test the pipeline end-to-end:\n"
            "        python scripts/make_smoke_dataset.py"
        )
    info(f"Dataset config   : {data_path}")

    # Surface the class list now - a wrong `nc` is the most common silent failure.
    try:
        import yaml
        with open(data_path, "r", encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh) or {}
        names = cfg.get("names")
        if isinstance(names, dict):
            names = [names[k] for k in sorted(names)]
        if names:
            info(f"Classes ({len(names)})      : {', '.join(map(str, names))}")
        else:
            info("WARNING: no 'names' key in data.yaml - training will likely fail.")
    except Exception as exc:  # noqa: BLE001 - informational only
        info(f"(could not parse data.yaml for a class preview: {exc})")

    return data_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    args = parse_args()
    data_path = preflight(args)

    from ultralytics import YOLO

    run_name = args.name or f"safemine_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    workers = args.workers if args.workers is not None else (4 if platform.system() == "Windows" else 8)
    cache = False if args.cache == "False" else args.cache

    # -- 1/5  LOAD ----------------------------------------------------------
    banner("1/5", f"Loading base model: {args.model}")
    info("First run downloads the checkpoint (~22 MB for yolov8s) - needs internet once.")
    model = YOLO(args.model)
    info("Model loaded.")

    # -- 2/5  TRAIN ---------------------------------------------------------
    banner("2/5", f"Training - {args.epochs} epochs @ {args.imgsz}px, batch {args.batch}, device {args.device}")
    info(f"Run name         : {run_name}")
    info(f"Early stopping   : {'off' if args.patience == 0 else f'patience={args.patience} epochs'}")
    info("Live metrics stream below. Ctrl-C is safe - last.pt is written every epoch.")
    info("")

    start = time.time()
    try:
        results = model.train(
            data=str(data_path),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            device=args.device,
            workers=workers,
            patience=args.patience,
            cache=cache,
            seed=args.seed,
            name=run_name,
            project="runs/detect",
            resume=args.resume,
            plots=True,      # writes confusion matrix + PR/F1 curves for the report
            val=True,
            exist_ok=args.resume,
        )
    except KeyboardInterrupt:
        fail("Interrupted. Resume with:  python week3_train_yolov8.py "
             f"--name {run_name} --resume")
        return
    except Exception as exc:  # noqa: BLE001
        if "out of memory" in str(exc).lower():
            fail(
                "CUDA out of memory.\n"
                "   Fixes, in order of preference:\n"
                "     1) --batch 8       (halve the batch)\n"
                "     2) --batch -1      (let Ultralytics auto-size it)\n"
                "     3) --imgsz 512     (last resort - rebuild the Jetson engine at 512 too)\n"
                "   Also close Chrome/games; they hold onto VRAM."
            )
        raise

    elapsed = time.time() - start

    # Ultralytics auto-increments the run folder (train, train2, train3...), so
    # never hardcode 'runs/detect/train'. Read the real path off the result.
    save_dir = Path(results.save_dir)
    best_pt = save_dir / "weights" / "best.pt"
    if not best_pt.exists():
        fail(f"Training finished but best.pt is missing at {best_pt}")
        return

    info("")
    info(f"Training done in {human_time(elapsed)}")
    info(f"Best weights     : {best_pt}")
    info(f"Curves + logs    : {save_dir}")

    # -- 3/5  VALIDATE ------------------------------------------------------
    banner("3/5", "Validating the best checkpoint")
    best_model = YOLO(str(best_pt))

    metrics_summary: dict[str, dict[str, float]] = {}
    for split in ("val", "test"):
        info(f"--- split: {split} ---")
        try:
            m = best_model.val(
                data=str(data_path),
                split=split,
                imgsz=args.imgsz,
                batch=args.batch,
                device=args.device,
                conf=args.conf,
                plots=True,
                name=f"{run_name}_{split}",
                project="runs/detect",
            )
        except Exception as exc:  # noqa: BLE001
            # A missing `test:` key in data.yaml is normal and not fatal.
            info(f"skipped ({exc.__class__.__name__}: {exc})")
            continue

        box = m.box
        metrics_summary[split] = {
            "precision": float(box.mp),
            "recall": float(box.mr),
            "mAP50": float(box.map50),
            "mAP50-95": float(box.map),
        }
        info(f"precision  {box.mp:.4f}")
        info(f"recall     {box.mr:.4f}   <-- SafeMine optimises for this")
        info(f"mAP@50     {box.map50:.4f}")
        info(f"mAP@50-95  {box.map:.4f}")

    if metrics_summary:
        info("")
        info("Reminder: a missed mine is a safety failure, a false positive is an")
        info("annoyance. If recall is low, lower --conf and re-run validation before")
        info("you reach for more epochs.")

    # -- 4/5  EXPORT --------------------------------------------------------
    onnx_path: Path | None = None
    if args.no_export:
        banner("4/5", "ONNX export skipped (--no-export)")
    else:
        banner("4/5", f"Exporting to ONNX (opset {args.opset}, fixed {args.imgsz}x{args.imgsz})")
        # This ONNX file is the bridge to the drone. It is NOT the final artifact.
        # On the Jetson Nano we convert it into a TensorRT .engine with trtexec:
        #
        #   /usr/src/tensorrt/bin/trtexec \
        #       --onnx=best.onnx --saveEngine=best.engine --fp16 --workspace=2048
        #
        # We export from the PC (which has the full PyTorch/ONNX toolchain) but
        # build the engine ON the Nano, because a TensorRT engine is tied to the
        # exact GPU + TensorRT version that built it - an engine built here would
        # simply refuse to load there. See jetson/README.md.
        #
        # dynamic=False and simplify=True keep the graph inside the narrow subset
        # of ops that TensorRT 8.2 (JetPack 4.6, the final release for the P3450)
        # actually supports.
        try:
            exported = best_model.export(
                format="onnx",
                imgsz=args.imgsz,
                opset=args.opset,
                simplify=True,
                dynamic=False,
                half=False,   # keep FP32 in the ONNX; ask trtexec for --fp16 on the Nano
                device=args.device,
            )
            onnx_path = Path(exported)
            info(f"ONNX written     : {onnx_path}")
            info(f"Size             : {onnx_path.stat().st_size / 1e6:.1f} MB")
        except Exception as exc:  # noqa: BLE001
            info(f"Export FAILED ({exc}).")
            info("Training is safe - retry the export alone with:")
            info(f"    python scripts/export_onnx.py --weights {best_pt}")

    # -- 5/5  COLLECT -------------------------------------------------------
    banner("5/5", "Collecting artifacts")
    WEIGHTS_DIR.mkdir(exist_ok=True)
    for src, dst_name in [(best_pt, "best.pt"), (onnx_path, "best.onnx")]:
        if src and Path(src).exists():
            shutil.copy2(src, WEIGHTS_DIR / dst_name)
            info(f"copied -> weights/{dst_name}")

    summary = {
        "run_name": run_name,
        "finished_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base_model": args.model,
        "data_yaml": str(data_path),
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "val_conf": args.conf,
        "train_seconds": round(elapsed, 1),
        "train_time_human": human_time(elapsed),
        "save_dir": str(save_dir),
        "metrics": metrics_summary,
    }
    summary_path = save_dir / "safemine_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    info(f"summary  -> {summary_path}")

    banner("DONE", "Week 3 YOLOv8 pipeline finished successfully")
    print(f"""
  Weights (PyTorch)  weights/best.pt
  Weights (ONNX)     weights/best.onnx
  Training curves    {save_dir}/results.png
  Confusion matrix   {save_dir}/confusion_matrix_normalized.png
  Metrics summary    {summary_path}

  Next:
    1. Eyeball some predictions:
         python scripts/predict.py --weights weights/best.pt --source <folder-of-images>
    2. Copy weights/best.onnx to the Jetson Nano and follow jetson/README.md
       to build the TensorRT engine.
""")


if __name__ == "__main__":
    main()
