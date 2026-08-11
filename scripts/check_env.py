#!/usr/bin/env python3
"""
SafeMine - environment check.

Run this FIRST, before you touch the training script. It answers the only
question that matters on day one: "will this actually use my RTX 4070?"

    python scripts/check_env.py
"""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys


OK = "  [ok]  "
WARN = "  [!!]  "
BAD = "  [XX]  "

problems: list[str] = []


def head(text: str) -> None:
    print(f"\n--- {text} " + "-" * max(0, 60 - len(text)))


def main() -> int:
    print("=" * 68)
    print("SafeMine environment check")
    print("=" * 68)

    head("System")
    print(f"{OK}OS      : {platform.system()} {platform.release()} ({platform.machine()})")
    py = sys.version_info
    if (3, 8) <= (py.major, py.minor) <= (3, 12):
        print(f"{OK}Python  : {platform.python_version()}")
    else:
        print(f"{WARN}Python  : {platform.python_version()} "
              f"(Ultralytics targets 3.8-3.12; 3.13+ can hit wheel gaps)")

    head("NVIDIA driver")
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(
                ["nvidia-smi",
                 "--query-gpu=name,driver_version,memory.total,memory.used",
                 "--format=csv,noheader"],
                capture_output=True, text=True, timeout=20, check=True,
            ).stdout.strip()
            for line in out.splitlines():
                print(f"{OK}{line}")
        except Exception as exc:  # noqa: BLE001
            print(f"{WARN}nvidia-smi found but failed: {exc}")
    else:
        print(f"{BAD}nvidia-smi not on PATH - install/repair the NVIDIA driver.")
        problems.append("NVIDIA driver missing")

    head("PyTorch")
    try:
        import torch
    except ImportError:
        print(f"{BAD}torch is not installed.")
        print("       pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124")
        problems.append("torch missing")
        torch = None  # type: ignore[assignment]

    if torch is not None:
        print(f"{OK}torch          : {torch.__version__}")
        cuda_build = torch.version.cuda
        if cuda_build is None:
            print(f"{BAD}CUDA build     : NONE - this is the CPU-only wheel.")
            print("       This is THE most common setup mistake on Windows. Fix:")
            print("       pip uninstall -y torch torchvision")
            print("       pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124")
            problems.append("CPU-only torch")
        else:
            print(f"{OK}CUDA build     : {cuda_build}")

        if torch.cuda.is_available():
            n = torch.cuda.device_count()
            print(f"{OK}CUDA available : yes ({n} device{'s' if n != 1 else ''})")
            for i in range(n):
                p = torch.cuda.get_device_properties(i)
                vram = p.total_memory / (1024 ** 3)
                print(f"{OK}  device {i}     : {p.name}, {vram:.1f} GB, sm_{p.major}{p.minor}")
                if p.major >= 12 and torch.version.cuda and float(torch.version.cuda[:4]) < 12.0:
                    print(f"{WARN}  this GPU is newer than your CUDA build; expect kernel errors")
                print(f"{OK}  suggested batch for yolov8s@640 : {suggest_batch(vram)}")
            # Real allocation test - is_available() can lie about a broken install.
            try:
                x = torch.rand(2048, 2048, device="cuda")
                _ = (x @ x).sum().item()
                del x
                torch.cuda.empty_cache()
                print(f"{OK}GPU matmul test: passed")
            except Exception as exc:  # noqa: BLE001
                print(f"{BAD}GPU matmul test: FAILED - {exc}")
                problems.append("GPU compute broken")
        else:
            print(f"{BAD}CUDA available : NO - training will fall back to CPU (hours per run)")
            problems.append("CUDA unavailable")

    head("Python packages")
    for mod, label, required in [
        ("ultralytics", "ultralytics", True),
        ("cv2", "opencv-python", True),
        ("yaml", "PyYAML", True),
        ("numpy", "numpy", True),
        ("onnx", "onnx", False),
        ("onnxruntime", "onnxruntime", False),
        ("onnxslim", "onnxslim", False),
    ]:
        try:
            m = __import__(mod)
            ver = getattr(m, "__version__", "?")
            print(f"{OK}{label:<16}: {ver}")
        except ImportError:
            if required:
                print(f"{BAD}{label:<16}: MISSING (pip install -r requirements.txt)")
                problems.append(f"{label} missing")
            else:
                print(f"{WARN}{label:<16}: missing (only needed for the ONNX export step)")

    head("Verdict")
    if problems:
        print(f"{BAD}{len(problems)} problem(s): " + ", ".join(problems))
        print("\n     Fix these before running week3_train_yolov8.py.")
        return 1
    print(f"{OK}Everything looks good. Next:")
    print("       python scripts/make_smoke_dataset.py      # fake data, 2 min")
    print("       python week3_train_yolov8.py --data datasets/smoke_test/data.yaml --epochs 3")
    return 0


def suggest_batch(vram_gb: float) -> int:
    for threshold, batch in [(22, 48), (15, 32), (11, 24), (7.0, 16), (5.0, 8)]:
        if vram_gb >= threshold:
            return batch
    return 4


if __name__ == "__main__":
    sys.exit(main())
