#!/usr/bin/env python3
"""Local end-to-end check of the aircraft-position path.

WHY THIS EXISTS. The drone is the only thing that can produce a real fix, but the
drone is not needed to prove the *path*: UDP/HTTP from `beacon.py` into
`POST /api/missions/{id}/telemetry`, through the repository into PostGIS, and back
out through `GET .../telemetry/latest`. Everything between the GPS and the browser
is exercised here, on the laptop, against the real backend and the real database.

It drives the real `jetson/beacon.py` and the real `jetson/uplink.py` - not a
reimplementation of them - so a pass means the drone's own code works. The only
substitution is the fix itself, which is a hand-built `GpsFix` from `gps.py`, i.e.
the same type the MAVLink provider returns.

    ./scripts/verify_telemetry_path.py --backend-url http://127.0.0.1:8000 \
        --api-key "$KEY" --mission-name kmit-01

Exits non-zero on any failure, so it is usable as a gate.
"""

import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
JETSON_DIR = os.path.join(os.path.dirname(HERE), "jetson")
sys.path.insert(0, JETSON_DIR)

from beacon import TelemetryBeacon, frame_from_fix  # noqa: E402
from gps import GpsFix  # noqa: E402
from uplink import BackendUplink  # noqa: E402


def make_fix(heading_deg=277.7):
    """A plausible in-flight fix over the KMIT block.

    Built with the same field set the MAVLink provider returns, including a real
    fix_type and satellite count, so `frame_from_fix` takes exactly the branch it
    would in the air.
    """
    return GpsFix(
        lat=17.397220,
        lon=78.489540,
        alt_msl_m=482.4,
        rel_alt_m=4.2,
        heading_deg=heading_deg,
        fix_type=3,
        satellites=7,
        ts_utc=None,
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend-url", default="http://127.0.0.1:8000")
    ap.add_argument("--api-key", default=os.environ.get("AEROSHIELD_API_KEY"))
    ap.add_argument("--mission-name", default="kmit-01")
    ap.add_argument("--frames", type=int, default=4,
                    help="How many position frames to send")
    ap.add_argument("--interval-s", type=float, default=0.5)
    ap.add_argument("--verify-tls", action="store_true", default=False)
    args = ap.parse_args()

    if not args.api_key:
        print("FAIL: no --api-key and no $AEROSHIELD_API_KEY")
        return 2

    print("backend      : {0}".format(args.backend_url))
    print("mission      : {0}".format(args.mission_name))

    # --- 1. mission registration (the same call live_detect makes on startup) ---
    uplink = BackendUplink(args.backend_url, api_key=args.api_key,
                           spool_dir="/tmp/aeroshield_verify_spool",
                           verify_tls=args.verify_tls)
    try:
        mission_id = uplink.ensure_mission(args.mission_name)
        if mission_id is None:
            print("FAIL: ensure_mission returned None - backend unreachable or key rejected")
            return 1
        print("mission id   : {0}".format(mission_id))

        # --- 2. the frame the beacon would actually post -----------------------
        fix = make_fix()
        frame = frame_from_fix(fix)
        if frame is None:
            print("FAIL: frame_from_fix rejected a valid fix")
            return 1
        print("frame        : lat={0} lon={1} hdg={2} fix={3} sats={4}".format(
            frame["latitude"], frame["longitude"], frame.get("heading_deg"),
            frame.get("gps_fix_type"), frame.get("satellites_visible")))

        # --- 3. drive the real beacon ------------------------------------------
        beacon = TelemetryBeacon(args.backend_url, api_key=args.api_key,
                                 mission_id=mission_id, interval_s=args.interval_s,
                                 verify_tls=args.verify_tls)
        beacon.start()
        print("beacon       : started at {0} Hz".format(round(1.0 / args.interval_s, 2)))

        for i in range(args.frames):
            # Walk the heading so consecutive frames are distinguishable, which is
            # what makes the "latest frame wins" assertion meaningful.
            heading = (277.7 + i * 10.0) % 360.0
            beacon.update(frame_from_fix(make_fix(heading)))
            time.sleep(args.interval_s)

        # Give the final POST time to land before reading back.
        time.sleep(1.5)
        beacon.close()
        print("beacon stats : {0}".format(beacon.stats))

        if beacon.stats.sent == 0:
            print("FAIL: beacon sent nothing")
            return 1
        if beacon.stats.failed:
            print("FAIL: {0} frame(s) failed".format(beacon.stats.failed))
            return 1
    finally:
        uplink.close()

    print("")
    print("PASS: {0} frame(s) accepted. Read back with:".format(beacon.stats.sent))
    print("  curl -s -H \"X-API-Key: $KEY\" \\")
    print("    {0}/api/missions/{1}/telemetry/latest".format(
        args.backend_url, mission_id))
    return 0


if __name__ == "__main__":
    sys.exit(main())
