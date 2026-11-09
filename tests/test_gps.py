"""AeroShield - GPS provider tests.

The simulated provider takes an injectable clock, so the lawnmower track is exactly
reproducible and every expected coordinate below is hand-derivable:

    leg_length 60 m at 5 m/s  ->  12 s per leg
    6 lanes                   ->  72 s for the full pattern
    lane spacing 15 m         ->  lane N is 15*N metres north
"""

import math

import pytest

from geo import METRES_PER_DEG_LAT
from gps import (
    GPS_FIX_2D,
    GPS_FIX_3D,
    GpsFix,
    MavlinkGpsProvider,
    NullGpsProvider,
    SimulatedGpsProvider,
    make_provider,
)


class FakeClock:
    """Manually advanced monotonic clock."""

    def __init__(self):
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


ORIGIN_LAT = 0.0      # equator, so cos(lat) == 1 and easting maths stays exact
ORIGIN_LON = 0.0


def make_sim(clock):
    return SimulatedGpsProvider(
        origin_lat=ORIGIN_LAT, origin_lon=ORIGIN_LON,
        altitude_m=30.0, speed_mps=5.0,
        leg_length_m=60.0, lane_spacing_m=15.0, lanes=6,
        clock=clock,
    )


class TestNullProvider:
    def test_returns_none(self):
        """No GPS must yield None, never (0, 0).

        Null Island is a real place on a map. A detection plotted there is corrupt
        data that would poison the Week 11 planner, whereas None is honestly "no
        position" and the backend records the detection ungeotagged.
        """
        provider = NullGpsProvider()
        provider.start()
        assert provider.get_fix() is None
        provider.close()


class TestSimulatedProvider:
    def test_starts_at_the_origin(self):
        clock = FakeClock()
        gps = make_sim(clock)
        gps.start()

        fix = gps.get_fix()
        assert fix.lat == pytest.approx(ORIGIN_LAT)
        assert fix.lon == pytest.approx(ORIGIN_LON)
        assert fix.fix_type == GPS_FIX_3D
        assert fix.rel_alt_m == 30.0

    def test_moves_east_along_the_first_leg(self):
        clock = FakeClock()
        gps = make_sim(clock)
        gps.start()

        clock.advance(6.0)          # 6 s at 5 m/s = 30 m along the leg
        fix = gps.get_fix()

        assert fix.lon == pytest.approx(30.0 / METRES_PER_DEG_LAT, rel=1e-6)
        assert fix.lat == pytest.approx(0.0, abs=1e-12)
        assert fix.heading_deg == 90.0

    def test_second_leg_runs_back_and_steps_north(self):
        """Boustrophedon: alternate legs reverse and shift one lane over."""
        clock = FakeClock()
        gps = make_sim(clock)
        gps.start()

        clock.advance(13.0)         # 1 s into lane 1
        fix = gps.get_fix()

        # lane 1 -> 15 m north; reversed leg -> 60 - 5 = 55 m east
        assert fix.lat == pytest.approx(15.0 / METRES_PER_DEG_LAT, rel=1e-6)
        assert fix.lon == pytest.approx(55.0 / METRES_PER_DEG_LAT, rel=1e-6)
        assert fix.heading_deg == 270.0

    def test_pattern_loops_instead_of_flying_away(self):
        """A long soak test must stay inside the survey box."""
        clock = FakeClock()
        gps = make_sim(clock)
        gps.start()

        first = gps.get_fix()
        clock.advance(72.0)         # exactly one full pattern
        looped = gps.get_fix()

        assert looped.lat == pytest.approx(first.lat, abs=1e-12)
        assert looped.lon == pytest.approx(first.lon, abs=1e-12)

    def test_is_deterministic(self):
        """Same clock, same track - this is what makes it usable in tests."""
        positions = []
        for _ in range(2):
            clock = FakeClock()
            gps = make_sim(clock)
            gps.start()
            clock.advance(27.5)
            fix = gps.get_fix()
            positions.append((fix.lat, fix.lon))

        assert positions[0] == positions[1]

    def test_timestamps_are_utc_with_z_suffix(self):
        """Week 4 requires timestamped coordinates, and naive ones are ambiguous."""
        gps = make_sim(FakeClock())
        gps.start()
        assert gps.get_fix().ts_utc.endswith("Z")

    def test_get_fix_before_start_still_works(self):
        """A caller that forgets start() should not get a crash mid-flight."""
        gps = make_sim(FakeClock())
        assert gps.get_fix() is not None

    def test_context_manager(self):
        with make_sim(FakeClock()) as gps:
            assert gps.get_fix() is not None


