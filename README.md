# SafeMine — YOLOv8 Detection Model (Week 3)

Training pipeline for the SafeMine landmine-detection drone. Trains YOLOv8 on an
RTX 4070, then hands off a TensorRT-ready ONNX model to a Jetson Nano.

```
RTX 4070 (train) ──► best.pt ──► best.onnx ──► [Jetson Nano] ──► best.engine
                                  portable                       device-locked
```

> **Scope note (PRD §2.2):** an RGB camera physically cannot see buried objects.
> This model detects **visible landmine-like objects and surface indicators only**.
> That's a design constraint, not a gap — state it explicitly in your report.

---

## TL;DR

```bash
git clone <your-repo-url> && cd safemine-yolov8
python -m venv .venv && .venv\Scripts\activate        # Windows
# python3 -m venv .venv && source .venv/bin/activate  # Linux/macOS

pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt

python scripts/check_env.py                            # is CUDA actually working?
python week3_train_yolov8.py --data datasets/unified_dataset/data.yaml --epochs 3
```

If that last command finishes and writes `weights/best.onnx`, your whole
toolchain works. Now point it at real data.

---

## Install (do this in order)

**Order matters.** `pip install ultralytics` pulls in a CPU-only PyTorch. If you
let that happen first, `device=0` fails and you train on CPU at ~20× slower.

### 1. Python 3.10–3.12

3.13 is too new for some wheels; 3.10 or 3.11 is the safe choice.

### 2. PyTorch with CUDA — **first**

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
```

### 3. Everything else

```bash
pip install -r requirements.txt
```

### 4. Verify

```bash
python scripts/check_env.py
```

You want to see `CUDA available : yes` and your 4070 listed. If it says
`CPU-only torch`, run the uninstall/reinstall it prints and try again.

---

## Prepare your dataset

Expected layout (standard YOLO — Week 2 step 04 produces this):

```
datasets/unified_dataset/
├── data.yaml
├── train/{images,labels}/     ~70%
├── val/{images,labels}/       ~15%
└── test/{images,labels}/      ~15%
```

Each `labels/frame_0001.txt` matches `images/frame_0001.jpg`:

```
<class_id> <x_center> <y_center> <width> <height>    # all normalised 0.0–1.0
```

Start from [configs/data.yaml.example](configs/data.yaml.example), then **always
verify before training**:

```bash
python scripts/verify_dataset.py --data datasets/unified_dataset/data.yaml
```

This catches unnormalised coordinates, class-id mismatches, missing labels, and
classes present in train but absent from val — i.e. every reason a run silently
returns mAP 0.0 after forty minutes.

---

## Train

```bash
python week3_train_yolov8.py --data datasets/unified_dataset/data.yaml
```

Defaults: `yolov8s.pt`, 50 epochs, 640px, batch 16, `device=0`. On an RTX 4070
with a few thousand images that's roughly **30–60 minutes**.

The script runs five stages and prints a banner at each:

| Stage | What happens |
|---|---|
| 0/5 Pre-flight | Verifies CUDA, GPU, VRAM, `data.yaml`, class list — fails fast |
| 1/5 Load | Downloads `yolov8s.pt` on first run |
| 2/5 Train | 50 epochs with live metrics; writes `last.pt` every epoch |
| 3/5 Validate | Runs `best.pt` on **both** val and test splits |
| 4/5 Export | ONNX, opset 12, fixed shapes — TensorRT 8.2-compatible |
| 5/5 Collect | Copies artifacts to `weights/`, writes `safemine_summary.json` |

### Useful flags

```bash
--epochs 100          # longer run
--batch 8             # if you hit CUDA out-of-memory
--batch -1            # let Ultralytics auto-size the batch
--model yolov8n.pt    # smaller/faster — use if the Nano can't keep up
--conf 0.15           # lower validation threshold → higher recall
--patience 0          # disable early stopping
--name my_run         # name the run folder
--resume --name my_run  # resume an interrupted run
--device cpu          # no GPU (very slow — for testing logic only)
```

Ctrl-C is safe at any point: `last.pt` is written every epoch, and the script
prints the exact `--resume` command to continue.

### Outputs

```
runs/detect/safemine_<timestamp>/
├── weights/best.pt, last.pt, best.onnx
├── results.png                      ← training curves, put this in the report
├── confusion_matrix_normalized.png  ← and this
├── PR_curve.png, F1_curve.png
├── results.csv                      ← per-epoch metrics
└── safemine_summary.json            ← machine-readable run summary

