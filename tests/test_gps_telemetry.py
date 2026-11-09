"""AeroShield - GPS telemetry validation, link health and refusal reasons.

Agent 2's surface: the validate/classify layer that sits above Agent 1's
provider in ``jetson/gps_telemetry.py``, plus the ``sample()`` / ``link_status()``
additions to ``jetson/gps.py``.

These tests never open a MAVLink socket. They write the provider's cached fields
directly - the same technique ``tests/test_gps.py`` already uses in
``TestMavlinkProviderWithoutHardware`` - and then assert against the public
``sample()`` / ``link_status()`` / ``poll()`` surface.
"""

import time

import pytest

from gps import (
    GPS_FIX_3D,
    GPS_FIX_NONE,
    LINK_FAULT,
    LINK_OK,
    LINK_SILENT,
    REJECT_FIX_TYPE,
    REJECT_NO_POSITION,
    REJECT_OK,
    REJECT_STALE,
    MavlinkGpsProvider,
    NullGpsProvider,
    SimulatedGpsProvider,
    make_provider,
)
from gps_telemetry import (
    FIX_DISCONNECTED,
    FIX_INVALID,
    FIX_NO_DATA,
    FIX_NO_FIX,
    FIX_OK,
    FIX_STALE,
    GpsTelemetryService,
    validate_coordinates,
)

# KMIT, Narayanaguda, Hyderabad - the actual survey site.
KMIT_LAT = 17.396947
KMIT_LON = 78.490706


class TestValidateCoordinates:
    def test_accepts_the_real_survey_site(self):
        ok, why = validate_coordinates(KMIT_LAT, KMIT_LON)
        assert ok is True
        assert why == ""

    def test_accepts_a_2d_fix_with_no_altitude(self):
        """Altitude is optional: a 2D fix has none and must not be rejected here."""
        ok, _ = validate_coordinates(KMIT_LAT, KMIT_LON, None, None)
        assert ok is True

    @pytest.mark.parametrize("lat,lon", [(-90.0, -180.0), (90.0, 180.0)])
    def test_accepts_the_extremes_of_the_valid_ranges(self, lat, lon):
        assert validate_coordinates(lat, lon)[0] is True

    def test_rejects_null_island(self):
        """(0, 0) is what a Pixhawk with no lock reports - not a real place."""
        ok, why = validate_coordinates(0.0, 0.0)
        assert ok is False
        assert "Null Island" in why

    def test_rejects_latitude_out_of_range(self):
        assert validate_coordinates(91.0, KMIT_LON)[0] is False
        assert validate_coordinates(-90.5, KMIT_LON)[0] is False

    def test_rejects_longitude_out_of_range(self):
        assert validate_coordinates(KMIT_LAT, 181.0)[0] is False
        assert validate_coordinates(KMIT_LAT, -180.5)[0] is False

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), None])
    def test_rejects_non_finite_values(self, bad):
        assert validate_coordinates(bad, KMIT_LON)[0] is False
        assert validate_coordinates(KMIT_LAT, bad)[0] is False

    def test_rejects_altitude_out_of_range(self):
        assert validate_coordinates(KMIT_LAT, KMIT_LON, -900.0, None)[0] is False
        assert validate_coordinates(KMIT_LAT, KMIT_LON, 30000.0, None)[0] is False
        assert validate_coordinates(KMIT_LAT, KMIT_LON, None, -5000.0)[0] is False

    def test_accepts_a_sane_altitude(self):
        assert validate_coordinates(KMIT_LAT, KMIT_LON, 480.0, 30.0)[0] is True