class TestGpsFix:
    def test_is_3d(self):
        base = dict(lat=0.0, lon=0.0, alt_msl_m=0.0, rel_alt_m=0.0,
                    heading_deg=0.0, satellites=8, ts_utc="")
        assert GpsFix(fix_type=GPS_FIX_3D, **base).is_3d() is True
        assert GpsFix(fix_type=GPS_FIX_2D, **base).is_3d() is False

    def test_is_immutable(self):
        """A NamedTuple can be handed to the uplink thread without copying."""
        fix = GpsFix(lat=1.0, lon=2.0, alt_msl_m=0.0, rel_alt_m=0.0, heading_deg=0.0,
                     fix_type=3, satellites=8, ts_utc="")
        with pytest.raises(AttributeError):
            fix.lat = 5.0


class TestMavlinkProviderWithoutHardware:
    """State handling that can be tested without a flight controller."""

    def test_no_position_yet_returns_none(self):
        provider = MavlinkGpsProvider(url="udp:127.0.0.1:14550")
        assert provider.get_fix() is None

    def test_stale_fix_is_rejected(self):
        """A position from 10 seconds ago is worse than no position.

        Geotagging with where the drone *was* silently misplaces the detection by
        however far it has flown since.
        """
        import time

        provider = MavlinkGpsProvider(max_age_s=2.0)
        provider._lat = 12.9
        provider._lon = 77.5
        provider._fix_type = GPS_FIX_3D
        provider._recv_mono = time.monotonic() - 10.0

        assert provider.get_fix() is None

    def test_fresh_fix_is_returned(self):
        import time

        provider = MavlinkGpsProvider(max_age_s=2.0)
        provider._lat = 12.9
        provider._lon = 77.5
        provider._fix_type = GPS_FIX_3D
        provider._sats = 12
        provider._recv_mono = time.monotonic()
        provider._recv_iso = "2026-08-23T09:00:00.000Z"

        fix = provider.get_fix()
        assert fix is not None
        assert fix.lat == 12.9
        assert fix.satellites == 12

    def test_2d_fix_rejected_by_default(self):
        """A 2D fix has no usable altitude, and geo.py projects with altitude."""
        import time

        provider = MavlinkGpsProvider()
        provider._lat = 12.9
        provider._lon = 77.5
        provider._fix_type = GPS_FIX_2D
        provider._recv_mono = time.monotonic()

        assert provider.get_fix() is None

    def test_2d_fix_allowed_when_opted_in(self):
        import time

        provider = MavlinkGpsProvider(require_3d=False)
        provider._lat = 12.9
        provider._lon = 77.5
        provider._fix_type = GPS_FIX_2D
        provider._recv_mono = time.monotonic()

        assert provider.get_fix() is not None

    def test_status_string_is_safe_before_any_data(self):
        provider = MavlinkGpsProvider()
        assert "no position yet" in provider.status()


class TestFactory:
    def test_makes_each_kind(self):
        assert isinstance(make_provider("sim"), SimulatedGpsProvider)
        assert isinstance(make_provider("none"), NullGpsProvider)
        assert isinstance(make_provider("mavlink"), MavlinkGpsProvider)

    def test_unknown_kind_raises(self):
        with pytest.raises(ValueError, match="Unknown GPS provider"):
            make_provider("gnss")

    def test_irrelevant_kwargs_are_ignored(self):
        """The CLI passes one flat option bag; each provider takes what it needs."""
        provider = make_provider("sim", url="udp:1.2.3.4:14550", altitude_m=45.0)
        assert isinstance(provider, SimulatedGpsProvider)
        assert provider.altitude_m == 45.0

    def test_none_defaults_to_null_provider(self):
        assert isinstance(make_provider(None), NullGpsProvider)
