#!/usr/bin/env python3
"""
AeroShield - geolocation: bounding-box pixels to lat/lon (Week 4).

A YOLO box is pixels. A detection report needs coordinates. This module is the
bridge, and it is the single largest source of error in the whole system, so it
reports its own error estimate alongside every position rather than pretending
to be exact (PRD section 10 asks for an honest error budget; docs/TRAINING_NOTES.md
has the table to paste it into).

Model: nadir-pointing camera (straight down), flat ground, pinhole optics.

    ground_width = 2 * altitude * tan(hfov / 2)
    gsd          = ground_width / image_width          metres per pixel
    forward/right offsets from image centre, rotated by heading -> North/East
    d_lat = north / 111320 ,  d_lon = east / (111320 * cos(lat))

Usage:
    from geo import CameraModel, pixel_to_latlon
    cam = CameraModel(hfov_deg=62.2, image_width=1280, image_height=720)
    pos = pixel_to_latlon(cam, fix, box_cx_px, box_cy_px)
    if pos is not None:
        print(pos.lat, pos.lon, pos.horizontal_error_m)

Every assumption here is a lie of some size:
  - the camera is never perfectly nadir (roll/pitch bleed straight into offset error)
  - the ground is never flat (a slope breaks the single-altitude GSD outright)
  - lens distortion is uncorrected (worst at frame edges, where it matters most)
So treat the output as "roughly here, plus or minus horizontal_error_m", which is
exactly how a safety system should be read.

PYTHON 3.6 ONLY - see the note at the top of infer_trt.py.
"""

import math
import sys
from typing import NamedTuple, Optional

# Metres per degree of latitude (WGS-84 mean). Good to ~0.1% for the
# sub-kilometre offsets a single frame can span.
METRES_PER_DEG_LAT = 111320.0

# --- default error contributions, all 1-sigma metres unless noted -------------
# Holybro M10, no RTK. PRD section 10 quotes 1-3 m; 2.5 is a fair middle.
DEFAULT_GPS_ERROR_M = 2.5
# Barometric relative altitude drifts; 5% of altitude is a realistic field figure.
DEFAULT_ALT_REL_ERROR = 0.05
# Compass error after a good calibration. Bad calibration is far worse, which is
# why the Week 1-2 checklist includes compass calibration on the ZD550.
DEFAULT_HEADING_ERROR_DEG = 5.0
# The box centroid itself wobbles frame to frame.
DEFAULT_CENTROID_ERROR_PX = 4.0


class CameraModel(NamedTuple):
    """Camera intrinsics, in the only form this projection needs.

    hfov_deg is the HORIZONTAL field of view of the lens actually in use. Get it
    from the datasheet, or calibrate it: put a tape measure in frame at a known
    height and solve for it. A guessed FOV is a systematic scale error on every
    single detection, and it will not show up as noise - it shows up as every
    position being wrong by the same factor.
    """

    hfov_deg: float
    image_width: int
    image_height: int
    vfov_deg: Optional[float] = None   # derived from aspect ratio when omitted

    def effective_vfov_deg(self) -> float:
        """Vertical FOV, derived via the pinhole relation when not supplied."""
        if self.vfov_deg is not None:
            return self.vfov_deg
        half_h = math.tan(math.radians(self.hfov_deg) / 2.0)
        aspect = float(self.image_height) / float(self.image_width)
        return 2.0 * math.degrees(math.atan(half_h * aspect))


class GeoPoint(NamedTuple):
    """A projected ground position, with the honesty attached."""

    lat: float
    lon: float
    gsd_m_per_px: float
    offset_m: float             # ground distance from the frame centre
    horizontal_error_m: float   # 1-sigma, RSS of the contributions below
    assumed_heading: bool       # True when heading was unknown and 0 was assumed


def ground_sample_distance(cam: CameraModel, altitude_m: float) -> float:
    """Metres per pixel at nadir. The scale factor for everything else here."""
    ground_width_m = 2.0 * altitude_m * math.tan(math.radians(cam.hfov_deg) / 2.0)
    return ground_width_m / float(cam.image_width)


