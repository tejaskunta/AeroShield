#!/usr/bin/env python3
"""AeroShield - validated Pixhawk position telemetry service (Week 4, Agent 2).

Agent 1 built jetson/gps.py: three providers behind one interface, the MAVLink
scaling, staleness and fix-quality gating, and the GpsFix sample type. This
module is the layer above it and deliberately does NOT open its own MAVLink
connection - it takes a provider from gps.make_provider and reads that. One
connection per flight controller, which is Agent 1's whole point.

What this adds is the judgement gps.py leaves to its caller:

    validate_coordinates()   are these numbers a place on Earth at all?
    GpsTelemetryService      one poll -> one TelemetryStatus, with a reason code

gps.py answers "do I have a fix?". This module answers "can I trust it, and if
not, what exactly is wrong?" - no data, stale, bad fix quality, out-of-range
coordinates, or a dead link. Those are five different faults on the bench, and
one useless "None" without this layer. A detection geotagged with a wrong
position is worse than one with no position at all, because nothing downstream
can tell it was wrong.

    from gps import make_provider
    from gps_telemetry import GpsTelemetryService

    with GpsTelemetryService(make_provider("mavlink", url="/dev/ttyACM0")) as gps:
        status = gps.poll()
        if status:                     # __bool__ is `valid`
            use(status.fix)
        else:
            print(status.quality, status.reason)

Nothing here imports cv2, the detector, or any HTTP client: position telemetry
is independent of YOLO inference and of the backend, per the Agent 2 brief.

PYTHON 3.6 ONLY - see the note at the top of gps.py. No dataclasses, no walrus,
no builtin generics, no __future__ annotations. NamedTuple throughout.
"""

import json
import math
import sys
import time
from typing import Callable, NamedTuple, Optional

from gps import (
    GPS_FIX_3D,
    LINK_FAULT,
    LINK_OK,
    LINK_SILENT,
    REJECT_FIX_TYPE,
    REJECT_NO_POSITION,
    REJECT_STALE,
    GpsFix,
    LinkStatus,
    make_provider,
)

# --------------------------------------------------------------------------
# Quality codes. `valid` is the only field a caller must branch on; `quality`
# says why, in a form that is safe to grep through a flight log.
# --------------------------------------------------------------------------
FIX_OK = "ok"                        # validated 3D position, inside max_age_s
FIX_NO_DATA = "no_data"              # nothing has arrived yet - not necessarily a fault
FIX_NO_FIX = "no_fix"                # messages arriving, fix below required quality
FIX_INVALID = "invalid"              # reported numbers are not a place on Earth
FIX_STALE = "stale"                  # a real position, but too old to trust
FIX_DISCONNECTED = "disconnected"    # the link itself has gone quiet or is erroring

QUALITY_CODES = (
    FIX_OK, FIX_NO_DATA, FIX_NO_FIX, FIX_INVALID, FIX_STALE, FIX_DISCONNECTED,
)

# --------------------------------------------------------------------------
# Coordinate sanity limits. These are deliberately WIDER than any plausible
# value and narrower than the wire format: they exist to catch garbage (0,0
# from an unlocked receiver, 2^31-ish overflow, NaN from a bad divide), not to
# validate the mission. Anything inside these limits is accepted and the
# question "is this the right field?" stays with the operator.
# --------------------------------------------------------------------------
LAT_MIN, LAT_MAX = -90.0, 90.0
LON_MIN, LON_MAX = -180.0, 180.0

# Half of 1e-7 deg is below the 1e-7 deg quantisation MAVLink transmits, so this
# only matches an exact (0, 0) report - which is what an ArduPilot with no GPS
# lock actually sends in GLOBAL_POSITION_INT, and which plots at Null Island.
NULL_ISLAND_EPS = 5e-8

ALT_MSL_MIN, ALT_MSL_MAX = -500.0, 20000.0
REL_ALT_MIN, REL_ALT_MAX = -1000.0, 10000.0


