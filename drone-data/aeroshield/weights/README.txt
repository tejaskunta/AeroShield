# weights/ directory

This directory is populated by running the training pipeline:

```bash
python week3_train_yolov8.py --data <path>/data.yaml --epochs 75
```

The script copies the latest `best.pt` (PyTorch checkpoint) and `best.onnx` (ONNX export for the Jetson) into this folder.

**Files excluded from git:**
- `*.pt`  (52 MB+, exceeds GitHub's 100 MB file limit)
- `*.onnx` (104 MB+, exceeds GitHub's 100 MB file limit)

To recreate these files:
1. Run `python scripts/check_env.py` to verify CUDA is active.
2. Run `python week3_train_yolov8.py --data <path>/data.yaml --epochs 75 --model yolov8m.pt`
3. Artifacts appear in `weights/` and `runs/detect/<run_name>/`.