weights/best.pt, weights/best.onnx   ← stable copies, always the latest run
```

---

## Tuning for recall

Per PRD §9: **a missed mine is a safety failure; a false positive is an analyst
annoyance.** These are not symmetric, and your thresholds should say so.

Read `PR_curve.png` and pick the confidence value where recall is high and
precision is merely tolerable — not the value that maximises F1. F1 assumes the
two error types cost the same. Here they don't.

```bash
# Re-validate at a lower threshold without retraining:
python week3_train_yolov8.py --data <...> --conf 0.15
```

Practical levers, in the order worth trying:

1. **Lower the confidence threshold** — free, instant, biggest effect.
2. **Add hard negatives** — photos of rocks, scrap and debris with *empty* label
   files. This cuts false positives without costing recall.
3. **Train longer / augment more** — genuinely helps, but slowest to iterate.
4. **Go bigger (`yolov8m`)** — only if the Nano can still run it. Usually it can't.

Record the threshold you ship and *why* in the final report.

---

## Sanity-check the model

```bash
python scripts/predict.py --weights weights/best.pt \
    --source datasets/unified_dataset/test/images
```

Writes annotated images to `runs/predict/safemine/`. Open a dozen. You are
looking for two failure modes the metrics hide: boxes on the right objects for
the *wrong* reasons, and whole categories of terrain the model ignores.

---

## Deploy to the Jetson Nano

```bash
scp weights/best.onnx <user>@<nano-ip>:~/safemine/
```

Then follow **[jetson/README.md](jetson/README.md)**. The short version:
build the `.engine` **on the Nano**, never on your laptop — a TensorRT engine is
compiled for one specific GPU and TensorRT version and won't load anywhere else.

Expected on the Nano P3450 @ 640px FP16: `yolov8n` ≈ 12–18 FPS,
`yolov8s` ≈ 5–9 FPS. If `yolov8s` is too slow, retrain with `--model yolov8n.pt`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `CUDA is NOT available` | CPU-only torch. Uninstall, reinstall from the cu124 index |
| `CUDA out of memory` | `--batch 8`, then `--batch -1`. Close Chrome/games — they hold VRAM |
| `Dataset not found` / images not found | Use an **absolute** `path:` in `data.yaml` |
| mAP stays 0.0 | Run `scripts/verify_dataset.py`. Usually unnormalised coords or wrong class ids |
| Recall is poor | Lower `--conf`, add hard negatives, train longer — in that order |
| Slow training, GPU at 30% | Dataloader-bound: `--cache ram`, or raise `--workers` |
| `page file too small` (Windows) | Lower `--workers` to 2, or increase the Windows page file |
| Training loss is NaN | Bad boxes in the dataset — `verify_dataset.py` will find them |

---

## Repo layout

```
AeroShield/
├── backend/                   ← FastAPI backend (detection API, future agents)
├── frontend/                  ← React dashboard (to be developed)
├── jetson/                    ← Jetson Nano deployment (TensorRT)
├── ml/                        ← YOLOv8 training pipeline
├── scripts/
│   ├── check_env.py            run this first
│   ├── verify_dataset.py       run this before every training run
│   ├── export_onnx.py          standalone re-export
│   └── predict.py              visual sanity check
├── week3_train_yolov8.py       ← main training deliverable: train → val → export
├── configs/data.yaml.example
├── docs/TRAINING_NOTES.md      ← what to record for the report
├── docker-compose.yml          ← (to be developed) service orchestration
└── README.md
```

---

## Stack (per PRD §7)

| Component | Tool |
|---|---|
| Detection model | YOLOv8s (Ultralytics), TensorRT-exported |
| Training | PyTorch + CUDA 12.4, RTX 4070 8 GB |
| Deployment | Jetson Nano P3450, JetPack 4.6, TensorRT 8.2, FP16 |
| Explainability | Grad-CAM (Week 5 — needs `best.pt`, not the engine) |

**Keep `best.pt`.** Grad-CAM (PRD §5.1, the highest-ROI feature) runs against
the PyTorch checkpoint, not the TensorRT engine. The `.pt` file is not disposable
once you have the `.onnx`.

## Dataset licensing

Public datasets (Roboflow Universe etc.) are typically CC BY 4.0 — you must
attribute them in the final report and repo (PRD §10). Record every source in
[docs/TRAINING_NOTES.md](docs/TRAINING_NOTES.md) as you go; reconstructing it in
week 12 is miserable.