def offset_to_latlon(lat: float, lon: float, north_m: float, east_m: float):
    """Flat-earth offset to lat/lon. Fine at these distances, wrong near the poles."""
    d_lat = north_m / METRES_PER_DEG_LAT
    # cos(lat) collapses at the poles; clamp so we degrade instead of dividing by zero.
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    d_lon = east_m / (METRES_PER_DEG_LAT * cos_lat)
    return lat + d_lat, lon + d_lon


def pixel_to_latlon(
    cam: CameraModel,
    fix,                                  # gps.GpsFix (duck-typed to avoid a circular import)
    px: float,
    py: float,
    altitude_m: Optional[float] = None,
    gps_error_m: float = DEFAULT_GPS_ERROR_M,
    alt_rel_error: float = DEFAULT_ALT_REL_ERROR,
    heading_error_deg: float = DEFAULT_HEADING_ERROR_DEG,
    centroid_error_px: float = DEFAULT_CENTROID_ERROR_PX,
) -> Optional[GeoPoint]:
    """Project one image pixel onto the ground.

    Returns None when the projection cannot be trusted at all - no fix, or a
    non-positive altitude (which would make GSD zero or negative and produce
    confident nonsense).
    """
    if fix is None:
        return None

    alt = altitude_m if altitude_m is not None else getattr(fix, "rel_alt_m", 0.0)
    if alt is None or alt <= 0.0:
        # On the ground, or a 2D fix with no usable altitude. Refuse rather than guess.
        return None

    gsd_x = ground_sample_distance(cam, alt)
    # Derive the vertical GSD independently: non-square pixels and a vfov that
    # isn't the aspect-scaled hfov both show up here.
    vfov = cam.effective_vfov_deg()
    ground_height_m = 2.0 * alt * math.tan(math.radians(vfov) / 2.0)
    gsd_y = ground_height_m / float(cam.image_height)

    # Offsets from the principal point (approximated as the image centre - a real
    # calibration would give the true one, and it is rarely dead centre).
    dx_px = px - cam.image_width / 2.0
    dy_px = py - cam.image_height / 2.0

    # Image y grows downward; the top of the frame is ahead of the drone.
    right_m = dx_px * gsd_x
    forward_m = -dy_px * gsd_y

    heading = getattr(fix, "heading_deg", None)
    assumed_heading = heading is None
    hdg_rad = math.radians(heading if heading is not None else 0.0)

    # Rotate body-frame (forward, right) into world-frame (north, east).
    north_m = forward_m * math.cos(hdg_rad) - right_m * math.sin(hdg_rad)
    east_m = forward_m * math.sin(hdg_rad) + right_m * math.cos(hdg_rad)

    lat, lon = offset_to_latlon(fix.lat, fix.lon, north_m, east_m)
    offset_m = math.hypot(north_m, east_m)

    # --- error budget (1-sigma, combined in quadrature) ----------------------
    # Altitude error scales the whole projection, so its effect grows with offset.
    err_alt = offset_m * alt_rel_error
    # Heading error swings the offset vector tangentially.
    if assumed_heading:
        # Direction is entirely unknown: the offset could point anywhere. Charge
        # the full offset as error instead of quietly pretending north.
        err_heading = offset_m
    else:
        err_heading = offset_m * math.sin(math.radians(heading_error_deg))
    # Centroid jitter, in ground units.
    err_centroid = centroid_error_px * max(gsd_x, gsd_y)

    horizontal_error_m = math.sqrt(
        gps_error_m ** 2 + err_alt ** 2 + err_heading ** 2 + err_centroid ** 2
    )

    return GeoPoint(
        lat=lat,
        lon=lon,
        gsd_m_per_px=gsd_x,
        offset_m=offset_m,
        horizontal_error_m=horizontal_error_m,
        assumed_heading=assumed_heading,
    )


def bbox_centre(x1: float, y1: float, x2: float, y2: float):
    """Centre of an xyxy box.

    The centre of the box, not the centre of the object: for anything sitting on a
    slope or seen off-nadir these differ. Noted as a known limitation rather than
    corrected, since correcting it needs a terrain model we do not have.
    """
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0


