#!/usr/bin/env python3
"""Per-stage latency of the two-stage path on the host CPU (ONNX Runtime). Not a device run.

Times, on one preloaded test frame, with warm-up excluded:
  * detector forward (ONNX Runtime, CPU) at 640x640 and 512x288
  * the onboard detector class end to end (OnnxDetector: resize/letterbox, forward, NMS)
  * crop extraction for the borderline boxes (jetson/verifier.extract_crops)
  * verifier forward at batch 1, 2 and 4 (ONNX Runtime, CPU)
and the verifier's added time per frame at the measured mean number of crops per frame
(host replay, results/host_replay_twostage/seed0_640.json).

ONNX Runtime is limited to --threads intra-op threads (default 4) as a stand-in for a
small CPU budget; the numbers are laptop numbers and are labelled as such.

    python scripts/latency_host.py --out results/latency_host.json
"""
import argparse
import json
import os
import statistics
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "jetson"))
from detector import OnnxDetector  # noqa: E402
from verifier import extract_crops, preprocess  # noqa: E402

SM = os.path.join(HERE, "..", "..", "SafeMineAI-main", "models")
DATA = r"C:\Users\Delta\Downloads\Landmine_project\Datasets\landmine_combined_v2\test\images"


def timeit(fn, warm, reps):
    for _ in range(warm):
        fn()
    ts = []
    for _ in range(reps):
        t = time.perf_counter()
        fn()
        ts.append((time.perf_counter() - t) * 1000.0)
    q = statistics.quantiles(ts, n=4)
    return {"median_ms": statistics.median(ts), "p25_ms": q[0], "p75_ms": q[2], "reps": reps}


def session(path, threads):
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    return ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--warm", type=int, default=10)
    ap.add_argument("--reps", type=int, default=200)
    ap.add_argument("--image", default="ds0_0109.jpg")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    name = args.image if os.path.exists(os.path.join(DATA, args.image)) else sorted(os.listdir(DATA))[0]
    frame = cv2.imread(os.path.join(DATA, name))
    h, w = frame.shape[:2]
    res = {"script": "scripts/latency_host.py", "kind": "host CPU (laptop), ONNX Runtime; not a device run",
           "cpu_threads": args.threads, "onnxruntime": ort.__version__, "frame": name, "frame_size": [w, h]}

    det = {}
    for tag, f, shape in (("640x640", "yolo_s_seed0/last_640.onnx", (1, 3, 640, 640)),
                          ("512x288", "yolo_s_seed0/last_512x288.onnx", (1, 3, 288, 512))):
        s = session(os.path.join(SM, f), args.threads)
        x = np.random.default_rng(0).random(shape, dtype=np.float32)
        inp = s.get_inputs()[0].name
        det[tag] = timeit(lambda: s.run(None, {inp: x}), args.warm, args.reps)
    res["detector_forward"] = det

    od = OnnxDetector(weights=os.path.join(SM, "yolo_s_seed0/last_640.onnx"), conf=0.02, imgsz=640)
    res["onboard_detector_class_640"] = timeit(lambda: od.detect(frame), args.warm, max(50, args.reps // 4))
    res["onboard_detector_class_note"] = "OnnxDetector (OpenCV DNN backend) incl. pre-processing and NMS"

    boxes = [(w * 0.30, h * 0.30, w * 0.36, h * 0.36), (w * 0.60, h * 0.55, w * 0.65, h * 0.61),
             (w * 0.10, h * 0.70, w * 0.16, h * 0.77), (w * 0.80, h * 0.20, w * 0.85, h * 0.26)]
    res["crop_extraction_2_boxes"] = timeit(lambda: extract_crops(frame, boxes[:2]), args.warm, args.reps)

    vs = session(os.path.join(SM, "stage2_s0/verifier.onnx"), args.threads)
    vin = vs.get_inputs()[0].name
    ver = {}
    for b in (1, 2, 4):
        x = preprocess(extract_crops(frame, boxes[:b]))
        ver[f"batch_{b}"] = timeit(lambda: vs.run(None, {vin: x}), args.warm, args.reps)
    res["verifier_forward"] = ver

    rp = os.path.join(HERE, "..", "results", "host_replay_twostage", "seed0_640.json")
    crops_per_frame = None
    if os.path.exists(rp):
        with open(rp) as fh:
            r = json.load(fh)
        crops_per_frame = r.get("verifier_activity", {}).get("crops_per_image_mean")
    crops_per_frame = crops_per_frame or 1.68
    # cost per frame = crop extraction + one verifier call at the mean batch (interpolated)
    v1, v2 = ver["batch_1"]["median_ms"], ver["batch_2"]["median_ms"]
    per_call = v1 + (v2 - v1) * max(0.0, min(1.0, crops_per_frame - 1.0))
    added = res["crop_extraction_2_boxes"]["median_ms"] + per_call
    res["verifier_added_ms_per_frame"] = {"crops_per_frame": crops_per_frame, "ms": added,
                                          "share_of_detector_640": added / det["640x640"]["median_ms"],
                                          "note": "upper bound: frames with no borderline box skip the verifier"}
    print(json.dumps(res, indent=1))
    if args.out:
        with open(args.out, "w") as fh:
            json.dump(res, fh, indent=1)


if __name__ == "__main__":
    main()
