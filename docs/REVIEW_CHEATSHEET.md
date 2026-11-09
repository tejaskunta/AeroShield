# SafeMine Review Cheat Sheet

A one-page set of questions a reviewer can ask, with the repo's actual answers.
Every figure here is **verified from artifacts in this workspace** — from
`model_archive/runs/landmine_yolov8m_75ep/` and its
`logs/train_resume.log` — not from memory.

The one thing this sheet cannot answer is the split-leakage question; see
item 1 at the bottom.

---

## Q1. What model did you train, and on what?

**Answer.** Ultralytics **YOLOv8m**, fine-tuned from the `yolov8m.pt` pretrained
checkpoint (COCO-initialised), 75 epochs, input 640×640, batch 8, AdamW
(auto), seed 0, patience 20.

- Evidence: `safemine_summary.json` → `base_model: yolov8m.pt`, `epochs: 75`,
  `batch: 8`; `args.yaml` → full resolved config.
- Run name: `landmine_yolov8m_75ep`, finished `2026-08-15`, 15 h 16 m on an
  **RTX 4070 Laptop 8 GB** (from the log header).
- The trained checkpoint is the same weights in both `weights/` folders
  (byte-identical copies of `runs/.../landmine_yolov8m_75ep/weights/best.pt`).

**Honest limit.** Only the **medium** (25.9 M-param) model was trained. The
`yolov8n.pt` / `yolov8s.pt` comparisons that the paper would like are **not
present** in this repo. The reviewer asked for them; the answer is "not yet —
same script accepts `--model yolov8n.pt`".

---

## Q2. What are the real numbers?

**Answer.** Single-class (`landmine`), **1 class**. From
`safemine_summary.json`, validated at **conf = 0.25**:

| Split | Images | Precision @0.25 | Recall @0.25 | mAP@50 | mAP@50–95 |
|---|---:|---:|---:|---:|---:|
| **val** | 455 | 0.9414 | 0.9537 | 0.9583 | 0.6239 |
| **test** | 221 | 0.9655 | 0.9572 | 0.9718 | 0.6360 |

