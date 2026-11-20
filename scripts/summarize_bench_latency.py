#!/usr/bin/env python3
"""Summarise the on-device inference times logged during earlier Jetson bench runs.

Reads the detection logs archived from the drone (drone-data/, logs are
git-ignored because of their size and image paths) and writes a small committed
summary: results/bench_latency_legacy.json.

What the numbers are, and are not:
  * `inference_ms` is the wall time of detector.detect() (preprocess + TensorRT
    + postprocess) for the earlier single-stage YOLOv8m engine
    (best_512x288.engine, FP16), trained on the ORIGINAL (leaky) split;
  * it is logged only for frames that produced a detection, and a frame with
    several detections appears several times;
  * power mode, thermal state and engine hash were not recorded.
They are context for the paper, not a measurement of the evaluated models.

    python scripts/summarize_bench_latency.py
"""

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOG = REPO / "drone-data/aeroshield/jetson/logs/detections.jsonl"
OUT = REPO / "results/bench_latency_legacy.json"


def main():
    if not LOG.exists():
        print("missing", LOG, file=sys.stderr)
        return 1
    by_day = defaultdict(list)
    models = set()
    for line in LOG.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("source") != "jetson-trt" or r.get("inference_ms") is None:
            continue
        by_day[str(r.get("captured_at", ""))[:10]].append(float(r["inference_ms"]))
        models.add(r.get("model_version"))
    allv = [v for vs in by_day.values() for v in vs]
    res = {
        "script": "scripts/summarize_bench_latency.py",
        "source_log": str(LOG.relative_to(REPO)).replace("\\", "/"),
        "model_versions": sorted(m for m in models if m),
        "caveats": ["earlier single-stage YOLOv8m engine trained on the original (leaky) split",
                    "logged only on frames with a detection; multi-detection frames repeat",
                    "power mode, thermal state and engine hash not recorded"],
        "n_records": len(allv),
        "median_ms_all": statistics.median(allv) if allv else None,
        "by_day": {d: {"n": len(v), "median_ms": statistics.median(v)} for d, v in sorted(by_day.items())},
    }
    meds = [x["median_ms"] for x in res["by_day"].values()]
    res["daily_median_range_ms"] = [min(meds), max(meds)] if meds else None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res, indent=2), encoding="utf-8")
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
