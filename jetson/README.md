# Jetson Nano — TensorRT deployment

This folder is the handoff from your training PC to the drone. Nothing here runs
on the RTX 4070; everything here runs on the **Jetson Nano P3450 (4 GB)**.

---

## The one rule

**A TensorRT engine is not portable.** It is compiled against a specific GPU
architecture *and* a specific TensorRT version. An engine built on your RTX 4070
(Ada, TensorRT 10.x) will flatly refuse to load on the Nano (Maxwell,
TensorRT 8.2).

So the split is:

| Step | Where | Artifact |
|---|---|---|
| Train | RTX 4070 | `best.pt` |
| Export | RTX 4070 | `best.onnx` ← portable |
| Build engine | **Jetson Nano** | `best.engine` ← device-locked |
| Inference | **Jetson Nano** | detections |

ONNX is the bridge. That's the whole reason the training script exports it.

---

## Why this folder avoids `ultralytics` entirely

The Jetson Nano P3450 is NVIDIA-EOL'd at **JetPack 4.6 / CUDA 10.2 / Python 3.6**.
Modern Ultralytics needs Python ≥3.8 and a recent PyTorch. You will not get
them onto this board without a fight, and `pip install ultralytics` on the Nano
is the single most reliable way to lose the week your PRD (§10) warns about.

`infer_trt.py` therefore uses **raw TensorRT + pycuda + OpenCV** — all of which
ship with or install cleanly on JetPack 4.6. No PyTorch on the drone at all.

---

## Step 1 — Copy the ONNX over

From the training PC:

```bash
scp weights/best.onnx <user>@<nano-ip>:~/safemine/
```

## Step 2 — One-time Nano setup

```bash
ssh <user>@<nano-ip>
mkdir -p ~/safemine && cd ~/safemine

sudo apt-get update
sudo apt-get install -y python3-libnvinfer python3-opencv python3-pip
pip3 install pycuda numpy

# Confirm TensorRT is present (JetPack ships it):
ls /usr/src/tensorrt/bin/trtexec
```

**Add swap before building.** The engine build is memory-hungry and 4 GB is not
enough; without swap the build gets OOM-killed halfway through, which looks
like a random freeze:

```bash
sudo fallocate -l 4G /var/swapfile
sudo chmod 600 /var/swapfile
sudo mkswap /var/swapfile
sudo swapon /var/swapfile
echo '/var/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
```

## Step 3 — Build the engine

```bash
cd ~/safemine
bash build_engine.sh best.onnx
```

This takes **5–20 minutes** and looks hung. It isn't — TensorRT is benchmarking
every candidate kernel to pick the fastest. Let it finish.

The script pins the board to max clocks (`nvpmodel -m 0` + `jetson_clocks`)
first. Skip that and every number you measure is meaningless.

## Step 4 — Benchmark and run

```bash
# Raw throughput
/usr/src/tensorrt/bin/trtexec --loadEngine=best.engine --fp16

# Live camera, headless (over SSH with no display)
python3 infer_trt.py --engine best.engine --source 0 --headless \
    --names metal random_plastic_debris

# Single image, save the annotated result
python3 infer_trt.py --engine best.engine --source test.jpg \
    --save out.jpg --headless
```

Pass `--names` in **exactly your training class order** — the same order as
`names:` in `data.yaml`. Get it wrong and every label is confidently mislabeled.

---

## Expected performance

Rough figures for the Nano P3450 at 640×640, FP16:

| Model | FPS | Verdict |
|---|---|---|
| `yolov8n` | ~12–18 | comfortable |
| `yolov8s` | ~5–9 | usable for a grid mission |
| `yolov8m` | ~2–3 | too slow |

Start with `yolov8s` (what the training script defaults to). If the drone
outruns the inference, retrain with `--model yolov8n.pt` — same script, same
pipeline, no other change.

Do the arithmetic against your flight plan: at 5 FPS and 5 m/s ground speed you
sample every metre. Your PRD (§2.2) explicitly rules out object tracking across
frames, so each frame stands alone — sparse sampling directly means missed
detections, and §9 says recall is the metric that matters. Either slow the drone
down or drop to `yolov8n`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `deserialize_cuda_engine` returns `None` | Engine built on another machine or another TRT version | Rebuild on the Nano |
| Build killed / board freezes | Out of memory | Add swap (Step 2), then `WORKSPACE_MB=1024 bash build_engine.sh` |
| `Unsupported ONNX operator` | Opset too new for TRT 8.2 | Re-export on the PC: `python scripts/export_onnx.py --opset 11` |
| `Network has dynamic or shape inputs` | Exported with `dynamic=True` | Re-export with `dynamic=False` (the default) |
| Detections are wrong/shifted | Letterbox mismatch | Ensure `--imgsz` at export matches training (640) |
| Labels wrong but boxes right | Class order mismatch | Fix `--names` order to match `data.yaml` |
| ~2 FPS with a small model | Board throttled | `sudo nvpmodel -m 0 && sudo jetson_clocks` |

---

## Where this plugs into SafeMine

Per PRD §8, after a detection fires on the Nano you still need to:

1. Read `GLOBAL_POSITION_INT` over MAVLink → geotag the detection.
2. `POST` the detection + image to the FastAPI backend.
3. Backend writes to PostgreSQL/PostGIS and pushes via Socket.io to the dashboard.

`infer_trt.py` stops at step 0 — it produces boxes, scores and class ids. The
MAVLink geotagging and the REST POST are Week 4/5 work and belong in a separate
module that imports `TrtYolo` from this file.
