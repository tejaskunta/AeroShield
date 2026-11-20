#!/usr/bin/env python3
"""Host replay of the AeroShield two-stage onboard path on the frozen test split.

Runs the SAME classes the drone runs (jetson/detector.py OnnxDetector +
jetson/verifier.py VerifiedDetector/OnnxVerifier) over the SafeMine v2 test
images, scores them against the labels with the paper's matching rule, and
compares the kept boxes with the evaluated SafeMine pipeline's records
(SafeMineAI-main/paper_results/stage2/s2_ratio1_s0/raw_preds_test.json under the
same thresholds). This is the evidence that the onboard integration reproduces
the evaluated model; it is a host (laptop CPU) run, not a device run.

    python scripts/replay_twostage.py \
        --detector-onnx ../SafeMineAI-main/models/yolo_s_seed0/last_640.onnx --imgsz 640 \
        --verifier-onnx ../SafeMineAI-main/models/stage2_s0/verifier.onnx \
        --c0 0.02 --protect 0.4 --tau 0.10 --out results/host_replay_twostage/seed0_640.json

Thresholds are the seed-0 values chosen on VALIDATION by
SafeMineAI-main/src/analysis/twostage_rule_a.py; nothing here is tuned on test.
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "jetson"))
from detector import OnnxDetector  # noqa: E402
from verifier import OnnxVerifier, VerifiedDetector  # noqa: E402

DEFAULT_DATA = Path(r"C:\Users\Delta\Downloads\Landmine_project\Datasets\landmine_combined_v2\test")
SAFEMINE = REPO.parent / "SafeMineAI-main"


def iou(a, b):
    iw = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = iw * ih
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


def match(gt, boxes, confs, thr=0.5):
    """Greedy COCO-style matching, identical to two_stage_eval.match_image."""
    order = sorted(range(len(boxes)), key=lambda i: -confs[i])
    taken, tp = set(), 0
    for i in order:
        best, best_iou = -1, thr
        for j, g in enumerate(gt):
            if j not in taken:
                v = iou(boxes[i], g)
                if v >= best_iou:
                    best, best_iou = j, v
        if best >= 0:
            taken.add(best)
            tp += 1
    return tp, len(boxes) - tp, len(gt) - tp


def read_gt(label_path, w, h):
    out = []
    if label_path.exists():
        for line in label_path.read_text().splitlines():
            p = line.split()
            if len(p) >= 5:
                cx, cy, bw, bh = (float(x) for x in p[1:5])
                out.append([(cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h])
    return out


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def reference_kept(ref_records, c0, protect, tau):
    out = {}
    for r in ref_records:
        kept = [d for d in r["dets"] if d["conf"] >= c0 and (d["conf"] >= protect or d["cls_p"] >= tau)]
        out[r["name"]] = kept
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--detector-onnx", required=True)
    ap.add_argument("--imgsz", default="640", help="640 or 512x288 (WxH) - must match the export")
    ap.add_argument("--verifier-onnx", required=True)
    ap.add_argument("--c0", type=float, required=True)
    ap.add_argument("--protect", type=float, required=True)
    ap.add_argument("--tau", type=float, required=True)
    ap.add_argument("--iou-nms", type=float, default=0.7, help="Ultralytics predict default, as evaluated")
    ap.add_argument("--reference", default=str(SAFEMINE / "paper_results/stage2/s2_ratio1_s0/raw_preds_test.json"))
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    data = Path(args.data)
    imgsz = args.imgsz if "x" in args.imgsz else int(args.imgsz)
    base = OnnxDetector(weights=args.detector_onnx, conf=args.c0, iou=args.iou_nms, imgsz=imgsz,
                        names=["Landmine"])
    ver = OnnxVerifier(args.verifier_onnx)
    two = VerifiedDetector(base, ver, c0=args.c0, protect=args.protect, tau=args.tau)

    ref = reference_kept(json.loads(Path(args.reference).read_text(encoding="utf-8")),
                         args.c0, args.protect, args.tau)

    names = sorted(f for f in os.listdir(data / "images") if f.lower().endswith((".jpg", ".jpeg", ".png")))
    tot = {"tp": 0, "fp": 0, "fn": 0, "ref_tp": 0, "ref_fp": 0, "ref_fn": 0,
           "ref_boxes": 0, "ref_boxes_reproduced": 0, "replay_boxes": 0, "verified": 0, "vetoed": 0}
    det_ms, ver_ms, per_image = [], [], []
    for n in names:
        img = cv2.imread(str(data / "images" / n))
        h, w = img.shape[:2]
        gt = read_gt(data / "labels" / (os.path.splitext(n)[0] + ".txt"), w, h)
        kept = two.detect(img)
        t = two.last_timing
        det_ms.append(t["detect_ms"]); ver_ms.append(t["verify_ms"])
        tot["verified"] += t["n_verified"]; tot["vetoed"] += t["n_vetoed"]
        boxes = [[d.x1, d.y1, d.x2, d.y2] for d in kept]
        tp, fp, fn = match(gt, boxes, [d.confidence for d in kept])
        tot["tp"] += tp; tot["fp"] += fp; tot["fn"] += fn; tot["replay_boxes"] += len(boxes)

        rk = ref.get(n, [])
        rtp, rfp, rfn = match(gt, [d["box"] for d in rk], [d["conf"] for d in rk])
        tot["ref_tp"] += rtp; tot["ref_fp"] += rfp; tot["ref_fn"] += rfn
        tot["ref_boxes"] += len(rk)
        used = set()
        for d in rk:
            for i, b in enumerate(boxes):
                if i not in used and iou(d["box"], b) >= 0.5:
                    used.add(i); tot["ref_boxes_reproduced"] += 1
                    break
        per_image.append({"name": n, "replay_kept": len(boxes), "reference_kept": len(rk),
                          "tp": tp, "fp": fp, "fn": fn})

    n_img = len(names)
    prec = lambda tp, fp: tp / (tp + fp) if tp + fp else 0.0
    rec = lambda tp, fn: tp / (tp + fn) if tp + fn else 0.0
    res = {
        "script": "scripts/replay_twostage.py", "kind": "host replay (laptop CPU, onnx backends), not a device run",
        "data": str(data), "n_images": n_img,
        "detector_onnx": os.path.basename(args.detector_onnx), "detector_sha256": sha256(args.detector_onnx),
        "verifier_onnx": os.path.basename(args.verifier_onnx), "verifier_sha256": sha256(args.verifier_onnx),
        "imgsz": args.imgsz, "c0": args.c0, "protect": args.protect, "tau": args.tau, "iou_nms": args.iou_nms,
        "replay": {"tp": tot["tp"], "fp": tot["fp"], "fn": tot["fn"],
                   "precision": prec(tot["tp"], tot["fp"]), "recall": rec(tot["tp"], tot["fn"]),
                   "fp_per_image": tot["fp"] / n_img},
        "reference_evaluated_pipeline": {"tp": tot["ref_tp"], "fp": tot["ref_fp"], "fn": tot["ref_fn"],
                                         "precision": prec(tot["ref_tp"], tot["ref_fp"]),
                                         "recall": rec(tot["ref_tp"], tot["ref_fn"]),
                                         "fp_per_image": tot["ref_fp"] / n_img},
        "agreement": {"reference_boxes": tot["ref_boxes"], "replay_boxes": tot["replay_boxes"],
                      "reference_boxes_reproduced_iou50": tot["ref_boxes_reproduced"],
                      "fraction_reproduced": tot["ref_boxes_reproduced"] / max(1, tot["ref_boxes"]),
                      "images_same_kept_count": sum(1 for p in per_image if p["replay_kept"] == p["reference_kept"])},
        "verifier_activity": {"crops_scored": tot["verified"], "vetoed": tot["vetoed"],
                              "crops_per_image_mean": tot["verified"] / n_img},
        "timing_cpu_ms_note": "wall time per image on the laptop CPU (OpenCV DNN detector, onnxruntime verifier); "
                              "includes first-call warm-up; not a device measurement",
        "timing_cpu_ms": {"detect_median": float(np.median(det_ms)), "verify_median": float(np.median(ver_ms)),
                          "detect_p95": float(np.percentile(det_ms, 95)), "verify_p95": float(np.percentile(ver_ms, 95))},
        "per_image": per_image,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in res.items() if k != "per_image"}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
