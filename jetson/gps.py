#!/usr/bin/env python3
"""
AeroShield - GPS Logging Module (Week 4).

Turns MAVLink telemetry into a GpsFix that live_detect.py stamps onto every
detection. This is the half of Week 4 that did not exist: jetson/README.md said
the MAVLink geotagging "belongs in a separate module that imports TrtYolo" -
this is that module.

Three providers, one interface, selected with a single flag:

    MavlinkGpsProvider    real Pixhawk, or ArduPilot SITL over UDP
    SimulatedGpsProvider  deterministic lawnmower track - no hardware needed
    NullGpsProvider       always None - detections recorded ungeotagged

Usage:
    from gps import make_provider
    gps = make_provider("mavlink", url="udp:127.0.0.1:14550")
    gps.start()
    try:
        fix = gps.get_fix()        # GpsFix, or None if no usable lock
    finally:
        gps.close()

PRD section 10 is explicit: never debug flight logic on the real airframe. Point
this at SITL (udp:127.0.0.1:14550) and watch the numbers move before you wire it
to a Pixhawk.

PYTHON 3.6 ONLY - see the note at the top of infer_trt.py. No __future__
annotations, no builtin generics, no dataclasses. NamedTuple instead.
"""

import math
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Callable, NamedTuple, Optional

# MAVLink fix_type values (mavlink common message set, GPS_FIX_TYPE enum).
GPS_FIX_NONE = 0
GPS_FIX_2D = 2
GPS_FIX_3D = 3

# hdg is sent in centi-degrees; this sentinel means "the autopilot does not know".
HEADING_UNKNOWN = 65535

# Metres per degree of latitude. Constant enough for the sub-kilometre offsets we
# apply in geo.py; see that module for the honest error discussion (PRD section 10).
METRES_PER_DEG_LAT = 111320.0


