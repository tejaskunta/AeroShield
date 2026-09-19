"""AeroShield - geolocation tests.

Hand-checkable numbers throughout. A 90-degree HFOV over a 1000 px frame at 100 m
altitude gives a 200 m footprint and a GSD of exactly 0.2 m/px, so every expected
value below can be verified with mental arithmetic rather than by trusting the code
that is under test.

This is the module that decides where a mine gets plotted, so the maths deserves
tests that a reader can independently confirm.
"""

import math

import pytest

from geo import (
    METRES_PER_DEG_LAT,
    CameraModel,
    bbox_centre,
    bbox_to_latlon,
    ground_sample_distance,
    offset_to_latlon,
    pixel_to_latlon,
)


class FakeFix:
    """Minimal stand-in for gps.GpsFix - pixel_to_latlon duck-types its input."""

    def __init__(self, lat=0.0, lon=0.0, rel_alt_m=100.0, heading_deg=0.0):
        self.lat = lat
        self.lon = lon
        self.rel_alt_m = rel_alt_m
        self.heading_deg = heading_deg


# 90 deg HFOV, square 1000 px frame: tan(45) == 1, so the arithmetic is exact.
CAM = CameraModel(hfov_deg=90.0, image_width=1000, image_height=1000)
CENTRE = 500.0


class TestGroundSampleDistance:
    def test_gsd_is_exact_for_90_degree_fov(self):
        # footprint = 2 * 100 * tan(45) = 200 m over 1000 px
        assert ground_sample_distance(CAM, 100.0) == pytest.approx(0.2)

    def test_gsd_scales_linearly_with_altitude(self):
        """Twice the altitude, twice the ground covered per pixel."""
        low = ground_sample_distance(CAM, 50.0)
        high = ground_sample_distance(CAM, 100.0)
        assert high == pytest.approx(2 * low)

    def test_vfov_derived_from_aspect_ratio(self):
        square = CameraModel(hfov_deg=90.0, image_width=1000, image_height=1000)
        assert square.effective_vfov_deg() == pytest.approx(90.0)

        wide = CameraModel(hfov_deg=90.0, image_width=1600, image_height=900)
        # 2 * atan(tan(45) * 900/1600) = 2 * atan(0.5625)
        expected = 2 * math.degrees(math.atan(900.0 / 1600.0))
        assert wide.effective_vfov_deg() == pytest.approx(expected)

    def test_explicit_vfov_overrides_derivation(self):
        cam = CameraModel(hfov_deg=90.0, image_width=1600, image_height=900, vfov_deg=60.0)
        assert cam.effective_vfov_deg() == 60.0


class TestProjection:
    def test_frame_centre_maps_to_the_drone_position(self):
        """Nadir camera: the middle of the frame is directly below the aircraft."""
        fix = FakeFix(lat=12.5, lon=77.5)
        pos = pixel_to_latlon(CAM, fix, CENTRE, CENTRE)

        assert pos is not None
        assert pos.lat == pytest.approx(12.5)
        assert pos.lon == pytest.approx(77.5)
        assert pos.offset_m == pytest.approx(0.0)

    def test_offset_right_of_centre_goes_east_when_heading_north(self):
        # 100 px right at 0.2 m/px = 20 m; nose north means right is east.
        fix = FakeFix(lat=0.0, lon=0.0, heading_deg=0.0)
        pos = pixel_to_latlon(CAM, fix, CENTRE + 100, CENTRE)

        assert pos.offset_m == pytest.approx(20.0)
        assert pos.lat == pytest.approx(0.0, abs=1e-9)
        assert pos.lon == pytest.approx(20.0 / METRES_PER_DEG_LAT, rel=1e-6)

    def test_offset_above_centre_goes_north_when_heading_north(self):
        """Image y grows downward, so the top of the frame is ahead of the drone."""
        fix = FakeFix(lat=0.0, lon=0.0, heading_deg=0.0)
        pos = pixel_to_latlon(CAM, fix, CENTRE, CENTRE - 100)

        assert pos.offset_m == pytest.approx(20.0)
        assert pos.lat == pytest.approx(20.0 / METRES_PER_DEG_LAT, rel=1e-6)
        assert pos.lon == pytest.approx(0.0, abs=1e-9)

    def test_heading_rotates_the_offset(self):
        """Nose east: something ahead in the frame is east on the ground."""
        fix = FakeFix(lat=0.0, lon=0.0, heading_deg=90.0)
        pos = pixel_to_latlon(CAM, fix, CENTRE, CENTRE - 100)

        assert pos.offset_m == pytest.approx(20.0)
        assert pos.lat == pytest.approx(0.0, abs=1e-9)
        assert pos.lon == pytest.approx(20.0 / METRES_PER_DEG_LAT, rel=1e-6)

    def test_heading_180_inverts_north_south(self):
        fix = FakeFix(lat=0.0, lon=0.0, heading_deg=180.0)
        pos = pixel_to_latlon(CAM, fix, CENTRE, CENTRE - 100)
        # Nose south, object ahead in frame -> south on the ground.
        assert pos.lat == pytest.approx(-20.0 / METRES_PER_DEG_LAT, rel=1e-6)

    def test_longitude_scales_with_latitude(self):
        """A metre of easting is more degrees of longitude further from the equator."""
        equator = pixel_to_latlon(CAM, FakeFix(lat=0.0, lon=0.0), CENTRE + 100, CENTRE)
        high = pixel_to_latlon(CAM, FakeFix(lat=60.0, lon=0.0), CENTRE + 100, CENTRE)

        # cos(60) == 0.5, so the same 20 m is twice the longitude delta.
        assert (high.lon - 0.0) == pytest.approx(2 * (equator.lon - 0.0), rel=1e-6)


