#!/usr/bin/env python3
"""Pin a straight-down drone photo of the survey block to the dashboard map.

WHY
---
No satellite or aerial provider has real pixels past zoom 20 over the KMIT block
(measured: Esri, its Wayback archive, Bing and Google; see GOOGLE_MAX_NATIVE_ZOOM in
frontend/src/lib/config.ts). Zoom 22 is ~3.6 cm per pixel there and 23 is ~1.8 cm,
so the only imagery that is sharp at the zoom an operator needs to see a drone-sized
object is a photo the drone takes itself. This script turns one such photo into a
north-up overlay the map draws under the grid (DroneImageryLayer.tsx).

HOW IT IS PINNED
----------------
By markers on the block's four corners, not by GPS. The dashboard's grid is defined
from those corners (VITE_SURVEY_ORIGIN = the SW corner, 10 m x 10 m), so pinning the
photo to the same physical points puts the photo and the grid in agreement to a few
centimetres. The drone's GPS is good to 2.5-3 m, which would visibly misplace the
photo against a one-metre grid.

USAGE
-----
  # click the four corner markers in a window, in order SW, SE, NE, NW
  python scripts/georef_overlay.py --image block.jpg --click

  # or give their pixel positions (x,y) directly, same order
  python scripts/georef_overlay.py --image block.jpg \\
      --corners 412,880 1630,905 1598,140 380,118

  # an extra marker at a known block position turns on a real error check.
  # The block centre is the best one: every corner influences it, whereas an edge
  # midpoint sits between two corners and barely notices a mis-click elsewhere.
  python scripts/georef_overlay.py --image block.jpg --click --extra 5,5:1010,512

Then reload the dashboard. Output: frontend/public/overlay/block.webp + block.json.

ABOUT THE ERROR NUMBER
----------------------
Four points determine a perspective mapping exactly, so with only the corners the
fit "error" is always zero and proves nothing. It is reported as unchecked rather
than as a reassuring 0 cm. Each --extra marker is held to the fitted mapping and the
RMS miss is reported (and stored in block.json), which is the honest check on a
mis-clicked corner or a photo taken far from straight down.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from datetime import datetime, timezone

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO, "frontend", "public", "overlay")
DEFAULT_ORIGIN = (17.396947, 78.490706)

# Must equal frontend/src/lib/geo.ts, or the overlay and the grid disagree.
EARTH_RADIUS_M = 6_371_000.0
M_PER_DEG_LAT = EARTH_RADIUS_M * math.pi / 180.0


def m_per_deg_lon(lat: float) -> float:
    return M_PER_DEG_LAT * math.cos(math.radians(lat))


def offset_m(origin: tuple[float, float], east: float, north: float) -> tuple[float, float]:
    """Same formula as offsetM in frontend/src/lib/geo.ts."""
    lat0, lon0 = origin
    return lat0 + north / M_PER_DEG_LAT, lon0 + east / m_per_deg_lon(lat0)


def web_mercator_m_per_px(zoom: float, lat: float) -> float:
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** zoom)


def read_origin_from_env() -> tuple[float, float] | None:
    """VITE_SURVEY_ORIGIN as Vite reads it: .env.local over .env, quotes allowed."""
    pat = re.compile(r"""\s*VITE_SURVEY_ORIGIN\s*=\s*['"]?\s*([-\d.]+)\s*,\s*([-\d.]+)\s*['"]?""")
    for name in (".env.local", ".env"):
        env = os.path.join(REPO, "frontend", name)
        try:
            with open(env, encoding="utf-8") as f:
                for line in f:
                    m = pat.match(line)
                    if m:
                        return float(m.group(1)), float(m.group(2))
        except OSError:
            continue
    return None


def parse_xy(s: str) -> tuple[float, float]:
    x, y = s.split(",")
    return float(x), float(y)


def parse_extra(s: str) -> tuple[tuple[float, float], tuple[float, float]]:
    """'E,N:x,y' -> ((east_m, north_m), (px_x, px_y))."""
    ground, pixel = s.split(":")
    return parse_xy(ground), parse_xy(pixel)


