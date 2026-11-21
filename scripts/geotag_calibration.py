#!/usr/bin/env python3
"""Monte Carlo check of the geotag error budget in jetson/geo.py (no hardware).

pixel_to_latlon() reports horizontal_error_m: GNSS, relative-altitude, heading and
box-centre errors combined in quadrature. Each term is a 1-sigma *radial* (2-D RMS)
figure, so the budget is a radial RMS. This script asks whether that closed form matches
the full non-linear projection when the inputs are actually perturbed by those amounts:

  truth   : drone at a known fix, altitude h, heading; a mine at a random pixel
  measured: fix + 2-D Gaussian GNSS error (radial RMS = gps_error_m),
            altitude x (1 + N(0, alt_rel_error)), heading + N(0, heading_error_deg),
            pixel + 2-D Gaussian jitter (radial RMS = centroid_error_px)
  error   : ground distance between the projected and the true mine position

Reported per altitude: empirical radial RMS vs the mean predicted value (ratio ~1 means the
budget is calibrated), and the share of errors within 1x and 2x the predicted value (a
circular 2-D Gaussian gives 63 % and 98 %). This validates the propagation, not the input
sigmas themselves: those need field data (RTK ground truth).

    python scripts/geotag_calibration.py --out results/geotag_calibration.json
"""
import argparse
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "jetson"))
import geo  # noqa: E402


class Fix(object):
    def __init__(self, lat, lon, rel_alt_m, heading_deg):
        self.lat, self.lon, self.rel_alt_m, self.heading_deg = lat, lon, rel_alt_m, heading_deg


def metres(lat1, lon1, lat2, lon2):
    n = (lat2 - lat1) * geo.METRES_PER_DEG_LAT
    e = (lon2 - lon1) * geo.METRES_PER_DEG_LAT * math.cos(math.radians(lat1))
    return math.hypot(n, e)


def run(cam, alt, n, rng, gps, alt_rel, hdg, cpx):
    lat0, lon0 = 12.97, 77.59
    err, pred = np.empty(n), np.empty(n)
    for i in range(n):
        heading = rng.uniform(0, 360)
        px, py = rng.uniform(0, cam.image_width), rng.uniform(0, cam.image_height)
        true = geo.pixel_to_latlon(cam, Fix(lat0, lon0, alt, heading), px, py)
        g = rng.normal(0, gps / math.sqrt(2), 2)          # radial RMS = gps
        lat_m, lon_m = geo.offset_to_latlon(lat0, lon0, g[0], g[1])
        fix = Fix(lat_m, lon_m, alt * (1 + rng.normal(0, alt_rel)), heading + rng.normal(0, hdg))
        j = rng.normal(0, cpx / math.sqrt(2), 2)
        est = geo.pixel_to_latlon(cam, fix, px + j[0], py + j[1], gps_error_m=gps, alt_rel_error=alt_rel,
                                  heading_error_deg=hdg, centroid_error_px=cpx)
        err[i] = metres(true.lat, true.lon, est.lat, est.lon)
        pred[i] = est.horizontal_error_m
    return err, pred


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    cam = geo.CameraModel(62.2, 1280, 720)      # AeroShield camera (geo.py CLI defaults)
    rng = np.random.default_rng(args.seed)
    d = dict(gps=geo.DEFAULT_GPS_ERROR_M, alt_rel=geo.DEFAULT_ALT_REL_ERROR,
             hdg=geo.DEFAULT_HEADING_ERROR_DEG, cpx=geo.DEFAULT_CENTROID_ERROR_PX)
    rows = []
    # sanity: no input error -> no position error
    e0, _ = run(cam, 10.0, 200, rng, 0.0, 0.0, 0.0, 0.0)
    assert e0.max() < 1e-6, e0.max()
    for alt in (3, 5, 10, 20, 30):
        err, pred = run(cam, float(alt), args.n, rng, **d)
        rms = float(np.sqrt(np.mean(err ** 2)))
        pr = float(np.sqrt(np.mean(pred ** 2)))
        rows.append({"altitude_m": alt, "gsd_cm_per_px": 100 * geo.ground_sample_distance(cam, alt),
                     "empirical_rms_m": rms, "predicted_rms_m": pr, "ratio_empirical_over_predicted": rms / pr,
                     "within_1x_predicted": float(np.mean(err <= pred)),
                     "within_2x_predicted": float(np.mean(err <= 2 * pred)),
                     "predicted_median_m": float(np.median(pred)), "empirical_p95_m": float(np.percentile(err, 95))})
    # GNSS-free budget (e.g. RTK): the geometric terms alone
    err, pred = run(cam, 10.0, args.n, rng, gps=0.02, alt_rel=d["alt_rel"], hdg=d["hdg"], cpx=d["cpx"])
    rtk = {"altitude_m": 10, "gps_error_m": 0.02, "empirical_rms_m": float(np.sqrt(np.mean(err ** 2))),
           "predicted_rms_m": float(np.sqrt(np.mean(pred ** 2))), "within_1x_predicted": float(np.mean(err <= pred)),
           "within_2x_predicted": float(np.mean(err <= 2 * pred))}
    res = {"script": "scripts/geotag_calibration.py", "camera": {"hfov_deg": 62.2, "w": 1280, "h": 720},
           "sigmas": d, "n_per_altitude": args.n, "rows": rows, "rtk_like": rtk,
           "reference_circular_gaussian": {"within_1x_rms": 0.632, "within_2x_rms": 0.982}}
    print(json.dumps(res, indent=1))
    if args.out:
        with open(args.out, "w") as fh:
            json.dump(res, fh, indent=1)


if __name__ == "__main__":
    main()