def _utc_now_iso() -> str:
    """UTC timestamp, ISO-8601 with a Z suffix. Week 4 requires timestamped coords."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class GpsFix(NamedTuple):
    """One position sample. Immutable, so it can be handed to another thread safely."""

    lat: float
    lon: float
    alt_msl_m: float
    rel_alt_m: float
    heading_deg: Optional[float]   # None when the autopilot reports 65535
    fix_type: int
    satellites: int
    ts_utc: str

    def is_3d(self) -> bool:
        """A 2D fix has no usable altitude, and altitude is what geo.py projects with."""
        return self.fix_type >= GPS_FIX_3D


class GpsProvider(object):
    """Base provider. Subclasses override start/get_fix/close."""

    name = "base"

    def start(self) -> None:
        pass

    def get_fix(self) -> Optional[GpsFix]:
        raise NotImplementedError

    def close(self) -> None:
        pass

    # Lets callers write `with make_provider(...) as gps:`
    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


class NullGpsProvider(GpsProvider):
    """No GPS at all.

    Deliberately returns None rather than raising or inventing (0, 0). A detection
    with no position is still evidence worth keeping - the backend accepts
    ungeotagged rows - whereas a detection at Null Island is corrupt data that
    will quietly poison the Week 11 safe-path planner.
    """

    name = "none"

    def get_fix(self) -> Optional[GpsFix]:
        return None


class SimulatedGpsProvider(GpsProvider):
    """Deterministic lawnmower ("boustrophedon") track over a rectangular grid.

    This is what makes Week 4 testable today, on a laptop, with no Pixhawk and no
    Nano. Position is a pure function of elapsed time, so a test can inject a fake
    clock and assert exact coordinates.

    The pattern mirrors a real grid survey (PRD section 2.1): fly a leg, step
    sideways one lane, fly back.
    """

    name = "sim"

    def __init__(
        self,
        origin_lat: float = 12.9716,
        origin_lon: float = 77.5946,
        altitude_m: float = 30.0,
        speed_mps: float = 5.0,
        leg_length_m: float = 60.0,
        lane_spacing_m: float = 15.0,
        lanes: int = 6,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self.origin_lat = origin_lat
        self.origin_lon = origin_lon
        self.altitude_m = altitude_m
        self.speed_mps = speed_mps
        self.leg_length_m = leg_length_m
        self.lane_spacing_m = lane_spacing_m
        self.lanes = lanes
        self._clock = clock or time.monotonic
        self._t0 = None   # type: Optional[float]

    def start(self) -> None:
        self._t0 = self._clock()

    def get_fix(self) -> Optional[GpsFix]:
        if self._t0 is None:
            self.start()
        elapsed = self._clock() - self._t0

        leg_seconds = self.leg_length_m / self.speed_mps
        total = leg_seconds * self.lanes
        # Loop the pattern rather than flying off forever, so a long soak test stays
        # inside the survey box.
        t = elapsed % total if total > 0 else 0.0

        lane = int(t / leg_seconds)
        along = (t - lane * leg_seconds) * self.speed_mps
        if lane % 2 == 1:                      # every other leg runs back the other way
            along = self.leg_length_m - along
            heading = 270.0
        else:
            heading = 90.0

        north_m = lane * self.lane_spacing_m
        east_m = along

        d_lat = north_m / METRES_PER_DEG_LAT
        d_lon = east_m / (METRES_PER_DEG_LAT * math.cos(math.radians(self.origin_lat)))

        return GpsFix(
            lat=self.origin_lat + d_lat,
            lon=self.origin_lon + d_lon,
            alt_msl_m=self.altitude_m,
            rel_alt_m=self.altitude_m,
            heading_deg=heading,
            fix_type=GPS_FIX_3D,
            satellites=14,
            ts_utc=_utc_now_iso(),
        )


class MavlinkGpsProvider(GpsProvider):
    """Reads real position off the flight controller over MAVLink.

    A background daemon thread drains the MAVLink stream and keeps only the most
    recent sample. Draining matters: pymavlink buffers, and if nobody reads it the
    backlog grows until `recv_match` starts handing you minutes-old positions - a
    detection geotagged with where the drone *was* is worse than no geotag.

    Two messages are combined (PRD section 8 names the first one explicitly):
        GLOBAL_POSITION_INT  fused lat/lon/alt/relative_alt/heading
        GPS_RAW_INT          fix quality + satellite count

    GLOBAL_POSITION_INT is the EKF-fused estimate, which is what you want for
    geotagging. GPS_RAW_INT is the raw receiver, used here only to judge whether
    the fused solution is trustworthy.
    """

    name = "mavlink"

    def __init__(
        self,
        url: str = "udp:127.0.0.1:14550",
        baud: int = 921600,
        max_age_s: float = 2.0,
        require_3d: bool = True,
        wait_for_heartbeat: bool = True,
        heartbeat_timeout_s: float = 30.0,
    ) -> None:
        self.url = url
        self.baud = baud
        self.max_age_s = max_age_s
        self.require_3d = require_3d
        self.wait_for_heartbeat = wait_for_heartbeat
        self.heartbeat_timeout_s = heartbeat_timeout_s

        self._conn = None
        self._thread = None      # type: Optional[threading.Thread]
        self._stop = threading.Event()
        self._lock = threading.Lock()

        # Guarded by _lock.
        self._lat = None         # type: Optional[float]
        self._lon = None         # type: Optional[float]
        self._alt_msl_m = 0.0
        self._rel_alt_m = 0.0
        self._heading = None     # type: Optional[float]
        self._fix_type = GPS_FIX_NONE
        self._sats = 0
        self._recv_mono = None   # type: Optional[float]
        self._recv_iso = ""

    def start(self) -> None:
        try:
            from pymavlink import mavutil
        except ImportError:
            raise RuntimeError(
                "pymavlink is not installed.\n"
                "    Nano : pip3 install -r jetson/requirements-nano.txt\n"
                "    Dev   : pip install pymavlink\n"
                "    Or run without a flight controller: --gps sim"
            )

        # A serial device is given as "/dev/ttyTHS1:921600" or just "/dev/ttyTHS1".
        device, baud = self.url, self.baud
        if device.startswith("/dev/") and ":" in device:
            device, _, baud_str = device.rpartition(":")
            baud = int(baud_str)

        print("[gps] connecting to {0}".format(device))
        self._conn = mavutil.mavlink_connection(device, baud=baud)

        if self.wait_for_heartbeat:
            print("[gps] waiting for heartbeat (timeout {0:.0f}s)".format(self.heartbeat_timeout_s))
            hb = self._conn.wait_heartbeat(timeout=self.heartbeat_timeout_s)
            if hb is None:
                raise RuntimeError(
                    "No MAVLink heartbeat from {0} after {1:.0f}s.\n"
                    "    Checks: is the link up, is the baud right, is another program\n"
                    "    (Mission Planner!) already holding the port exclusively?".format(
                        device, self.heartbeat_timeout_s
                    )
                )
            print("[gps] heartbeat from system {0} component {1}".format(
                self._conn.target_system, self._conn.target_component))

        self._stop.clear()
        self._thread = threading.Thread(target=self._reader, name="mavlink-gps")
        self._thread.daemon = True     # never block process exit on telemetry
        self._thread.start()

    def _reader(self) -> None:
        """Drain the stream forever, keeping only the newest values."""
        while not self._stop.is_set():
            try:
                msg = self._conn.recv_match(
                    type=["GLOBAL_POSITION_INT", "GPS_RAW_INT"],
                    blocking=True,
                    timeout=1.0,
                )
            except Exception as exc:            # noqa: BLE001 - a dropped link must not kill the thread
                print("[gps] read error: {0}".format(exc), file=sys.stderr)
                time.sleep(0.5)
                continue

            if msg is None:
                continue

            kind = msg.get_type()
            with self._lock:
                if kind == "GLOBAL_POSITION_INT":
                    # lat/lon arrive as degrees * 1e7, altitudes in mm.
                    self._lat = msg.lat / 1e7
                    self._lon = msg.lon / 1e7
                    self._alt_msl_m = msg.alt / 1000.0
                    self._rel_alt_m = msg.relative_alt / 1000.0
                    self._heading = None if msg.hdg == HEADING_UNKNOWN else msg.hdg / 100.0
                    self._recv_mono = time.monotonic()
                    self._recv_iso = _utc_now_iso()
                elif kind == "GPS_RAW_INT":
                    self._fix_type = int(msg.fix_type)
                    self._sats = int(msg.satellites_visible)

    def get_fix(self) -> Optional[GpsFix]:
        """Newest usable fix, or None.

        Returns None rather than a stale or low-quality position. Silently
        accepting either is how a detection ends up plotted in the wrong field.
        """
        with self._lock:
            if self._lat is None or self._recv_mono is None:
                return None

            age = time.monotonic() - self._recv_mono
            if age > self.max_age_s:
                return None

            if self.require_3d and self._fix_type < GPS_FIX_3D:
                return None

            return GpsFix(
                lat=self._lat,
                lon=self._lon,
                alt_msl_m=self._alt_msl_m,
                rel_alt_m=self._rel_alt_m,
                heading_deg=self._heading,
                fix_type=self._fix_type,
                satellites=self._sats,
                ts_utc=self._recv_iso,
            )

    def status(self) -> str:
        """One-line health string for the HUD overlay and startup diagnostics."""
        with self._lock:
            if self._lat is None:
                return "no position yet (fix_type={0}, sats={1})".format(self._fix_type, self._sats)
            age = time.monotonic() - self._recv_mono if self._recv_mono else float("inf")
            return "fix_type={0} sats={1} age={2:.1f}s".format(self._fix_type, self._sats, age)

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:      # noqa: BLE001 - closing a dead socket is not interesting
                pass


def make_provider(kind: str, **kwargs) -> GpsProvider:
    """Factory used by live_detect.py's --gps flag.

    Unknown kwargs are dropped per-provider so the CLI can pass one flat bag of
    options without knowing which provider consumes what.
    """
    kind = (kind or "none").lower()

    if kind == "mavlink":
        allowed = ("url", "baud", "max_age_s", "require_3d",
                   "wait_for_heartbeat", "heartbeat_timeout_s")
        return MavlinkGpsProvider(**{k: v for k, v in kwargs.items() if k in allowed})

    if kind == "sim":
        allowed = ("origin_lat", "origin_lon", "altitude_m", "speed_mps",
                   "leg_length_m", "lane_spacing_m", "lanes", "clock")
        return SimulatedGpsProvider(**{k: v for k, v in kwargs.items() if k in allowed})

    if kind in ("none", "null", "off"):
        return NullGpsProvider()

    raise ValueError("Unknown GPS provider '{0}'. Use mavlink, sim or none.".format(kind))


def main() -> int:
    """Standalone smoke test: print fixes until Ctrl-C.

        python3 jetson/gps.py --gps sim
        python3 jetson/gps.py --gps mavlink --url udp:127.0.0.1:14550
    """
    import argparse

    ap = argparse.ArgumentParser(
        description="AeroShield GPS provider smoke test.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--gps", default="sim", choices=["mavlink", "sim", "none"])
    ap.add_argument("--url", default="udp:127.0.0.1:14550",
                    help="MAVLink endpoint, e.g. udp:127.0.0.1:14550 or /dev/ttyTHS1:921600")
    ap.add_argument("--max-age-s", type=float, default=2.0)
    ap.add_argument("--allow-2d", action="store_true",
                    help="Accept a 2D fix. Altitude will be unreliable, so geo.py output will be too")
    ap.add_argument("--count", type=int, default=20, help="Samples to print (0 = forever)")
    args = ap.parse_args()

    gps = make_provider(
        args.gps,
        url=args.url,
        max_age_s=args.max_age_s,
        require_3d=not args.allow_2d,
    )

    printed = 0
    try:
        gps.start()
        while args.count == 0 or printed < args.count:
            fix = gps.get_fix()
            if fix is None:
                extra = gps.status() if hasattr(gps, "status") else ""
                print("no fix  {0}".format(extra))
            else:
                print("{0}  lat={1:.7f} lon={2:.7f} rel_alt={3:.1f}m hdg={4} fix={5} sats={6}".format(
                    fix.ts_utc, fix.lat, fix.lon, fix.rel_alt_m,
                    "n/a" if fix.heading_deg is None else "{0:.0f}".format(fix.heading_deg),
                    fix.fix_type, fix.satellites))
            printed += 1
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nStopped.")
    except RuntimeError as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1
    finally:
        gps.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
