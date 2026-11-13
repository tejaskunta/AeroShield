#!/usr/bin/env python3
"""AeroShield - aircraft position beacon.

Streams the aircraft's position to the backend so the dashboard can show where
the drone is. This is the counterpart to `uplink.BackendUplink`: that module
ships *detections*, this one ships *position*.

WHY IT IS A SEPARATE MODULE AND A SEPARATE THREAD.

Three properties the detection uplink has, this must NOT have:

    no spooling    A detection found while the link was down is evidence, and
                   replaying it hours later is the right thing to do. A position
                   from four minutes ago is not evidence of anything - it is a
                   wrong answer to "where is the drone?". Old positions are
                   worthless, so they are dropped rather than spooled. This is
                   the single most important difference between the two paths.

    no queue       The detection uplink queues up to 256 records and drains
                   them, because a detection must not be lost. Here a queue
                   would mean showing the aircraft where it *was*. The beacon
                   keeps exactly ONE pending frame - the newest - and overwrites
                   it. Position is a "latest value" problem, not a delivery
                   problem.

    latest wins    The camera runs at 30 FPS but the dashboard cannot use 30
                   positions a second; it is paced to a fixed interval and
                   always sends whatever the newest sample is at send time.

It gets its own thread for the same reason: if it shared the detection worker,
a queue of detections draining over a slow radio link would delay every
position update behind it, and the dashboard would show a stale drone precisely
when the link was busiest.

NOTHING HERE BLOCKS THE CALLER. `update()` takes a lock for as long as it takes
to copy a small dict and returns. The flight loop calls it once per frame and
must never wait on a socket - a drone cannot pause mid-frame for a TCP timeout.

PYTHON 3.6 ONLY - see the note at the top of infer_trt.py. No dataclasses, no
walrus, no builtin generics, no __future__ annotations.

Usage:
    from beacon import TelemetryBeacon

    beacon = TelemetryBeacon("http://10.11.101.135:8000", api_key="aero_...",
                             mission_id=mission_id, interval_s=1.0)
    beacon.start()
    beacon.update(fix)                       # once per frame, non-blocking
    beacon.close()
"""

import json
import sys
import threading
import time
from typing import Any, Dict, Optional

# Sent as the packet's own User-Agent so a backend log shows which client a burst
# of telemetry came from, without a second header to remember.
USER_AGENT = "aeroshield-beacon/1.0"

# How long to wait before printing the same transport failure again. An
# unreachable backend at 1 Hz would otherwise print a line per second for the
# whole flight and bury the inference log.
COMPLAIN_INTERVAL_S = 30.0


class BeaconStats(object):
    """Plain counters, read by the HUD and the end-of-run summary."""

    def __init__(self) -> None:
        self.sent = 0
        self.failed = 0
        self.overwritten = 0   # frames replaced before they were sent

    def __str__(self) -> str:
        return "pos_sent={0} pos_failed={1} pos_dropped={2}".format(
            self.sent, self.failed, self.overwritten)


