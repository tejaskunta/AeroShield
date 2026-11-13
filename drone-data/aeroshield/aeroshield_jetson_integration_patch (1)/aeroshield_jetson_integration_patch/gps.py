#!/usr/bin/env python3
# Python 3.6 compatible AeroShield GPS provider.
import threading
import time
import math


class GpsFix(object):
    def __init__(self, lat, lon, alt_msl_m, rel_alt_m, heading_deg,
                 fix_type, satellites, timestamp, horizontal_error_m=None,
                 roll_rad=None, pitch_rad=None, yaw_rad=None):
        self.lat = float(lat)
        self.lon = float(lon)
        self.alt_msl_m = float(alt_msl_m)
        self.rel_alt_m = float(rel_alt_m)
        self.heading_deg = heading_deg
        self.fix_type = fix_type
        self.satellites = satellites
        self.timestamp = float(timestamp)
        self.horizontal_error_m = horizontal_error_m
        self.roll_rad = roll_rad
        self.pitch_rad = pitch_rad
        self.yaw_rad = yaw_rad


class NoGpsProvider(object):
    def start(self):
        pass

    def get_fix(self):
        return None

    def close(self):
        pass


class SimGpsProvider(object):
    def __init__(self, lat, lon, altitude_m):
        self.fix = GpsFix(lat, lon, altitude_m, altitude_m, 0.0,
                          3, 12, time.time(), 5.0)

    def start(self):
        self.fix.timestamp = time.time()

    def get_fix(self):
        self.fix.timestamp = time.time()
        return self.fix

    def close(self):
        pass


class MavlinkGpsProvider(object):
    def __init__(self, url, max_age_s=2.0, require_3d=True):
        self.url = url
        self.max_age_s = float(max_age_s)
        self.require_3d = bool(require_3d)
        self.master = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._position = None
        self._gps_raw = None
        self._attitude = None
        self._last_global_time = None

    def start(self):
        try:
            from pymavlink import mavutil
        except ImportError as exc:
            raise RuntimeError("pymavlink is not installed for this Python: {0}".format(exc))

        # Accept /dev/ttyACM0:115200, udp:127.0.0.1:14550, etc.
        endpoint = self.url
        baud = 115200
        if endpoint.startswith("/") and ":" in endpoint:
            possible_path, possible_baud = endpoint.rsplit(":", 1)
            if possible_baud.isdigit():
                endpoint, baud = possible_path, int(possible_baud)

        print("[gps] Connecting to Pixhawk: {0} (baud {1})".format(endpoint, baud))
        self.master = mavutil.mavlink_connection(endpoint, baud=baud)

        if self.master.wait_heartbeat(timeout=30) is None:
            raise RuntimeError("Pixhawk heartbeat not received within 30 seconds")

        print("[gps] MAVLink connected: system={0}, component={1}".format(
            self.master.target_system, self.master.target_component))

        # Request the same telemetry used by the standalone verification script.
        for msg_id in (33, 24, 30):  # GLOBAL_POSITION_INT, GPS_RAW_INT, ATTITUDE
            self.master.mav.command_long_send(
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
                0, msg_id, 500000, 0, 0, 0, 0, 0
            )

        self._thread = threading.Thread(target=self._reader, name="aeroshield-mavlink")
        self._thread.daemon = True
        self._thread.start()

    def _reader(self):
        while not self._stop.is_set():
            try:
                msg = self.master.recv_match(
                    type=["GPS_RAW_INT", "GLOBAL_POSITION_INT", "ATTITUDE"],
                    blocking=True, timeout=1
                )
            except Exception as exc:
                print("[gps] MAVLink receive error: {0}".format(exc))
                time.sleep(0.5)
                continue

            if msg is None:
                continue

            now = time.time()
            kind = msg.get_type()
            with self._lock:
                if kind == "GPS_RAW_INT":
                    eph = getattr(msg, "eph", 65535)
                    err = None if eph in (None, 65535, 0) else float(eph) / 100.0
                    self._gps_raw = {
                        "fix_type": int(getattr(msg, "fix_type", 0)),
                        "satellites": int(getattr(msg, "satellites_visible", 0)),
                        "horizontal_error_m": err,
                        "time": now
                    }
                elif kind == "GLOBAL_POSITION_INT":
                    lat = float(msg.lat) / 1e7
                    lon = float(msg.lon) / 1e7
                    # ArduPilot uses 0,0 before a valid position is available.
                    self._position = {
                        "lat": lat,
                        "lon": lon,
                        "alt_msl_m": float(msg.alt) / 1000.0,
                        "rel_alt_m": float(msg.relative_alt) / 1000.0,
                        "heading_deg": None if msg.hdg == 65535 else float(msg.hdg) / 100.0,
                        "time": now
                    }
                    self._last_global_time = now
                elif kind == "ATTITUDE":
                    self._attitude = {
                        "roll": float(msg.roll),
                        "pitch": float(msg.pitch),
                        "yaw": float(msg.yaw),
                        "time": now
                    }

    def get_fix(self):
        with self._lock:
            p = dict(self._position) if self._position else None
            g = dict(self._gps_raw) if self._gps_raw else None
            a = dict(self._attitude) if self._attitude else None

        now = time.time()
        if p is None or now - p["time"] > self.max_age_s:
            return None
        if not (-90.0 <= p["lat"] <= 90.0 and -180.0 <= p["lon"] <= 180.0):
            return None
        if p["lat"] == 0.0 and p["lon"] == 0.0:
            return None

        fix_type = g["fix_type"] if g else 0
        satellites = g["satellites"] if g else 0
        if self.require_3d and fix_type < 3:
            return None
        if g and now - g["time"] > max(self.max_age_s * 2.0, 3.0):
            return None

        return GpsFix(
            p["lat"], p["lon"], p["alt_msl_m"], p["rel_alt_m"],
            p["heading_deg"], fix_type, satellites, p["time"],
            g["horizontal_error_m"] if g else None,
            a["roll"] if a else None,
            a["pitch"] if a else None,
            a["yaw"] if a else None
        )

    def close(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        if self.master is not None:
            try:
                self.master.close()
            except Exception:
                pass


def make_provider(kind, url=None, max_age_s=2.0, require_3d=True,
                  origin_lat=12.9716, origin_lon=77.5946, altitude_m=30.0):
    kind = (kind or "none").lower()
    if kind == "mavlink":
        return MavlinkGpsProvider(url or "/dev/ttyACM0:115200",
                                  max_age_s=max_age_s, require_3d=require_3d)
    if kind == "sim":
        return SimGpsProvider(origin_lat, origin_lon, altitude_m)
    return NoGpsProvider()
