#!/usr/bin/env python3
"""Inject a test landmine detection (image + coordinates) through the real pipeline.

    python scripts/inject_detection.py --image mine.jpg --lat 17.396990 --lon 78.490760

Posts to the backend's dev-only POST /api/detections/test-inject, which runs the
same steps as the drone's upload: the ingest row, the stored frame, and the live
socket broadcast. If a pin with this photo appears on the dashboard, the backend,
database, WebSocket and map all work. The row is stamped `manual-test`, and the
dashboard labels it "Test injection", never "Flown".

Defaults come from frontend/.env.local: VITE_DASHBOARD_KEY and VITE_MISSION_NAME.
Standard library only, so it runs with any Python 3.
"""
import argparse
import json
import mimetypes
import os
import re
import struct
import sys
import urllib.error
import urllib.request
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env_value(name):
    for fname in (".env.local", ".env"):
        path = os.path.join(REPO, "frontend", fname)
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"\s*{0}\s*=\s*['\"]?([^'\"\r\n]*)['\"]?\s*$".format(name), line)
                    if m and m.group(1).strip():
                        return m.group(1).strip()
        except OSError:
            pass
    return None


def image_size(data):
    """(width, height) of a JPEG or PNG, without Pillow."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            length = struct.unpack(">H", data[i + 2:i + 4])[0]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            i += 2 + length
    raise ValueError("not a JPEG or PNG, or no size header found")


def multipart(fields, file_field, filename, data):
    boundary = uuid.uuid4().hex
    out = []
    for k, v in fields.items():
        out.append("--{0}\r\nContent-Disposition: form-data; name=\"{1}\"\r\n\r\n{2}\r\n".format(boundary, k, v).encode())
    ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    out.append("--{0}\r\nContent-Disposition: form-data; name=\"{1}\"; filename=\"{2}\"\r\nContent-Type: {3}\r\n\r\n"
               .format(boundary, file_field, os.path.basename(filename), ctype).encode())
    out.append(data)
    out.append("\r\n--{0}--\r\n".format(boundary).encode())
    return b"".join(out), "multipart/form-data; boundary=" + boundary


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--confidence", type=float, default=0.82)
    ap.add_argument("--mission", default=None, help="default: VITE_MISSION_NAME")
    ap.add_argument("--key", default=None, help="default: VITE_DASHBOARD_KEY")
    ap.add_argument("--backend-url", default="http://127.0.0.1:8000")
    args = ap.parse_args()

    key = args.key or env_value("VITE_DASHBOARD_KEY")
    mission = args.mission or env_value("VITE_MISSION_NAME")
    if not key or not mission:
        sys.exit("need a key and a mission: set them in frontend/.env.local or pass --key / --mission")

    with open(args.image, "rb") as f:
        data = f.read()
    w, h = image_size(data)
    bw, bh = w * 0.2, h * 0.2
    fields = {
        "latitude": "{0:.7f}".format(args.lat), "longitude": "{0:.7f}".format(args.lon),
        "mission_name": mission, "confidence": "{0:.2f}".format(args.confidence),
        "frame_width": w, "frame_height": h,
        "bbox_x1": int(w / 2 - bw / 2), "bbox_y1": int(h / 2 - bh / 2),
        "bbox_x2": int(w / 2 + bw / 2), "bbox_y2": int(h / 2 + bh / 2),
    }
    body, ctype = multipart(fields, "image", args.image, data)
    req = urllib.request.Request(args.backend_url.rstrip("/") + "/api/detections/test-inject", data=body,
                                 headers={"Content-Type": ctype, "X-API-Key": key}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            row = json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit("refused ({0}): {1}".format(e.code, e.read().decode(errors="replace")[:300]))
    except urllib.error.URLError as e:
        sys.exit("backend unreachable at {0}: {1}".format(args.backend_url, e.reason))
    print("injected D-{0:04d} into mission '{1}' at {2:.6f}, {3:.6f} ({4}x{5} frame)".format(
        row["id"], mission, args.lat, args.lon, w, h))
    print("labelled source={0}; it should appear on the dashboard within a second.".format(row.get("source")))


if __name__ == "__main__":
    main()