def bbox_to_latlon(cam: CameraModel, fix, x1: float, y1: float, x2: float, y2: float,
                   **kwargs) -> Optional[GeoPoint]:
    """Convenience wrapper: xyxy box straight to a ground position."""
    cx, cy = bbox_centre(x1, y1, x2, y2)
    return pixel_to_latlon(cam, fix, cx, cy, **kwargs)


def main() -> int:
    """Print an error budget for a given camera and altitude.

    Copy these numbers into the error-budget table in docs/TRAINING_NOTES.md -
    PRD section 10 wants a real total, not the GPS figure alone.

        python3 jetson/geo.py --hfov 62.2 --width 1280 --height 720 --alt 30
    """
    import argparse

    ap = argparse.ArgumentParser(
        description="AeroShield geolocation error budget.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--hfov", type=float, default=62.2, help="Horizontal FOV in degrees")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--alt", type=float, default=30.0, help="Altitude above ground, metres")
    ap.add_argument("--gps-error", type=float, default=DEFAULT_GPS_ERROR_M)
    args = ap.parse_args()

    cam = CameraModel(hfov_deg=args.hfov, image_width=args.width, image_height=args.height)
    gsd = ground_sample_distance(cam, args.alt)
    ground_w = gsd * args.width
    ground_h = (2.0 * args.alt * math.tan(math.radians(cam.effective_vfov_deg()) / 2.0))

    print("=" * 70)
    print("AeroShield geolocation - camera and error budget")
    print("=" * 70)
    print("  HFOV / VFOV      : {0:.1f} / {1:.1f} deg".format(args.hfov, cam.effective_vfov_deg()))
    print("  Frame            : {0} x {1} px".format(args.width, args.height))
    print("  Altitude (AGL)   : {0:.1f} m".format(args.alt))
    print("  GSD              : {0:.3f} m/px".format(gsd))
    print("  Ground footprint : {0:.1f} x {1:.1f} m".format(ground_w, ground_h))
    print("")

    # A fake fix at the frame centre, heading north.
    class _Fix(object):
        lat = 12.9716
        lon = 77.5946
        rel_alt_m = args.alt
        heading_deg = 0.0

    print("  Error vs. position in frame (1-sigma, metres):")
    print("  {0:<22} {1:>10} {2:>12}".format("pixel", "offset m", "error m"))
    corners = [
        ("centre", args.width / 2.0, args.height / 2.0),
        ("half-way to edge", args.width * 0.75, args.height / 2.0),
        ("frame edge (right)", float(args.width), args.height / 2.0),
        ("corner", float(args.width), float(args.height)),
    ]
    for label, px, py in corners:
        pos = pixel_to_latlon(cam, _Fix(), px, py, gps_error_m=args.gps_error)
        if pos is None:
            continue
        print("  {0:<22} {1:>10.1f} {2:>12.1f}".format(label, pos.offset_m, pos.horizontal_error_m))

    print("")
    print("  Contributions at the frame corner:")
    pos = pixel_to_latlon(cam, _Fix(), float(args.width), float(args.height),
                          gps_error_m=args.gps_error)
    if pos is not None:
        print("    GPS (Holybro M10)      {0:.2f} m".format(args.gps_error))
        print("    Altitude ({0:.0f}%)          {1:.2f} m".format(
            DEFAULT_ALT_REL_ERROR * 100, pos.offset_m * DEFAULT_ALT_REL_ERROR))
        print("    Heading ({0:.0f} deg)          {1:.2f} m".format(
            DEFAULT_HEADING_ERROR_DEG,
            pos.offset_m * math.sin(math.radians(DEFAULT_HEADING_ERROR_DEG))))
        print("    Centroid ({0:.0f} px)         {1:.2f} m".format(
            DEFAULT_CENTROID_ERROR_PX, DEFAULT_CENTROID_ERROR_PX * pos.gsd_m_per_px))
        print("    -----------------------------------")
        print("    Total (RSS)            {0:.2f} m".format(pos.horizontal_error_m))
    print("")
    print("  NOT included, because they need data we do not have:")
    print("    - terrain slope (the flat-ground assumption breaks outright on a hill)")
    print("    - camera roll/pitch away from nadir")
    print("    - lens distortion (worst exactly at the frame edges above)")
    print("  Report these as named limitations, not as zero.")
    print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
