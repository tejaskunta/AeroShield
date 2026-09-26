# SafeMine Review Guide

This guide is a short path through the repository for a code review or project presentation.

## Start Here

1. Read `README.md` for the project scope and current implementation status.
2. Open `week3_train_yolov8.py` for the model training pipeline.
3. Open `configs/data.yaml.example` for the dataset format and class order.
4. Open `scripts/verify_dataset.py` for dataset validation.
5. Open `scripts/predict.py` for laptop inference with `.pt` weights.
6. Open `jetson/build_engine.sh` and `jetson/infer_trt.py` for TensorRT deployment.
7. Open `jetson/live_detect.py` for the camera-to-detection pipeline.
8. Open `backend/app/main.py` and `backend/app/api/detections.py` for the API.
9. Open `frontend/src/App.tsx` for the dashboard routes.

## Where Is Training?

The main training file is:

```text
week3_train_yolov8.py
```

The important configuration is near the top:

```python
BASE_MODEL = "yolov8m.pt"
DATA_YAML = "datasets/unified_dataset/data.yaml"
```

The command is:

```bash
python3 week3_train_yolov8.py --data path/to/data.yaml
```

The default training parameters are:

| Parameter | Value | Meaning |
|---|---:|---|
| Base model | `yolov8m.pt` | Pretrained YOLOv8 medium checkpoint |
| Epochs | `75` | Maximum passes through the training data |
| Image size | `640` | Training input size |
| Batch size | `16` | Images processed per update |
| Device | `0` | First CUDA GPU |
| Patience | `20` | Early stopping after 20 epochs without validation improvement |
| Confidence | `0.25` | Validation/prediction threshold default |
| Seed | `0` | Reproducibility seed |
| ONNX opset | `12` | Export setting for the Jetson toolchain |

The shipped run used batch size `8`. The script also supports `--model`, `--batch`, `--device`, `--workers`, `--patience`,
`--cache`, `--resume`, `--no-export`, and `--seed`.

## What Happens During Training?

The script runs these stages:

1. **Pre-flight:** checks Python, PyTorch, CUDA, the dataset path, and class names.
2. **Load:** loads the pretrained YOLOv8 checkpoint.
3. **Train:** fine-tunes the model on the project dataset.
4. **Validate:** evaluates the best checkpoint on the validation and test splits.
5. **Export:** converts the best PyTorch checkpoint to ONNX.
6. **Collect:** copies stable artifacts into `weights/` and writes a run summary.

Training artifacts are written under `runs/detect/`. Stable model copies are written to:

```text
weights/best.pt
weights/best.onnx
```

Do not quote precision, recall, or mAP unless the actual run summary or plots are available.

## TensorRT in Simple Terms

TensorRT is NVIDIA's inference optimizer and runtime. It takes the portable ONNX graph
and prepares an engine optimized for the target Jetson GPU.

```text
RTX 4070 training computer:  best.pt
RTX 4070 export:             best.onnx
Jetson Nano build:           best.engine
Jetson Nano runtime:         detections
```

The engine is hardware-specific. It depends on the GPU architecture, TensorRT version,
CUDA environment, input shape, and optimization settings. Therefore the engine must be
built on the Jetson Nano, not on the RTX 4070.

The build command on the Jetson is:

```bash
bash build_engine.sh best.onnx
```

`jetson/build_engine.sh` calls NVIDIA's `trtexec` with FP16 enabled. FP16 uses less
memory and is faster on the Jetson while normally preserving useful model accuracy.
TensorRT selects optimized CUDA kernels, allocates buffers, and serializes the result as
`best.engine`.

At runtime, `jetson/infer_trt.py`:

1. loads the serialized engine;
2. allocates host and GPU buffers;
3. letterboxes the camera frame;
4. converts BGR to RGB and normalizes pixels;
5. copies the input to GPU memory;
6. executes the TensorRT context asynchronously;
7. copies outputs back;
8. applies confidence filtering and non-maximum suppression;
9. converts boxes back to original-image coordinates.

The ONNX/export input size and TensorRT preprocessing size must match the engine. Verify
that before claiming a deployment run is complete.

## Laptop Webcam Demo

Use the real model, simulated GPS, and no backend upload:

```bash
python3 jetson/live_detect.py \
  --detector ultralytics \
  --weights weights/best.pt \
  --gps sim \
  --source 0 \
  --device cpu \
  --imgsz 640 \
  --no-uplink
```

This demonstrates camera capture and model inference. GPS is simulated because a laptop
has no drone GPS connection. It does not prove drone altitude, aerial range, Jetson FPS,
or field safety.

Fallback plumbing demo:

```bash
python3 jetson/live_detect.py --detector mock --gps sim --source 0 --no-uplink
```

The fallback creates synthetic detections and does not test model accuracy.

## Folder Map

| Folder/file | Purpose | Review priority |
|---|---|---|
| `week3_train_yolov8.py` | Train, validate, export, and collect model artifacts | Essential |
| `configs/` | Dataset configuration template | Essential |
| `scripts/` | Environment checks, dataset checks, prediction, ONNX export | Essential |
| `weights/` | Stable `.pt` and `.onnx` model artifacts | Essential for demo |
| `jetson/` | TensorRT inference, GPS, geolocation, uplink, live pipeline | Essential for architecture |
| `backend/` | FastAPI API, database, authentication, persistence | Important |
| `frontend/` | React operator dashboard | Important |
| `tests/` | Automated tests | Important |
| `docs/` | Training, API, and review documentation | Useful |
| `runs/` | Generated training runs and plots | Archive if not presenting metrics |
| `Aeroshield Weights/` | Additional/duplicate training artifacts | Archive after confirming contents |
| `jetson/logs/` | Runtime logs | Archive unless showing evidence |
| `jetson/spool/` | Offline upload queue | Preserve real mission data; archive test data |
| `backend/storage/` | Uploaded runtime images | Archive unless needed for demo |
| `.venv/`, `.venv312/` | Local Python environments | Do not present; recreate if needed |
| `frontend/node_modules/` | Installed frontend packages | Do not present; recreate with npm install |

Nothing in this guide requires deleting files. Move only generated or duplicate material to
an archive outside the workspace after making a backup.

## Honest Project Status

The model training and edge-deployment pipeline are implemented as project code. The
frontend is simulator-first, and the singular `/api/detect` endpoint is a mock development
route. The intended production architecture is:

```text
Jetson camera -> YOLO/TensorRT -> GPS/geolocation -> FastAPI -> database -> dashboard
```

The RGB model detects visible landmine-like objects or surface indicators. It does not
claim to detect buried mines.