class TestTelemetrySampleReasons:
    def test_no_data_before_anything_arrives(self):
        sample = MavlinkGpsProvider().sample()
        assert sample.fix is None
        assert sample.reason == REJECT_NO_POSITION
        assert sample.is_valid() is False
        assert sample.age_s is None

    def test_no_fix_when_the_fix_is_only_2d(self):
        provider = MavlinkGpsProvider(require_3d=True)
        provider._lat, provider._lon = KMIT_LAT, KMIT_LON
        provider._fix_type = 2          # GPS_FIX_2D
        provider._recv_mono = time.monotonic()
        sample = provider.sample()
        assert sample.reason == REJECT_FIX_TYPE
        assert sample.fix is None

    def test_stale_position_is_refused(self):
        provider = MavlinkGpsProvider(max_age_s=2.0)
        provider._lat, provider._lon = KMIT_LAT, KMIT_LON
        provider._fix_type = GPS_FIX_3D
        provider._recv_mono = time.monotonic() - 10.0
        sample = provider.sample()
        assert sample.reason == REJECT_STALE
        assert sample.age_s > 2.0

    def test_fresh_3d_position_is_accepted(self):
        provider = MavlinkGpsProvider(max_age_s=2.0)
        provider._lat, provider._lon = KMIT_LAT, KMIT_LON
        provider._fix_type = GPS_FIX_3D
        provider._sats = 11
        provider._recv_mono = time.monotonic()
        sample = provider.sample()
        assert sample.reason == REJECT_OK
        assert sample.is_valid() is True
        assert sample.fix.lat == KMIT_LAT
        assert sample.fix.satellites == 11

    def test_get_fix_still_returns_a_bare_optional(self):
        """The old contract must not have leaked TelemetrySample into it."""
        provider = MavlinkGpsProvider()
        assert provider.get_fix() is None


class TestLinkStatus:
    def test_unstarted_provider_with_no_data_is_ok(self):
        assert MavlinkGpsProvider().link_status().state == LINK_OK

    def test_quiet_link_after_start_is_silent(self):
        provider = MavlinkGpsProvider(silent_after_s=5.0)
        provider._thread = object()          # pretend start() ran
        provider._last_msg_mono = time.monotonic() - 30.0
        link = provider.link_status()
        assert link.state == LINK_SILENT
        assert link.seconds_since_message > 5.0
        assert link.is_alive() is False

    def test_repeated_read_errors_are_a_fault(self):
        provider = MavlinkGpsProvider()
        provider._read_failures = 3
        provider._last_error = "OSError: [Errno 6] device not configured"
        link = provider.link_status()
        assert link.state == LINK_FAULT
        assert "device not configured" in link.last_error

    def test_a_single_read_error_is_not_yet_a_fault(self):
        """One dropped read is noise; three in a row is a broken socket."""
        provider = MavlinkGpsProvider()
        provider._read_failures = 1
        provider._last_error = "OSError: transient"
        assert provider.link_status().state == LINK_OK

    def test_recent_message_keeps_a_link_alive(self):
        provider = MavlinkGpsProvider(silent_after_s=5.0)
        provider._thread = object()
        provider._last_msg_mono = time.monotonic()
        link = provider.link_status()
        assert link.state == LINK_OK
        assert link.is_alive() is True

    def test_a_silent_link_does_not_deadlock_under_the_lock(self):
        """link_status() is called by sample() and status(), both lock holders.

        threading.Lock is not reentrant, so this regressed once as a hard hang.
        Touching all three in sequence proves the lock discipline holds.
        """
        provider = MavlinkGpsProvider(silent_after_s=5.0)
        provider._thread = object()
        provider._last_msg_mono = time.monotonic() - 60.0
        provider._lat, provider._lon = KMIT_LAT, KMIT_LON
        provider._fix_type = GPS_FIX_3D
        provider._recv_mono = time.monotonic() - 60.0
        provider.link_status()
        provider.status()
        assert provider.sample().reason == REJECT_STALE