class TelemetryBeacon(object):
    """Posts the newest aircraft position to the mission telemetry endpoint.

    Construct with `mission_id=None` and it stays inert - that is the spool-only
    mode live_detect.py already falls back to when the backend cannot be reached
    at startup, and an inert beacon is better than one that retries a 404 for the
    whole flight.
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        mission_id: Optional[int] = None,
        interval_s: float = 1.0,
        timeout_s: float = 3.0,
        verify_tls: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.mission_id = mission_id
        self.interval_s = interval_s
        self.timeout_s = timeout_s
        self.verify_tls = verify_tls

        self.stats = BeaconStats()

        # Latest-value slot. Guarded by its own lock, never by the worker's.
        self._lock = threading.Lock()
        self._pending = None            # type: Optional[Dict[str, Any]]
        self._has_pending = False

        self._thread = None             # type: Optional[threading.Thread]
        self._stop = threading.Event()
        self._session = None
        self._last_complaint = 0.0

        if mission_id is not None:
            self.url = "{0}/api/missions/{1}/telemetry".format(
                self.base_url, mission_id)
        else:
            self.url = None

    # -- lifecycle ---------------------------------------------------------
    def _requests(self):
        try:
            import requests
        except ImportError:
            raise RuntimeError(
                "requests is not installed.\n"
                "    Nano : pip3 install -r jetson/requirements-nano.txt\n"
                "    Dev   : pip install requests"
            )
        return requests

    @property
    def enabled(self) -> bool:
        """False when there is no mission to file positions against."""
        return self.url is not None

    def start(self) -> None:
        """Start the sender thread. A no-op when not enabled."""
        if not self.enabled or self._thread is not None:
            return

        requests = self._requests()
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": USER_AGENT})
        if self.api_key:
            # Sent as X-API-Key, matching the backend's APIKeyHeader. The drone
            # holds a drone:ingest key, which is what the ingest route requires -
            # a dashboard key must not be able to forge a position.
            self._session.headers.update({"X-API-Key": self.api_key})

        self._stop.clear()
        self._thread = threading.Thread(target=self._worker, name="telemetry-beacon")
        self._thread.daemon = True      # never hold the interpreter open
        self._thread.start()

    def close(self, timeout_s: float = 2.0) -> None:
        """Stop the thread. Any unsent frame is dropped, not flushed.

        Deliberately no final flush: the newest frame is at most one interval
        old and the dashboard will show "offline" on its own once frames stop
        arriving. Blocking shutdown to deliver a position that is about to be
        stale would be worth nothing.
        """
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout_s)
            self._thread = None
        if self._session is not None:
            try:
                self._session.close()
            except Exception:           # noqa: BLE001
                pass
            self._session = None

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False

    # -- public API --------------------------------------------------------
    def update(self, frame: Optional[Dict[str, Any]]) -> None:
        """Offer the newest position. Never blocks, never raises.

        `frame` is a dict of JSON-ready fields (see `frame_from_fix`). Passing
        None is legal and means "no usable fix right now" - the previous frame
        is left alone rather than replaced with a hole, because the last known
        position is still the best answer available and the dashboard ages it
        out on its own.
        """
        if frame is None or not self.enabled:
            return
        with self._lock:
            # Overwriting an unsent frame is normal, not an error - at 30 FPS
            # into a 1 Hz beacon most samples are superseded before they leave.
            if self._has_pending:
                self.stats.overwritten += 1
            self._pending = frame
            self._has_pending = True

    def _take(self) -> Optional[Dict[str, Any]]:
        """Atomically claim the pending frame, leaving the slot empty."""
        with self._lock:
            if not self._has_pending:
                return None
            frame = self._pending
            self._pending = None
            self._has_pending = False
            return frame

    # -- worker ------------------------------------------------------------
    def _worker(self) -> None:
        """Send at most one frame per interval, always the newest available.

        Paced by a deadline rather than `sleep(interval)` inside the send, so a
        slow POST (up to timeout_s) does not shift the cadence or stack up: the
        next send is due `interval_s` after the last one fired, and if the
        previous send took longer than that it fires again immediately with
        whatever is newest.
        """
        next_at = time.time()
        while not self._stop.is_set():
            delay = next_at - time.time()
            if delay > 0:
                # Wakes early only on close().
                self._stop.wait(delay)
                if self._stop.is_set():
                    break

            frame = self._take()
            if frame is not None:
                self._post(frame)

            next_at = max(next_at + self.interval_s, time.time())

    def _post(self, frame: Dict[str, Any]) -> None:
        """One POST. Every failure is counted and swallowed."""
        if self._session is None:
            return
        try:
            resp = self._session.post(
                self.url, json=frame, timeout=self.timeout_s,
                verify=self.verify_tls,
            )
        except Exception as exc:        # noqa: BLE001
            self.stats.failed += 1
            self._complain("position POST failed ({0})".format(exc))
            return

        if 200 <= resp.status_code < 300:
            self.stats.sent += 1
            return

        self.stats.failed += 1
        # 401/403/404/422 will not fix themselves by retrying, so they are worth
        # saying loudly - but still only once every COMPLAIN_INTERVAL_S, because
        # this runs at 1 Hz and an unreadable log is worse than a terse one.
        self._complain("position POST returned HTTP {0} {1}".format(
            resp.status_code, resp.text[:160]))

    def _complain(self, message: str) -> None:
        """Print a transport failure, rate-limited.

        Without the limit an unreachable backend prints a line per second for the
        whole flight, which buries the inference log and the detections summary.
        """
        now = time.time()
        if now - self._last_complaint < COMPLAIN_INTERVAL_S:
            return
        self._last_complaint = now
        print("[beacon] {0}".format(message), file=sys.stderr)


# --------------------------------------------------------------------------
# Frame construction
# --------------------------------------------------------------------------

# gps.py reports fix_type as the raw MAVLink GPS_FIX_TYPE integer (0 none, 2 two-
# dimensional, 3 three-dimensional, 6 RTK fixed), which is exactly the range the
# backend's gps_fix_type column stores - so the integer passes straight through
# and this map exists only so a caller holding a *name* still works. Kept here
# rather than imported from gps.py so this module stays importable without
# pymavlink, which is what lets it be unit-tested on a laptop.
_FIX_TYPE_BY_NAME = {
    "no-fix": 0,
    "no_fix": 0,
    "none": 0,
    "2d": 2,
    "3d": 3,
    "rtk": 6,      # GPS_FIX_TYPE_RTK_FIXED. The strong case; RTK float (5) is
                   # rare enough on this airframe not to need its own name.
}


# Aircraft state the flight loop knows and the GPS receiver does not. Named here
# so `frame_from_fix` and its callers cannot drift apart on spelling.
EXTRA_FIELDS = (
    "battery_pct", "battery_volts", "link_pct",
    "flight_mode", "armed", "ground_speed_ms",
)


def frame_from_fix(fix, extra: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Turn a `gps.GpsFix` into the beacon's JSON payload, or None if unusable.

    Returns None rather than a half-filled frame when the fix has no position.
    The ingest schema requires latitude and longitude, and a beacon that posts
    (0, 0) because a receiver had not locked would put the aircraft in the Gulf
    of Guinea - the same failure the dashboard fixtures were fixed to avoid.
    """
    if fix is None:
        return None

    lat = getattr(fix, "lat", None)
    lon = getattr(fix, "lon", None)
    if lat is None or lon is None:
        return None
    # 0,0 is the classic "receiver has not locked" value, not a place. The
    # backend accepts it as valid coordinates, so it is rejected here.
    if abs(lat) < 1e-7 and abs(lon) < 1e-7:
        return None

    now_ms = int(time.time() * 1000)
    frame = {
        "latitude": float(lat),
        "longitude": float(lon),
        # The backend parses this into a tz-aware datetime and rejects a naive
        # one, so the Z is load-bearing, not decoration.
        "captured_at": _fix_timestamp(fix, now_ms),
    }

    altitude = getattr(fix, "alt_msl_m", None)
    if altitude is not None:
        frame["altitude_m"] = round(float(altitude), 2)
    rel_alt = getattr(fix, "rel_alt_m", None)
    if rel_alt is not None:
        frame["relative_altitude_m"] = round(float(rel_alt), 2)
    heading = getattr(fix, "heading_deg", None)
    if heading is not None:
        # The schema rejects exactly 360 (0 <= heading < 360); a receiver that
        # reports 360.0 means north, which is 0.
        frame["heading_deg"] = round(float(heading) % 360.0, 1)

    satellites = getattr(fix, "satellites", None)
    if satellites is not None:
        frame["satellites_visible"] = int(satellites)

    fix_type = getattr(fix, "fix_type", None)
    if fix_type is not None:
        # gps.py hands back the MAVLink integer, which needs no translation. The
        # name lookup is here so a caller that has a label instead of a number - a
        # simulator, a test fixture - produces the same column value.
        if isinstance(fix_type, str):
            mapped = _FIX_TYPE_BY_NAME.get(fix_type.lower())
            if mapped is not None:
                frame["gps_fix_type"] = mapped
        else:
            frame["gps_fix_type"] = int(fix_type)

    # Aircraft state that only the flight loop knows - battery, mode, armed.
    if extra:
        for key in EXTRA_FIELDS:
            value = extra.get(key)
            if value is not None:
                frame[key] = value

    return frame