def _finite(value) -> bool:
    """True for a real, finite number. Rejects None, NaN and both infinities."""
    if value is None:
        return False
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def validate_coordinates(lat, lon, alt_msl_m=None, rel_alt_m=None):
    """Check that a reported position is a place a drone could actually be.

    Returns (ok, reason). `reason` is "" when ok.

    This is the check that separates "unavailable GPS" from "GPS reporting
    nonsense". An ArduPilot with no lock does not send nothing - it sends
    GLOBAL_POSITION_INT with lat=0, lon=0, and that is a valid MAVLink message
    describing a point in the Gulf of Guinea. Accepting it puts every landmine
    detection of the flight in the wrong ocean, and no downstream consumer can
    tell. So (0, 0) is rejected here explicitly rather than left as an exercise.
    """
    if not _finite(lat):
        return False, "latitude is not a finite number ({0!r})".format(lat)
    if not _finite(lon):
        return False, "longitude is not a finite number ({0!r})".format(lon)

    lat = float(lat)
    lon = float(lon)

    if abs(lat) < NULL_ISLAND_EPS and abs(lon) < NULL_ISLAND_EPS:
        return False, ("position is exactly (0, 0) - Null Island. An autopilot "
                       "with no GPS lock reports this; it is not a real position")

    if not (LAT_MIN <= lat <= LAT_MAX):
        return False, "latitude {0:.7f} out of range [{1:.0f}, {2:.0f}]".format(
            lat, LAT_MIN, LAT_MAX)
    if not (LON_MIN <= lon <= LON_MAX):
        return False, "longitude {0:.7f} out of range [{1:.0f}, {2:.0f}]".format(
            lon, LON_MIN, LON_MAX)

    # Altitude is optional here: a 2D fix has none, and --allow-2d accepts those.
    if alt_msl_m is not None:
        if not _finite(alt_msl_m):
            return False, "altitude is not a finite number ({0!r})".format(alt_msl_m)
        if not (ALT_MSL_MIN <= float(alt_msl_m) <= ALT_MSL_MAX):
            return False, "altitude {0:.1f} m out of range [{1:.0f}, {2:.0f}]".format(
                float(alt_msl_m), ALT_MSL_MIN, ALT_MSL_MAX)

    if rel_alt_m is not None:
        if not _finite(rel_alt_m):
            return False, "relative altitude is not a finite number ({0!r})".format(rel_alt_m)
        if not (REL_ALT_MIN <= float(rel_alt_m) <= REL_ALT_MAX):
            return False, ("relative altitude {0:.1f} m out of range "
                           "[{1:.0f}, {2:.0f}]").format(
                               float(rel_alt_m), REL_ALT_MIN, REL_ALT_MAX)

    return True, ""


class TelemetryStatus(NamedTuple):
    """The result of one poll. Immutable, so it can be logged or handed on.

    `valid` is the single field a caller needs. Everything after it exists so a
    failure can be explained instead of merely reported.
    """

    valid: bool                    # True only when `fix` holds a validated position
    quality: str                   # one of the FIX_* codes
    reason: str                    # human-readable explanation
    fix: Optional[GpsFix]          # the position, when valid
    age_s: Optional[float]         # seconds since the position message arrived
    link_state: str                # gps.LINK_OK / LINK_SILENT / LINK_FAULT
    satellites: int
    fix_type: int
    ts_utc: str                    # timestamp straight off the autopilot

    def __bool__(self):
        """Lets callers write `if status:` instead of `if status.valid:`."""
        return self.valid

    def describe(self) -> str:
        """One line, for a HUD overlay or a log."""
        if self.valid:
            fix = self.fix
            return ("{0}  lat={1:.7f} lon={2:.7f} rel_alt={3:.1f}m hdg={4} "
                    "fix={5} sats={6} age={7}").format(
                        fix.ts_utc, fix.lat, fix.lon, fix.rel_alt_m,
                        "n/a" if fix.heading_deg is None else "{0:.0f}".format(fix.heading_deg),
                        fix.fix_type, fix.satellites,
                        "n/a" if self.age_s is None else "{0:.1f}s".format(self.age_s))
        return "{0}: {1}".format(self.quality, self.reason)