class TestGpsTelemetryService:
    def test_wraps_the_simulated_provider(self):
        service = GpsTelemetryService(make_provider("sim"))
        status = service.poll()
        assert status.valid is True
        assert status.quality == FIX_OK
        assert status.fix is not None

    def test_bool_of_a_status_tracks_validity(self):
        assert bool(GpsTelemetryService(make_provider("sim")).poll()) is True
        assert bool(GpsTelemetryService(make_provider("none")).poll()) is False

    def test_missing_gps_is_reported_as_no_data_not_disconnected(self):
        """`--gps none` means no receiver is fitted, so nothing fell over."""
        status = GpsTelemetryService(make_provider("none")).poll()
        assert status.valid is False
        assert status.quality == FIX_NO_DATA
        assert "no GPS provider configured" in status.reason

    def test_a_faulting_link_is_disconnected(self):
        provider = MavlinkGpsProvider()
        provider._read_failures = 3
        provider._last_error = "OSError: cable out"
        status = GpsTelemetryService(provider).poll()
        assert status.quality == FIX_DISCONNECTED
        assert "cable out" in status.reason

    def test_a_quiet_started_link_is_disconnected(self):
        provider = MavlinkGpsProvider(silent_after_s=5.0)
        provider._thread = object()
        provider._last_msg_mono = time.monotonic() - 60.0
        assert GpsTelemetryService(provider).poll().quality == FIX_DISCONNECTED

    def test_two_dimensional_fix_is_no_fix(self):
        provider = MavlinkGpsProvider(require_3d=True)
        provider._lat, provider._lon = KMIT_LAT, KMIT_LON
        provider._fix_type = 2
        provider._recv_mono = time.monotonic()
        assert GpsTelemetryService(provider).poll().quality == FIX_NO_FIX

    def test_stale_fix_is_stale(self):
        provider = MavlinkGpsProvider(max_age_s=2.0)
        provider._lat, provider._lon = KMIT_LAT, KMIT_LON
        provider._fix_type = GPS_FIX_3D
        provider._recv_mono = time.monotonic() - 10.0
        assert GpsTelemetryService(provider).poll().quality == FIX_STALE

    def test_null_island_is_caught_by_validation_alone(self):
        """A 3D fix at (0,0) passes every provider check - only the service catches it."""
        provider = MavlinkGpsProvider(max_age_s=30.0)
        provider._lat, provider._lon = 0.0, 0.0
        provider._fix_type = GPS_FIX_3D
        provider._recv_mono = time.monotonic()
        assert provider.sample().reason == REJECT_OK      # the provider is happy
        status = GpsTelemetryService(provider).poll()
        assert status.quality == FIX_INVALID
        assert "Null Island" in status.reason

    def test_validation_can_be_switched_off(self):
        provider = MavlinkGpsProvider(max_age_s=30.0)
        provider._lat, provider._lon = 0.0, 0.0
        provider._fix_type = GPS_FIX_3D
        provider._recv_mono = time.monotonic()
        assert GpsTelemetryService(provider, validate=False).poll().valid is True

    def test_latest_does_not_poll(self):
        service = GpsTelemetryService(make_provider("sim"))
        assert service.latest() is None       # nothing polled yet
        service.poll()
        assert service.latest() is not None
        assert service.stats()["polls"] == 1

    def test_stats_and_summary_count_every_quality(self):
        service = GpsTelemetryService(make_provider("none"))
        for _ in range(3):
            service.poll()
        assert service.stats()["no_data"] == 3
        assert service.stats()["polls"] == 3
        assert "no_data=3" in service.summary()


class TestEveryProviderHasASample:
    """The service wraps any provider, so no provider may be missing sample()."""

    @pytest.mark.parametrize("kind", ["sim", "none", "mavlink"])
    def test_provider_exposes_sample(self, kind):
        assert make_provider(kind).sample() is not None

    def test_none_provider_reports_no_position(self):
        sample = NullGpsProvider().sample()
        assert sample.reason == REJECT_NO_POSITION
        assert sample.fix_type == GPS_FIX_NONE

    def test_none_provider_reports_a_healthy_link(self):
        """No receiver is fitted; nothing has faulted or gone quiet."""
        assert NullGpsProvider().sample().link.state == LINK_OK

    def test_simulated_provider_matches_its_get_fix(self):
        """Frozen clock: the simulator is time-driven, so both calls must agree.

        With a real clock these two calls land microseconds apart and the
        easting differs in the 8th decimal. That is correct behaviour for a
        moving aircraft, so pin the clock rather than loosening the assertion.
        """
        provider = SimulatedGpsProvider(clock=lambda: 0.0)
        provider.start()
        sample = provider.sample()
        assert sample.is_valid() is True
        assert sample.reason == REJECT_OK
        assert (sample.fix.lat, sample.fix.lon) == (
            provider.get_fix().lat, provider.get_fix().lon)