def _fix_timestamp(fix, now_ms: int) -> str:
    """The sample's own UTC time, falling back to now if it has none.

    Preferring the fix's timestamp over the clock at send time matters on a
    spooled or delayed frame: the position was observed when the fix was taken,
    and labelling it with the moment the beacon got round to posting it would
    compress the track wherever the link lagged. `ts_utc` is already an
    ISO-8601 string from gps.py, so it is passed through untouched.
    """
    ts = getattr(fix, "ts_utc", None)
    if isinstance(ts, str) and ts.strip():
        return ts
    return _iso_utc(now_ms)


def _iso_utc(epoch_ms: int) -> str:
    """ISO-8601 UTC, e.g. 2026-08-24T14:23:17.481Z.

    Written by hand rather than with strftime("%Y-%m-%dT%H:%M:%S.%fZ") because
    that emits microseconds (six digits) and consumers expecting milliseconds
    parse the last three as a timezone offset. Truncating to milliseconds and
    appending Z keeps it unambiguous.
    """
    seconds, millis = divmod(int(epoch_ms), 1000)
    return "{0}.{1:03d}Z".format(
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(seconds)), millis)


def main() -> int:
    """Self-test: build one frame and print it. No network, no pymavlink."""
    class _Fix(object):
        lat = 17.396947
        lon = 78.490706
        alt_msl_m = 472.5
        rel_alt_m = 4.2
        heading_deg = 90.0
        satellites = 14
        fix_type = 3              # MAVLink GPS_FIX_3D
        ts_utc = "2026-08-24T14:23:17.481Z"

    frame = frame_from_fix(_Fix(), extra={"battery_pct": 78, "armed": True})
    if frame is None:
        print("frame_from_fix rejected the sample fix", file=sys.stderr)
        return 1
    print(json.dumps(frame, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())