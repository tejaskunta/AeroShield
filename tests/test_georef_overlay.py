"""scripts/georef_overlay.py - pin a drone photo to the survey block.

Synthetic, so it needs no photo and no drone: a known 'ground' (a 1 m checkerboard
with a red disc) is projected into a 'photo' through a known rotated, tilted
perspective, and the script must recover the ground from that photo. Pinned:

  - the fitted mapping reproduces the true one,
  - the warped overlay is north-up and lands each metre cell where the grid has it,
  - the stored bounds use the same metre->degree formula as frontend/src/lib/geo.ts,
  - an extra marker measures a mis-click instead of hiding it.

Runs under pytest, or directly:  python tests/test_georef_overlay.py
"""
import importlib.util
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    "georef_overlay", os.path.join(HERE, "..", "scripts", "georef_overlay.py"))
geo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(geo)

SIZE = 10.0
CORNERS_M = np.array([(0, 0), (SIZE, 0), (SIZE, SIZE), (0, SIZE)], float)
DISC = (2.5, 7.5)   # centre of the red disc, block metres
DISC_R = 0.35


def true_h():
    """Ground metres -> photo pixels: 25 deg yaw, ~90 px/m, a little perspective."""
    a = math.radians(25)
    s = 90.0
    # north is up in the ground frame, image y grows downward
    k = np.array([[s * math.cos(a), s * math.sin(a), 300.0],
                  [s * math.sin(a), -s * math.cos(a), 1150.0],
                  [0.004, -0.003, 1.0]])
    return k / k[2, 2]


def ground_colour(e, n):
    """1 m checkerboard (black/white), red disc at DISC. Vectorised."""
    cell = (np.floor(e) + np.floor(n)) % 2
    rgb = np.where(cell[..., None] == 0, 30, 225).astype(np.uint8) * np.ones(3, np.uint8)
    disc = (e - DISC[0]) ** 2 + (n - DISC[1]) ** 2 < DISC_R ** 2
    rgb[disc] = (230, 20, 20)
    return rgb


def render_photo(h, w=1900, hgt=1700):
    ys, xs = np.mgrid[0:hgt, 0:w]
    px = np.c_[xs.ravel(), ys.ravel()].astype(float)
    g = geo.ground_from_pixel(h, px)
    img = ground_colour(g[:, 0], g[:, 1]).reshape(hgt, w, 3)
    return img


def test_fit_recovers_true_mapping():
    h = true_h()
    px = geo.apply_h(h, CORNERS_M)
    fit = geo.fit_homography(CORNERS_M, px)
    probe = np.array([[1.3, 8.7], [5.0, 5.0], [9.1, 0.4]])
    assert np.allclose(geo.apply_h(fit, probe), geo.apply_h(h, probe), atol=1e-6)


def test_bounds_match_frontend_formula():
    origin = (17.396947, 78.490706)
    lat, lon = geo.offset_m(origin, 10.0, 10.0)
    # frontend geo.ts: lat + n / (R*pi/180), lon + e / (R*pi/180*cos(lat0))
    m = 6_371_000 * math.pi / 180
    assert abs(lat - (origin[0] + 10 / m)) < 1e-12
    assert abs(lon - (origin[1] + 10 / (m * math.cos(math.radians(origin[0]))))) < 1e-12


def test_extra_marker_measures_a_misclick():
    h = true_h()
    px = geo.apply_h(h, CORNERS_M)
    centre_true = geo.apply_h(h, np.array([[5.0, 5.0]]))[0]
    # NE corner clicked 30 px off. An edge midpoint between two *correct* corners
    # would barely move (that edge is still pinned at both ends), so the check
    # marker is the block centre, which every corner influences.
    bad = px.copy()
    bad[2] += (30, 0)
    h4 = geo.fit_homography(CORNERS_M, bad)
    miss = geo.ground_from_pixel(h4, np.array([centre_true])) - np.array([[5.0, 5.0]])
    assert np.linalg.norm(miss) > 0.05  # > 5 cm: visible, not hidden by an exact fit


def test_overlay_is_north_up_and_registered():
    try:
        import cv2  # noqa: F401
    except ImportError:
        import pytest
        pytest.skip("OpenCV not installed in this interpreter")
    h = true_h()
    photo = render_photo(h)
    corners_px = geo.apply_h(h, CORNERS_M)
    fit = geo.fit_homography(CORNERS_M, corners_px)
    res_cm, margin = 2.0, 1.0
    rgba = geo.warp_overlay(photo, fit, SIZE, margin, res_cm)
    res = res_cm / 100

    def at(e, n):
        u = int((e + margin) / res)
        v = int((SIZE + margin - n) / res)
        return rgba[v, u]

    # every metre cell centre has the checker parity the ground has
    wrong = 0
    for i in range(10):
        for j in range(10):
            e, n = i + 0.5, j + 0.5
            if (i, j) == (2, 7):  # the disc's cell
                continue
            expect_dark = (i + j) % 2 == 0
            got = at(e, n)
            assert got[3] == 255, f"cell {i},{j} is off the photo"
            if (got[0] < 128) != expect_dark:
                wrong += 1
    assert wrong == 0, f"{wrong} cells have the wrong parity - overlay is not registered"
    # the red disc is where the grid says it is (catches a flipped or rotated warp)
    r, g, b, _ = at(*DISC)
    assert r > 180 and g < 80 and b < 80, (r, g, b)


def test_gsd_estimate():
    h = true_h()
    gsd = geo.photo_gsd_cm(h, SIZE)
    assert 0.8 < gsd < 1.6  # ~90 px per metre, softened by the perspective term


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {exc!r}")
    sys.exit(1 if failed else 0)
