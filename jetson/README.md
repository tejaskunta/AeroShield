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
| `yolov8m` | ~2–3 | too slow |

The shipped model is `yolov8m`. If the drone
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

Per PRD §8, after a detection fires on the Nano the pipeline continues:

1. Read `GLOBAL_POSITION_INT` over MAVLink → geotag the detection.
2. `POST` the detection + image to the FastAPI backend.
3. Backend writes to PostgreSQL/PostGIS and pushes via Socket.io to the dashboard.

<<<<<<< HEAD
`infer_trt.py` stops at step 0 — it produces boxes, scores and class ids. The
MAVLink geotagging and the REST POST are Week 4/5 work and belong in a separate
module that imports `TrtYolo` from this file.
=======
`infer_trt.py` stops at step 0 â€” it produces boxes, scores and class ids. Steps 1
and 2 are **now implemented** in this folder (Week 4), as separate modules that
import `TrtYolo` from this file:

| File | Role |
|---|---|
| `gps.py` | MAVLink `GLOBAL_POSITION_INT` + `GPS_RAW_INT` â†’ `GpsFix`. Also a simulated provider so this works with no hardware. |
| `geo.py` | bbox pixels â†’ lat/lon, with a 1-sigma error estimate |
| `detector.py` | one interface over TensorRT / Ultralytics / mock |
| `uplink.py` | queued POST to the backend, retries, offline disk spool + replay |
| `live_detect.py` | wires all of the above together â€” **this is the Week 4 deliverable** |

Step 3 is Week 5 and lives in `backend/` â€” see `docs/API.md`.

---

## Python 3.6 — the constraint that shapes this whole folder

JetPack 4.6 is the final release for the P3450, and it ships **Python 3.6.9**.
`python3-libnvinfer` and `python3-opencv` are apt packages built against that
system interpreter, so installing a newer Python means losing TensorRT and OpenCV.
You cannot escape 3.6 here.

That rules out, in every file in this folder:

- `from __future__ import annotations` â€” PEP 563, Python 3.7+. A hard `SyntaxError`
  on 3.6, raised before any code runs.
- builtin generics: `tuple[int, str]`, `list[float]` â€” PEP 585, Python 3.9+.
  Use `typing.Tuple`, `typing.List`.
- `X | None` unions â€” PEP 604, Python 3.10+. Use `typing.Optional`.
- `dataclasses` â€” Python 3.7+. Use `typing.NamedTuple`.
- the walrus operator `:=` â€” Python 3.8+.

f-strings are fine (3.6+), though this folder uses `.format()` throughout for
consistency.

Check before you copy anything to the drone:

```bash
grep -rnE "from __future__|-> *(tuple|list|dict)\[|[A-Za-z] \| None|dataclass" jetson/
```

Empty output means it will at least import on the Nano.

---

## Run the full Week 4 pipeline

On a laptop, no drone and no Jetson required:

```bash
# Pure plumbing: synthetic detections, simulated GPS track
python3 jetson/live_detect.py --detector mock --gps sim --headless --max-frames 60

# Real weights, real webcam, simulated GPS
python3 jetson/live_detect.py --detector ultralytics --weights weights/best.pt \
    --gps sim --source 0

# Send to a running backend
export AEROSHIELD_API_KEY=aero_...
python3 jetson/live_detect.py --detector mock --gps sim \
    --mission-name bench-1 --backend-url http://127.0.0.1:8000 --headless --max-frames 60
```

On the drone:

```bash
pip3 install -r jetson/requirements-nano.txt

python3 jetson/live_detect.py \
    --detector trt --engine best.engine --names metal random_plastic_debris \
    --gps mavlink --gps-url /dev/ttyTHS1:921600 \
    --hfov 62.2 \
    --backend-url http://<server>:8000 --api-key $AEROSHIELD_API_KEY \
    --mission-name field-test-1 --headless
```

Against ArduPilot SITL first â€” PRD Â§10 says never debug flight logic on the real
airframe:

```bash
python3 jetson/live_detect.py --detector mock --gps mavlink \
    --gps-url udp:127.0.0.1:14550 --headless --max-frames 100
```

**`--hfov` is not optional in spirit.** It is the horizontal field of view of the
lens actually fitted, and every geotag scales with it. A guessed value is not noise:
it is a systematic error that puts *every* detection wrong by the same factor. Get it
from the datasheet or measure it (a tape measure in frame at a known height), then
check what it implies:

```bash
python3 jetson/geo.py --hfov 62.2 --width 1280 --height 720 --alt 30
```

### If the link drops mid-flight

Nothing is lost. `uplink.py` spools failed sends to `jetson/spool/` as JSON + JPEG
and retries. Drain the backlog afterwards:

```bash
python3 jetson/uplink.py --status
python3 jetson/uplink.py --replay --backend-url http://<server>:8000 --api-key $KEY
```

Replay is safe to run repeatedly: every record carries a `client_detection_id` UUID
and the backend deduplicates on it, so a half-finished replay cannot create doubles.

`live_detect.py` also writes `jetson/logs/detections.jsonl` and `.csv` before it
touches the network, flushed on every write. If the backend was unreachable for a
whole flight, those two files are the mission record.


>>>>>>> 2e80446 (feat: complete backend API, database schemas, Jetson integration & documentation)