def fit_homography(ground_m: np.ndarray, pixels: np.ndarray) -> np.ndarray:
    """3x3 H mapping ground metres (east, north) -> photo pixels, least squares (DLT).

    Plain numpy so the core maths has no OpenCV dependency and can be unit-tested.
    Normalised first (Hartley), which matters: metres are ~0-10 and pixels ~0-4000,
    and an unnormalised DLT over that range is badly conditioned.
    """
    def normaliser(pts: np.ndarray) -> np.ndarray:
        c = pts.mean(axis=0)
        d = np.sqrt(((pts - c) ** 2).sum(axis=1)).mean() or 1.0
        s = math.sqrt(2) / d
        return np.array([[s, 0, -s * c[0]], [0, s, -s * c[1]], [0, 0, 1]])

    tg, tp = normaliser(ground_m), normaliser(pixels)
    g = (tg @ np.c_[ground_m, np.ones(len(ground_m))].T).T
    p = (tp @ np.c_[pixels, np.ones(len(pixels))].T).T
    rows = []
    for (X, Y, _), (u, v, _) in zip(g, p):
        rows.append([-X, -Y, -1, 0, 0, 0, u * X, u * Y, u])
        rows.append([0, 0, 0, -X, -Y, -1, v * X, v * Y, v])
    _, _, vt = np.linalg.svd(np.asarray(rows))
    hn = vt[-1].reshape(3, 3)
    h = np.linalg.inv(tp) @ hn @ tg
    return h / h[2, 2]


def apply_h(h: np.ndarray, pts: np.ndarray) -> np.ndarray:
    q = (h @ np.c_[pts, np.ones(len(pts))].T).T
    return q[:, :2] / q[:, 2:3]


def ground_from_pixel(h: np.ndarray, px: np.ndarray) -> np.ndarray:
    return apply_h(np.linalg.inv(h), px)


def photo_gsd_cm(h: np.ndarray, size_m: float) -> float:
    """Mean ground size of one photo pixel over the block, in cm."""
    c = size_m / 2.0
    a = apply_h(h, np.array([[c, c], [c + 1.0, c], [c, c + 1.0]]))
    px_per_m = (np.linalg.norm(a[1] - a[0]) + np.linalg.norm(a[2] - a[0])) / 2.0
    return 100.0 / px_per_m