class TestRefusals:
    """The cases where returning nothing is the correct answer."""

    def test_no_fix_returns_none(self):
        assert pixel_to_latlon(CAM, None, CENTRE, CENTRE) is None

    def test_zero_altitude_returns_none(self):
        """GSD would be 0 and every detection would land on the drone."""
        assert pixel_to_latlon(CAM, FakeFix(rel_alt_m=0.0), CENTRE, CENTRE) is None

    def test_negative_altitude_returns_none(self):
        assert pixel_to_latlon(CAM, FakeFix(rel_alt_m=-5.0), CENTRE, CENTRE) is None

    def test_missing_altitude_returns_none(self):
        assert pixel_to_latlon(CAM, FakeFix(rel_alt_m=None), CENTRE, CENTRE) is None

    def test_explicit_altitude_overrides_the_fix(self):
        pos = pixel_to_latlon(CAM, FakeFix(rel_alt_m=0.0), CENTRE, CENTRE, altitude_m=100.0)
        assert pos is not None


class TestErrorBudget:
    def test_error_at_centre_is_gps_plus_centroid_only(self):
        """Zero offset means altitude and heading error contribute nothing."""
        pos = pixel_to_latlon(CAM, FakeFix(), CENTRE, CENTRE)
        # sqrt(2.5^2 + (4 px * 0.2 m/px)^2)
        expected = math.sqrt(2.5 ** 2 + 0.8 ** 2)
        assert pos.horizontal_error_m == pytest.approx(expected, rel=1e-6)

    def test_error_grows_with_offset(self):
        """Altitude and heading error both scale with distance from the centre."""
        centre = pixel_to_latlon(CAM, FakeFix(), CENTRE, CENTRE)
        edge = pixel_to_latlon(CAM, FakeFix(), 1000.0, 1000.0)
        assert edge.horizontal_error_m > centre.horizontal_error_m

    def test_unknown_heading_charges_the_full_offset(self):
        """With no heading the direction is unknown, so the offset is all error.

        Assuming north and reporting a small error would be the dangerous failure:
        a confident position that is off by the whole offset distance.
        """
        pos = pixel_to_latlon(CAM, FakeFix(heading_deg=None), CENTRE + 100, CENTRE)

        assert pos.assumed_heading is True
        assert pos.horizontal_error_m >= pos.offset_m

    def test_known_heading_is_not_flagged(self):
        pos = pixel_to_latlon(CAM, FakeFix(heading_deg=42.0), CENTRE + 100, CENTRE)
        assert pos.assumed_heading is False

    def test_error_never_understates_gps_alone(self):
        """No combination of inputs should report better than the GPS receiver can do."""
        for px, py in [(CENTRE, CENTRE), (0, 0), (1000, 1000), (250, 750)]:
            pos = pixel_to_latlon(CAM, FakeFix(), px, py)
            assert pos.horizontal_error_m >= 2.5


class TestBboxHelpers:
    def test_bbox_centre(self):
        assert bbox_centre(100, 200, 300, 400) == (200.0, 300.0)

    def test_bbox_to_latlon_matches_centre_pixel(self):
        fix = FakeFix(lat=1.0, lon=2.0)
        from_box = bbox_to_latlon(CAM, fix, 400, 400, 600, 600)
        from_pixel = pixel_to_latlon(CAM, fix, 500.0, 500.0)

        assert from_box.lat == pytest.approx(from_pixel.lat)
        assert from_box.lon == pytest.approx(from_pixel.lon)

    def test_bbox_to_latlon_without_fix(self):
        assert bbox_to_latlon(CAM, None, 400, 400, 600, 600) is None


class TestOffsetToLatLon:
    def test_pure_north_offset(self):
        lat, lon = offset_to_latlon(0.0, 0.0, north_m=METRES_PER_DEG_LAT, east_m=0.0)
        assert lat == pytest.approx(1.0)
        assert lon == pytest.approx(0.0)

    def test_pole_does_not_divide_by_zero(self):
        """cos(90) is 0; the clamp must degrade rather than raise."""
        lat, lon = offset_to_latlon(90.0, 0.0, north_m=0.0, east_m=100.0)
        assert math.isfinite(lat)
        assert math.isfinite(lon)