class GpsTelemetryService(object):
    """Validated position telemetry over any gps.GpsProvider.

    The provider owns the link (Agent 1's module, unchanged) and its own
    accept/reject policy. This service owns the second question: given what the
    provider handed back, or refused to hand back, what should the caller do?

    Concretely, `poll()` classifies into exactly one of the FIX_* codes, in this
    order of precedence:

        disconnected  the link is erroring or has gone quiet after working
        no_data       nothing has arrived yet
        no_fix        messages arriving, but fix quality below the requirement
        stale         a real position, older than max_age_s
        invalid       a position that is not a place on Earth
        ok            validated

    Order matters. A dead link and a stale sample both mean "no position", but
    only one of them is fixed by waiting.
    """

    def __init__(self, provider, max_age_s=None, validate=True, clock=None):
        self.provider = provider
        self.validate = validate
        self._clock = clock or time.monotonic
        # Default to the provider's own threshold so the two cannot disagree
        # unless the caller deliberately sets them differently.
        self.max_age_s = (getattr(provider, "max_age_s", 2.0)
                          if max_age_s is None else float(max_age_s))
        self._stats = dict((code, 0) for code in QUALITY_CODES)
        self._polls = 0
        self._last = None            # type: Optional[TelemetryStatus]

    # -- lifecycle: delegate to the provider so the service is the only handle
    #    a caller needs. Still one MAVLink connection, still Agent 1's. -------
    def start(self):
        self.provider.start()
        return self

    def close(self):
        self.provider.close()

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False

    # -- the one method that matters ----------------------------------------
    def poll(self):
        """Read the provider once and classify what came back.

        Never raises for a missing, stale or nonsense position: a caller polling
        at 5 Hz mid-flight cannot handle an exception every time the GPS drops a
        satellite. Every failure is a TelemetryStatus with a reason instead.
        """
        self._polls += 1

        sample = self.provider.sample()

        # 1. The link itself. A faulting or silent link is reported as such even
        #    if the provider is still handing out a (now old) cached position,
        #    because the useful fact is that nothing is coming in.
        if sample.link.state == LINK_FAULT:
            detail = sample.link.last_error or "reader thread has stalled"
            status = self._reject(FIX_DISCONNECTED,
                                  "MAVLink link fault: {0}".format(detail), sample)
            return self._record(status)

        if sample.link.state == LINK_SILENT:
            status = self._reject(
                FIX_DISCONNECTED,
                "no position message for {0:.1f}s".format(
                    sample.link.seconds_since_message or 0.0), sample)
            return self._record(status)

        # 2. Nothing has ever arrived. Not a fault - the FC may still be booting.
        if sample.reason == REJECT_NO_POSITION:
            return self._record(self._reject(FIX_NO_DATA, sample.detail, sample))

        # 3. A fix was refused for quality or age by the provider's own policy.
        if sample.reason == REJECT_FIX_TYPE:
            status = self._reject(FIX_NO_FIX, sample.detail, sample)
            return self._record(status)

        if sample.reason == REJECT_STALE:
            status = self._reject(FIX_STALE, sample.detail, sample)
            return self._record(status)

        # 4. A fix survived the provider. Validate the numbers before believing
        #    them, then apply this service's own (possibly tighter) age limit.
        fix = sample.fix
        if fix is None:
            return self._record(self._reject(
                FIX_NO_DATA, "provider returned no fix ({0})".format(sample.detail), sample))

        if self.validate:
            ok, why = validate_coordinates(fix.lat, fix.lon,
                                           fix.alt_msl_m, fix.rel_alt_m)
            if not ok:
                return self._record(self._reject(FIX_INVALID, why, sample))

        if sample.age_s is not None and sample.age_s > self.max_age_s:
            status = self._reject(
                FIX_STALE,
                "position is {0:.1f}s old (limit {1:.1f}s)".format(
                    sample.age_s, self.max_age_s), sample)
            return self._record(status)

        status = TelemetryStatus(
            valid=True,
            quality=FIX_OK,
            reason="",
            fix=fix,
            age_s=sample.age_s,
            link_state=sample.link.state,
            satellites=fix.satellites,
            fix_type=fix.fix_type,
            ts_utc=fix.ts_utc,
        )
        return self._record(status)

    def _reject(self, quality, reason, sample):
        return TelemetryStatus(
            valid=False,
            quality=quality,
            reason=reason,
            fix=None,
            age_s=sample.age_s,
            link_state=sample.link.state,
            satellites=sample.satellites,
            fix_type=sample.fix_type,
            ts_utc="",
        )

    def _record(self, status):
        self._stats[status.quality] = self._stats.get(status.quality, 0) + 1
        self._last = status
        return status

    # -- convenience ---------------------------------------------------------
    def latest(self):
        """The last validated GpsFix, or None.

        Does NOT poll. Use it where a caller wants the most recent good position
        without adding a second read of the link.
        """
        if self._last is not None and self._last.valid:
            return self._last.fix
        return None

    def last_status(self):
        return self._last

    def stats(self):
        """Copy of the quality-code counters, for a mission summary."""
        out = dict(self._stats)
        out["polls"] = self._polls
        return out

    def summary(self):
        """One line of counters, for the end of a run."""
        total = max(self._polls, 1)
        return ("polls={0} ok={1} ({2:.0f}%) no_data={3} no_fix={4} invalid={5} "
                "stale={6} disconnected={7}").format(
                    self._polls, self._stats.get(FIX_OK, 0),
                    100.0 * self._stats.get(FIX_OK, 0) / total,
                    self._stats.get(FIX_NO_DATA, 0), self._stats.get(FIX_NO_FIX, 0),
                    self._stats.get(FIX_INVALID, 0), self._stats.get(FIX_STALE, 0),
                    self._stats.get(FIX_DISCONNECTED, 0))