Evidence: `safemine_summary.json` `metrics` block (float-exact), and identical
figures in the tail of `logs/train_resume.log` ("all 455 ... precision 0.9414
recall 0.9537 ...").

**Caveat to state unprompted.** These are **box-level** numbers at
`conf=0.25`. They are **not** comparable to a 96.14 % *image-level thermal*
accuracy from a different paper — different task, different modality, different
metric. Do the comparison only after re-validating at `conf=0.1` (recall-first)
and **at image level**, or explicitly refuse the comparison as apples-to-oranges.

---

## Q3. How many images — and did you split before augmenting?

**Answer.** The training log recorded these counts on its first pass:

- **train 5723** images (+48 background), **val 455** (+1 background),
  **test 221** (0 corrupt) — from the `Scanning ... labels.cache` lines in
  `logs/train_resume.log`. All three figures are exactly the 5723 / 455 / 221
  reported in the project notes.

**Honest limit — ask your teammate.** The split-order evidence (split-before-
augmentation or after) is **not in this repo**: there is no Week-2 dataset
script in the workspace and the `datasets/` folder is not shipped here (it lives
on the training PC). The augmentations used (per `args.yaml`: `hsv_h/s/v`,
`fliplr=0.5`, `scale=0.5`, `translate`, `randaugment`, `mosaic`, `close_mosaic=10`)
only avoid leakage if they were applied **after** the split. This is the single
most important question to resolve before submission.

---

## Q4. Where does training happen, and how do I re-run it?

**Answer.** `week3_train_yolov8.py` — one script, 5 stages
(pre-flight → load → train → validate → export → collect). Defaults are at the
top: `DATA_YAML` and `BASE_MODEL`.

```bash
# from the repo root, on a CUDA machine
python3 week3_train_yolov8.py --data datasets/unified_dataset/data.yaml
```

Key flags: `--model yolov8n.pt|s.pt|m.pt`, `--epochs`, `--batch`, `--imgsz`
(keep 640), `--conf`, `--seed`, `--device`, `--resume`, `--no-export`,
`--opset`.

It validates **both `val` and `test`** splits after training (`best_model.val(split=...)`),
writes `runs/detect/<name>_val|_test/` curves, and writes a
`safemine_summary.json` per run.

---

## Q5. Where are the artifacts, and which folder does what?

**Answer.**

| Path | Contents |
|---|---|
| `runs/detect/run/weights/best.pt` + `best.onnx` | Training output (the canonical copy, from the real run: `model_archive/runs/landmine_yolov8m_75ep/weights/`) |
| `weights/best.pt`, `weights/best.onnx` | Stable copies copied by the script (byte-identical, gitignored) |
| `weights/README.txt` | Note that `.pt`/`.onnx` are > 100 MB and excluded from git |
| `model_archive/` | A **second, duplicate** copy of the same artifacts + logs (the folder the training was actually run from on Windows) |
| `jetson/best.engine` | Absent — engine is built **on the Nano** (`build_engine.sh`), not here |

**Important for the review:** `model_archive/` is a *duplicate* of the
canonical folder, not a separate run. Present one copy in the paper/repo to
avoid confusion; the other is safe to archive (nothing to delete — just move it
out of the workspace if presenting).

---

## Q6. What is the inference / deployment path?

**Answer.** Three fully separate entry points, all wired from one saved
checkpoint:

1. **Laptop PC — PyTorch:**
   `scripts/predict.py --weights weights/best.pt --source <folder>`
   (`conf` default 0.25). For eyeballing predictions right after training.

2. **Jetson / TensorRT:** `jetson/infer_trt.py`, which loads a serialized
   `best.engine`, letterboxes → BGR2RGB → normalize → NCHW → `execute_async_v2`
   → NMS. Entry: `--engine best.engine --source 0`. The engine is built **on the
   Nano** (never on the PC) via

   ```bash
   bash jetson/build_engine.sh best.onnx     # scp best.onnx to the Nano first
   ```

   `build_engine.sh` pins max clocks (`nvpmodel -m 0`), builds with `--fp16`,
   workspace 2048 MB.

3. **Live capture → geotag → backend:** `jetson/live_detect.py` —
   camera → YOLO/TensorRT → MAVLink GPS → `geo.bbox_to_latlon` → `BackendUplink`
   → `POST /api/detections` + `PUT /image` (+ Grad-CAM on laptop).
   Run flags: `--detector trt|onnx|ultralytics|mock`, `--gps mavlink|sim`,
   `--gps-url`, `--mission-name`, `--backend-url`, `--api-key`.

   A laptop demo that needs **no GPU**: `--detector mock --gps sim --headless`.
   That is plumbing-only — it proves the chain, not the model.

**The one thing to nail in the review:** the **input size** must agree across
(1) the ONNX export `imgsz` (640), (2) the engine built on the Nano, and (3)
`infer_trt.py`'s `preprocess` target (`320×320` default in the code). The
training exports at 640, but `infer_trt.preprocess` letterboxes to 320 by
default — these *can* differ only if the engine was built at 320. Trade-off:
320 is ~4× fewer MACs (faster, better for the Nano) at some detail cost. Say
which one the shipped engine uses, and match it in both places. (This is the
classic silent bug.)

---

## Q7. How do you handle not-quite-certain detections?

**Answer.** Three mechanisms:

- **Confidence threshold:** default `conf=0.25` for training, prediction, and
  inference. In `infer_trt.postprocess`, `scores >= conf_thres` — the model is
  explicitly tuned to prefer recall over precision (the README says exactly:
  "recall is the metric that matters"; lower `--conf` rather than train longer,
  and keep `PR_curve.png` handy).
- **State on the server:** every detection is stored with a review lifecycle
  (`unreviewed → confirmed | flagged | cleared`, with `reviewed_by`/`reviewed_at`
  stamped server-side).
- **Hazard prioritisation:** the backend and dashboard surface confirmed
  detections as hazards / caution, with client-side reason enrichment.

**When there is no signal:** if you get zero detections on a fresh model, the
docs tell you to retry at `--conf 0.05` before assuming the model is broken.

---

## Q8. Do you have ground truth for the test split, and is the metric meaningful?

**Answer.** Yes — the test split is a real held-out `test/` split (221 images,
966 instances from the log), not a subset of `train`. The mAP/recall/precision
are computed against its ground-truth labels by Ultralytics
(`best_model.val(split='test')`). The test numbers (P 0.9655 / R 0.9572) are
higher than val — good sign, but be honest they're single-run, single-seed
figures.

**Honest limit.** Single seed (0), single run, single checkpoint. There are no
multi-seed confidence intervals, no per-class breakdown (the dataset is
single-class `landmine`), and no image-level metric — mAP is box-level.

---

## Q9. What about the Jetson — did you actually run it?

**Answer.** The **code path for the Nano** is complete, but the
`best.engine` / onboard run **is not proven in this workspace** — there's no
engine file, no live logs, no FPS screenshot. The documented flow is:

```text
train PC: best.pt → export → best.onnx
scp best.onnx → Nano
Nano: bash build_engine.sh best.onnx → best.engine  (FP16, ~5–20 min)
Nano: python3 infer_trt.py --engine best.engine --source 0
```

Be ready to say: "I've validated the PC-side pipeline end-to-end with the real
weights; the Nano engine build and FPS number are the next hardware step" —
not "it runs on the Nano".

---

## Q10. What's in the repo that could trip me up?

- **`model_archive/` duplicates `weights/`** — present one, archive the
  other. Not a defect, just clutter.
- **`docs/REVIEW_GUIDE.md`** exists and is accurate — worth skimming first; the
  cheat sheet is its Q&A companion.
- **No `datasets/` folder is shipped**, so `--data` pointing at the training
  PC's absolute Windows path (`C:\Users\Delta\Downloads\Landmine_project\Datasets\landmine_combined\data.yaml`)
  is the only data reference in the artifacts. A reviewer can't re-run training
  from this repo alone — that's expected, but say it.
- **Engine size mismatch trap** (Q6) and **conf metric trap** (Q2) are the two
  most likely review questions that have a right answer — be ready.

---

## The single open item (escalate early)

1. **Split-before-augment?** — ask the dataset teammate today. If unknown, the
   fastest check without `pip install` is:
   - re-split from **originals** if logs/scripts are lost, or
   - run `scripts/verify_dataset.py` and an `imagehash` nearest-neighbour scan
     of flipped val/test vs train (needs `imagehash` on a machine with the
     dataset).

Everything else in this sheet is a straight read from committed artifacts.

---

*Companion to `docs/REVIEW_GUIDE.md`. All numbers verified 2026-10-07.*