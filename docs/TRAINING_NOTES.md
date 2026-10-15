# Training notes — SafeMine YOLOv8

Fill this in **as you go**. Reconstructing it in week 12 for the final report is
miserable, and half of it (dataset licences, threshold rationale) you simply
cannot recover after the fact.

---

## Dataset sources

Required for CC BY 4.0 attribution (PRD §10). Log every source the day you add it.

| Source | URL | Licence | Images | Notes |
|---|---|---|---|---|
| | | | | |

**Synthetic composites:** how many, generated how, mine-like objects rendered
onto what terrain?

**Physical replicas:** what inert training replicas, photographed where, under
what lighting/terrain conditions?

---

## Class definitions

The **shipped run is single-class**: `nc=1`, class id 0 = `Landmine`
(verified in `logs/train_resume.log` → "Classes (1): Landmine" and
`Overriding model.yaml nc=80 with nc=1`).

The `configs/data.yaml.example` in this repo is the **3-class design** offered
as a template (`landmine_metal`, `landmine_plastic`, `debris_negative`). The
trained model does not use it — it is an aspirational layout with hard
negatives, not the thing the weights were trained on. Keep that straight in the
report: quoting the example's classes would be wrong.

| ID | Name | What counts | What doesn't |
|---|---|---|---|
| 0 | Landmine (single class) | Visible surface mine-like objects / indicators | Buried mines (RGB cannot see them); debris if you want a hard-negative class, retrain with `nc: 2`+ |
| 2 | | | |

Class order is baked into the weights. If you change it, you retrain — and you
update `--names` on the Jetson to match.

---

## Runs

| Run name | Date | Model | Epochs | Batch | Images | mAP@50 | Recall | Precision | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `landmine_yolov8m_75ep` | 2026-08-15 | yolov8m.pt | 75 | 8 | 5,723 tr / 455 val / 221 test | 0.9583 val · 0.9718 test | 0.9537 val · 0.9572 test | 0.9414 val · 0.9655 test | Shipped run. Single class (landmine). See `model_archive/runs/landmine_yolov8m_75ep/safemine_summary.json`; conf=0.25. |

> **Format note.** "val · test" columns mean the re-validation at conf=0.25
> (post-training `best_model.val(split=...)`), which is what `safemine_summary.json`
> records. The epoch-internal `results.csv` in the same folder shows slightly
> different val numbers (e.g. final-epoch mAP@50 ~0.9748) because that validation
> runs at Ultralytics' internal default conf, not at 0.25 — quote the summary JSON,
> not the CSV, and say which one you mean.

Each run writes `safemine_summary.json` in its folder — copy the numbers from
there rather than from the terminal scrollback.

---

## Threshold decision

The number you ship, and the reasoning behind it.

- **Chosen confidence threshold:** `0.25` (the shipped default; matches `--conf` in the training run and `conf=0.25` in `infer_trt.py`/`predict.py`).
- **Recall at that threshold:** `0.9537` val · `0.9572` test (box-level, from `safemine_summary.json`)
- **Precision at that threshold:** `0.9414` val · `0.9655` test
- **Why not the F1-optimal point:** F1 assumes false positives and false
  negatives cost the same. For SafeMine they don't — a missed mine is a safety
  failure, a false positive is an analyst annoyance (PRD §9). So we deliberately
  operate left of the F1 peak, accepting more false positives to buy recall.
- **TODO (reviewer item 2):** re-validate at `conf=0.1` on the test split
  (`yolo detect val model=weights/best.pt data=<data.yaml> split=test conf=0.1`)
  and record recall/precision/F2 at that threshold. The dataset lives on the
  training PC, so this runs there — the numbers above are the conf=0.25 baseline.

---

## Error budget

For the report's honest-accuracy section (PRD §10). Do not imply pinpoint
accuracy — this is a safety system, and overstating precision is the dangerous
direction to be wrong in.

| Source | Estimate | Notes |
|---|---|---|
| GPS (Holybro M10) | ~1–3 m | Manufacturer spec, no RTK. `geo.py` assumes 2.5 m |
| Altitude (relative) | 5% of AGL | Barometric drift. Scales with offset from frame centre |
| Heading / compass | 5° | After a good calibration. Bad calibration is far worse |
| Box centroid jitter | ~4 px × GSD | Frame-to-frame wobble of the detection itself |
| **Total (RSS)** | **run the command below** | Report this, not the GPS number alone |
| Attitude (roll/pitch off nadir) | NOT MODELLED | Named as a limitation, not folded into the total |
| Flat-ground assumption | NOT MODELLED | GSD formula breaks outright on slopes |
| Lens distortion | NOT MODELLED | Worst at frame edges, where offset error is already largest |

`jetson/geo.py` computes the first five rows and returns the total as
`horizontal_error_m` on every geotagged detection. Get the numbers for your actual
camera and flight altitude:

```bash
python3 jetson/geo.py --hfov 62.2 --width 1280 --height 720 --alt 30
```

It prints the GSD, the ground footprint, and how the error grows from frame centre to
corner. Paste the corner figures into the table above — the corner is the honest
worst case, and it is where detections at the edge of the swath actually land.

The last three rows are deliberately left unmodelled rather than guessed at. Each
needs data this project does not have (a terrain model, IMU attitude fused per frame,
a camera calibration), and inventing a number for them would make the total look
rigorous while being fiction. Report them as named limitations instead — PRD §10 asks
for honesty about accuracy, and "we did not model this" is honest in a way that a
made-up 0.5 m is not.

**Field check worth doing once:** put an inert replica at a surveyed point, fly the
grid, and compare the reported lat/lon against the truth. One measured number beats
the whole table for the report, and it is the only way to catch a wrong `--hfov` —
which shows up as every detection being off by the same factor, not as scatter.

---

## Known failure modes

Catalogue what the model gets wrong — this is more useful in a report than a
single mAP number, and it's what a reviewer will ask about.

- **False positives on:** (rocks? scrap metal? shadows? vegetation?) — *not yet recorded; the confusion matrix PNG exists in `runs/.../landmine_yolov8m_75ep/confusion_matrix_normalized.png` — inspect it and paste the top confusion cells here.*
- **Misses on:** (partial occlusion? low contrast? small objects at altitude?) — *not yet recorded; combine the confusion matrix with the PR curve (`BoxPR_curve.png`) and eyeball the worst false-negative images from `val_batch*_pred.jpg`.*
- **Terrain not represented in training:** 
- **Lighting conditions not represented:** 

---

## Jetson deployment

| Item | Value |
|---|---|
| JetPack version | |
| TensorRT version | |
| Engine precision | FP16 |
| Measured FPS @ 640 | |
| Engine build time | |
| Model shipped | yolov8m / yolov8n |

**Flight-speed sanity check:** at ___ FPS and ___ m/s ground speed, the drone
samples every ___ metres. Object tracking across frames is explicitly out of
scope (PRD §2.2), so every frame stands alone and sparse sampling means real
misses. Does the sampling interval actually cover the search area?

---

## Reproducibility

- Seed: `0` (the script default)
- Full command used for the shipped model:
  ```
  python week3_train_yolov8.py --data ... 
  ```
- Git commit of this repo at training time: `___`
- `ultralytics` / `torch` versions: (printed by `scripts/check_env.py`)