def warp_overlay(photo_rgb: np.ndarray, h: np.ndarray, size_m: float, margin_m: float,
                 cm_per_px: float) -> np.ndarray:
    """North-up RGBA raster over [-margin, size+margin]^2 metres; transparent off-photo."""
    import cv2

    res = cm_per_px / 100.0
    span = size_m + 2 * margin_m
    w = h_px = int(round(span / res))
    # Output pixel (u, v) -> ground metres: east = -margin + u*res, north = size+margin - v*res
    a = np.array([[res, 0.0, -margin_m], [0.0, -res, size_m + margin_m], [0.0, 0.0, 1.0]])
    m = h @ a  # output pixel -> photo pixel
    rgb = cv2.warpPerspective(photo_rgb, m, (w, h_px), flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    mask = np.full(photo_rgb.shape[:2], 255, np.uint8)
    alpha = cv2.warpPerspective(mask, m, (w, h_px), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                                borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return np.dstack([rgb, alpha])


def click_corners(path: str) -> list[tuple[float, float]]:
    import cv2

    img = cv2.imread(path)
    if img is None:
        sys.exit(f"cannot read {path}")
    names = ["SW", "SE", "NE", "NW"]
    scale = min(1.0, 1400 / img.shape[1], 900 / img.shape[0])
    view = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    pts: list[tuple[float, float]] = []

    def redraw():
        v = view.copy()
        for i, (x, y) in enumerate(pts):
            cv2.drawMarker(v, (int(x * scale), int(y * scale)), (0, 0, 255), cv2.MARKER_CROSS, 24, 2)
            cv2.putText(v, names[i], (int(x * scale) + 8, int(y * scale) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        msg = f"click the {names[len(pts)]} corner marker" if len(pts) < 4 else "Enter = accept, Backspace = undo"
        cv2.putText(v, msg, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        cv2.imshow("georef", v)

    def on_mouse(event, x, y, *_):
        if event == cv2.EVENT_LBUTTONDOWN and len(pts) < 4:
            pts.append((x / scale, y / scale))
            redraw()

    cv2.namedWindow("georef")
    cv2.setMouseCallback("georef", on_mouse)
    redraw()
    while True:
        k = cv2.waitKey(30) & 0xFF
        if k in (13, 10) and len(pts) == 4:
            break
        if k == 8 and pts:
            pts.pop()
            redraw()
        if k == 27:
            sys.exit("cancelled")
    cv2.destroyAllWindows()
    return pts


def captured_at_of(path: str, override: str | None) -> str:
    if override:
        return override
    try:
        from PIL import Image
        exif = Image.open(path).getexif()
        raw = exif.get(36867) or exif.get(306)  # DateTimeOriginal, DateTime
        if raw:
            return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S").astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", required=True, help="straight-down photo of the block")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--corners", nargs=4, metavar="X,Y", help="pixel positions of SW SE NE NW markers")
    g.add_argument("--click", action="store_true", help="click the four markers in a window")
    ap.add_argument("--extra", action="append", default=[], metavar="E,N:X,Y",
                    help="extra marker at block metres E,N seen at pixel X,Y (repeatable)")
    ap.add_argument("--origin", help="survey SW corner lat,lon (default: VITE_SURVEY_ORIGIN)")
    ap.add_argument("--size-m", type=float, default=10.0, help="block side in metres")
    ap.add_argument("--margin-m", type=float, default=4.0, help="photo kept around the block")
    ap.add_argument("--cm-per-px", type=float, default=1.5, help="output resolution")
    ap.add_argument("--captured-at", help="ISO time the photo was taken (default: EXIF, then file time)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    import cv2

    origin = parse_xy(args.origin) if args.origin else read_origin_from_env()
    if origin is None:
        # Said loudly: pinning to the wrong origin puts the photo off the grid while
        # every other line of output still reads as success.
        print("WARNING  : VITE_SURVEY_ORIGIN not found in frontend/.env.local or .env; "
              "using the built-in default {0}. Pass --origin lat,lon if that is wrong.".format(DEFAULT_ORIGIN))
        origin = DEFAULT_ORIGIN
    corners_px = click_corners(args.image) if args.click else [parse_xy(c) for c in args.corners]
    s = args.size_m
    ground = [(0.0, 0.0), (s, 0.0), (s, s), (0.0, s)]
    pixels = list(corners_px)
    extras = [parse_extra(e) for e in args.extra]

    h = fit_homography(np.array(ground + [e[0] for e in extras]),
                       np.array(pixels + [e[1] for e in extras]))

    rms_cm = None
    if extras:
        # Hold each extra marker to a fit made WITHOUT it, so it is a real check.
        h4 = fit_homography(np.array(ground), np.array(pixels))
        miss = ground_from_pixel(h4, np.array([e[1] for e in extras])) - np.array([e[0] for e in extras])
        rms_cm = float(np.sqrt((miss ** 2).sum(axis=1).mean()) * 100.0)

    bgr = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if bgr is None:
        sys.exit(f"cannot read {args.image}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    gsd = photo_gsd_cm(h, s)
    lat = origin[0]
    real_to = max(z for z in range(15, 26) if web_mercator_m_per_px(z, lat) * 100.0 >= gsd * 0.9)

    rgba = warp_overlay(rgb, h, s, args.margin_m, args.cm_per_px)

    os.makedirs(args.out, exist_ok=True)
    from PIL import Image
    img_path = os.path.join(args.out, "block.webp")
    Image.fromarray(rgba, "RGBA").save(img_path, "WEBP", quality=90, method=6)

    sw = offset_m(origin, -args.margin_m, -args.margin_m)
    ne = offset_m(origin, s + args.margin_m, s + args.margin_m)
    meta = {
        "image": "block.webp",
        "bounds": [[round(sw[0], 9), round(sw[1], 9)], [round(ne[0], 9), round(ne[1], 9)]],
        "capturedAt": captured_at_of(args.image, args.captured_at),
        "cmPerPx": args.cm_per_px,
        "photoGsdCm": round(gsd, 2),
        "rmsErrorCm": None if rms_cm is None else round(rms_cm, 1),
        "origin": list(origin),
        "sizeM": s,
        "marginM": args.margin_m,
        "source": os.path.basename(args.image),
    }
    with open(os.path.join(args.out, "block.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(f"overlay  : {img_path}  ({rgba.shape[1]}x{rgba.shape[0]} px, {args.cm_per_px} cm/px)")
    print(f"bounds   : SW {meta['bounds'][0]}  NE {meta['bounds'][1]}")
    print(f"photo    : ~{gsd:.1f} cm per pixel over the block -> real detail to about z{real_to}")
    if gsd > args.cm_per_px * 1.5:
        print(f"           (output is finer than the photo; fly lower for sharper z22-23)")
    if rms_cm is None:
        print("check    : UNCHECKED - four corners fit exactly by construction. Add an --extra marker")
        print("           (best: a marker at the block centre, --extra 5,5:X,Y) to measure the pin error.")
    else:
        flag = "OK" if rms_cm <= 10 else "HIGH - re-click the corners or retake the photo straight down"
        print(f"check    : extra markers miss by {rms_cm:.1f} cm RMS  [{flag}]")
    print("next     : reload the dashboard; 'Drone photo' appears under Layers.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