def main():
    """Smoke test / bench tool for the telemetry service.

        python3 jetson/gps_telemetry.py --gps sim --count 5
        python3 jetson/gps_telemetry.py --gps mavlink --url /dev/ttyACM0 --count 10
        python3 jetson/gps_telemetry.py --gps none --count 3
        python3 jetson/gps_telemetry.py --gps mavlink --url /dev/ttyACM0 --json

    --json emits one JSON object per poll, which is what makes the output
    diffable and pasteable into a report.
    """
    import argparse

    ap = argparse.ArgumentParser(
        description="AeroShield validated GPS telemetry service smoke test.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--gps", default="sim", choices=["mavlink", "sim", "none"])
    ap.add_argument("--url", default="udp:127.0.0.1:14550",
                    help="MAVLink endpoint, e.g. /dev/ttyACM0 or udp:127.0.0.1:14550")
    ap.add_argument("--baud", type=int, default=921600,
                    help="Serial baud. Ignored for USB CDC-ACM, harmless otherwise")
    ap.add_argument("--max-age-s", type=float, default=2.0,
                    help="Reject a position older than this")
    ap.add_argument("--allow-2d", action="store_true",
                    help="Accept a 2D fix. Altitude is unreliable, so geo.py output is too")
    ap.add_argument("--no-validate", action="store_true",
                    help="Skip the coordinate sanity check (for demonstrating it)")
    ap.add_argument("--interval-s", type=float, default=0.5)
    ap.add_argument("--wait-heartbeat-s", type=float, default=10.0,
                    help="Heartbeat timeout. 0 skips the wait entirely")
    ap.add_argument("--json", action="store_true", help="One JSON object per poll")
    ap.add_argument("--count", type=int, default=20, help="Polls to print (0 = forever)")
    args = ap.parse_args()

    provider = make_provider(
        args.gps,
        url=args.url,
        baud=args.baud,
        max_age_s=args.max_age_s,
        require_3d=not args.allow_2d,
        wait_for_heartbeat=args.wait_heartbeat_s > 0,
        heartbeat_timeout_s=max(args.wait_heartbeat_s, 1.0),
    )
    service = GpsTelemetryService(provider, validate=not args.no_validate)

    printed = 0
    try:
        service.start()
        while args.count == 0 or printed < args.count:
            status = service.poll()
            if args.json:
                print(json.dumps({
                    "valid": status.valid,
                    "quality": status.quality,
                    "reason": status.reason,
                    "age_s": None if status.age_s is None else round(status.age_s, 3),
                    "link_state": status.link_state,
                    "fix_type": status.fix_type,
                    "satellites": status.satellites,
                    "ts_utc": status.ts_utc,
                    "lat": None if status.fix is None else status.fix.lat,
                    "lon": None if status.fix is None else status.fix.lon,
                    "alt_msl_m": None if status.fix is None else status.fix.alt_msl_m,
                    "rel_alt_m": None if status.fix is None else status.fix.rel_alt_m,
                    "heading_deg": None if status.fix is None else status.fix.heading_deg,
                }))
            else:
                print(status.describe())
            sys.stdout.flush()
            printed += 1
            if args.count == 0 or printed < args.count:
                time.sleep(args.interval_s)
    except KeyboardInterrupt:
        print("\nStopped.")
    except RuntimeError as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1
    finally:
        service.close()
        if not args.json:
            print("summary: {0}".format(service.summary()))
    return 0


if __name__ == "__main__":
    sys.exit(main())