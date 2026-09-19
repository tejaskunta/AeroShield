#!/usr/bin/env python3
"""
AeroShield - Live Detection System (Week 4 deliverable).

The module jetson/README.md promised and did not have: camera -> YOLO -> MAVLink
GPS -> geotag -> backend, with a local log as the fallback of record.

    Camera  ->  Detector  ->  GpsFix  ->  geo.bbox_to_latlon  ->  BackendUplink
                                                              \\-> detections.jsonl/.csv

Run it on a laptop with a webcam and no drone at all:

    python3 jetson/live_detect.py --detector mock --gps sim --headless --max-frames 60
    python3 jetson/live_detect.py --detector ultralytics --weights weights/best.pt --gps sim

Run it on the drone:

    python3 jetson/live_detect.py --detector trt --engine best.engine \\
        --gps mavlink --gps-url /dev/ttyTHS1:921600 \\
        --backend-url http://<server>:8000 --api-key $AEROSHIELD_API_KEY \\
        --mission-name field-test-1 --headless

Test against ArduPilot SITL before the real airframe (PRD section 10):

    --gps mavlink --gps-url udp:127.0.0.1:14550

The uploaded image is the CLEAN frame, encoded before the HUD is drawn on it. The
dashboard and the Week 7 Grad-CAM overlay both need the original pixels, not a
copy with our own boxes burned in.

PYTHON 3.6 ONLY - see the note at the top of infer_trt.py.
"""

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone

import cv2

# jetson/ is sys.path[0] when this file is run as a script, from any cwd.
from detector import make_detector
from geo import CameraModel, bbox_to_latlon
from gps import make_provider
from uplink import BackendUplink, new_client_id

DEFAULT_LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")

CSV_COLUMNS = [
    "captured_at", "client_detection_id", "mission_name", "class_name", "class_id",
    "confidence", "latitude", "longitude", "horizontal_error_m", "relative_altitude_m",
    "heading_deg", "gps_fix_type", "satellites_visible",
    "bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2", "inference_ms", "uploaded",
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class DetectionLog(object):
    """Append-only local log: the Week 4 "Detection Coordinate Database".

    Written before the network is touched, and independent of whether the upload
    succeeds. If the backend was never reachable for a whole flight, these two
    files are the mission record - so they are flushed on every write rather than
    buffered, because the interesting failure mode is losing power mid-flight.
    """

    def __init__(self, log_dir: str, mission_name: str) -> None:
        if not os.path.isdir(log_dir):
            os.makedirs(log_dir)
        self.mission_name = mission_name
        self.jsonl_path = os.path.join(log_dir, "detections.jsonl")
        self.csv_path = os.path.join(log_dir, "detections.csv")

        write_header = not os.path.exists(self.csv_path)
        self._jsonl = open(self.jsonl_path, "a")
        self._csv_fh = open(self.csv_path, "a", newline="")
        self._csv = csv.DictWriter(self._csv_fh, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        if write_header:
            self._csv.writeheader()
            self._csv_fh.flush()

    def write(self, record, uploaded: bool) -> None:
        row = dict(record)
        row["mission_name"] = self.mission_name
        row["uploaded"] = "yes" if uploaded else "spooled"

        self._jsonl.write(json.dumps(row) + "\n")
        self._jsonl.flush()
        self._csv.writerow(row)
        self._csv_fh.flush()

    def close(self) -> None:
        for fh in (self._jsonl, self._csv_fh):
            try:
                fh.close()
            except Exception:            # noqa: BLE001
                pass


def open_source(source: str, width: int, height: int):
    """Open a camera index, a video file or a still image.

    Returns (capture_or_None, single_frame_or_None).
    """
    if source.isdigit():
        cap = cv2.VideoCapture(int(source))
        if width:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        if height:
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        if not cap.isOpened():
            raise RuntimeError(
                "Could not open camera {0}.\n"
                "    macOS: grant camera permission to your terminal in\n"
                "           System Settings > Privacy & Security > Camera.\n"
                "    Nano : check `ls /dev/video*` and that nothing else holds the device."
                .format(source)
            )
        return cap, None

    if source.lower().endswith((".mp4", ".avi", ".mov", ".mkv")):
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            raise RuntimeError("Could not open video {0}".format(source))
        return cap, None

    frame = cv2.imread(source)
    if frame is None:
        raise RuntimeError("Could not read image {0}".format(source))
    return None, frame


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="AeroShield Week 4 - live detection with GPS geotagging.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    src = p.add_argument_group("source")
    src.add_argument("--source", default="0",
                     help="Camera index ('0'), a video file, or a still image")
    src.add_argument("--width", type=int, default=1280, help="Requested capture width")
    src.add_argument("--height", type=int, default=720, help="Requested capture height")
    src.add_argument("--max-frames", type=int, default=0,
                     help="Stop after N frames (0 = until Ctrl-C). Use this for scripted tests")

    det = p.add_argument_group("detector")
    det.add_argument("--detector", default="mock", choices=["trt", "ultralytics", "mock"],
                     help="trt on the Nano, ultralytics on a PC, mock for plumbing tests")
    det.add_argument("--engine", default="best.engine", help="TensorRT engine (--detector trt)")
    det.add_argument("--weights", default="weights/best.pt", help="PyTorch weights (--detector ultralytics)")
    det.add_argument("--device", default="cpu", help="'0' for GPU, 'cpu' (--detector ultralytics)")
    det.add_argument("--imgsz", type=int, default=640)
    det.add_argument("--conf", type=float, default=0.25,
                     help="Confidence threshold. Lower favours recall - see PRD section 9")
    det.add_argument("--iou", type=float, default=0.45)
    det.add_argument("--names", nargs="*", default=None,
                     help="Class names in TRAINING order - must match data.yaml exactly")
    det.add_argument("--mock-every-n", type=int, default=15,
                     help="Frames between synthetic detections (--detector mock)")

    gps = p.add_argument_group("gps")
    gps.add_argument("--gps", default="sim", choices=["mavlink", "sim", "none"])
    gps.add_argument("--gps-url", default="udp:127.0.0.1:14550",
                     help="MAVLink endpoint: udp:127.0.0.1:14550 (SITL) or /dev/ttyTHS1:921600")
    gps.add_argument("--gps-max-age", type=float, default=2.0,
                     help="Reject fixes older than this many seconds")
    gps.add_argument("--allow-2d-fix", action="store_true",
                     help="Accept 2D fixes. Altitude is then unreliable, so geotags will be too")
    gps.add_argument("--sim-origin", nargs=2, type=float, default=[12.9716, 77.5946],
                     metavar=("LAT", "LON"), help="Origin for --gps sim")
    gps.add_argument("--sim-altitude", type=float, default=30.0, help="Altitude for --gps sim")

    cam = p.add_argument_group("camera geometry (needed to turn pixels into coordinates)")
    cam.add_argument("--hfov", type=float, default=62.2,
                     help="Horizontal field of view in degrees. A guessed value is a "
                          "systematic error on EVERY detection - measure it")
    cam.add_argument("--vfov", type=float, default=None,
                     help="Vertical FOV. Derived from the aspect ratio when omitted")

    net = p.add_argument_group("backend")
    net.add_argument("--backend-url", default="http://127.0.0.1:8000")
    net.add_argument("--api-key", default=os.environ.get("AEROSHIELD_API_KEY"),
                     help="Defaults to $AEROSHIELD_API_KEY")
    net.add_argument("--mission-name", default=None,
                     help="Mission to file detections under (created if new). "
                          "Default: aeroshield-<UTC timestamp>")
    net.add_argument("--no-uplink", action="store_true",
                     help="Log locally only; never contact the backend")
    net.add_argument("--no-images", action="store_true",
                     help="Send detection metadata but not the frame (saves bandwidth)")
    net.add_argument("--jpeg-quality", type=int, default=85)
    net.add_argument("--replay-spool", action="store_true",
                     help="Re-send detections spooled by an earlier run, then continue")

    out = p.add_argument_group("output")
    out.add_argument("--log-dir", default=DEFAULT_LOG_DIR)
    out.add_argument("--save-frames", default=None,
                     help="Directory to write annotated frames that contained a detection")
    out.add_argument("--headless", action="store_true",
                     help="Never call cv2.imshow - required over SSH")
    out.add_argument("--quiet", action="store_true", help="Only print detections and the summary")

    return p.parse_args()


def draw_hud(frame, dets, fps, gps_text, up_text) -> None:
    """Boxes, confidences and status. Drawn on a copy the backend never sees."""
    for d in dets:
        cv2.rectangle(frame, (d.x1, d.y1), (d.x2, d.y2), (0, 255, 0), 2)
        cv2.putText(frame, "{0} {1:.2f}".format(d.class_name, d.confidence),
                    (d.x1, max(15, d.y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

    lines = [
        "{0:.1f} FPS   {1} det".format(fps, len(dets)),
        "GPS: {0}".format(gps_text),
        "NET: {0}".format(up_text),
    ]
    for i, line in enumerate(lines):
        cv2.putText(frame, line, (10, 24 + i * 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)


def main() -> int:
    args = parse_args()

    mission_name = args.mission_name or "aeroshield-{0}".format(
        datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S"))

    if not args.quiet:
        print("=" * 74)
        print("AeroShield live detection - Week 4")
        print("=" * 74)
        print("  detector   : {0}".format(args.detector))
        print("  gps        : {0}".format(args.gps))
        print("  mission    : {0}".format(mission_name))
        print("  uplink     : {0}".format("disabled" if args.no_uplink else args.backend_url))
        print("")

    # -- build the pipeline ------------------------------------------------
    try:
        cap, still = open_source(args.source, args.width, args.height)
    except RuntimeError as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1

    try:
        detector = make_detector(
            args.detector,
            engine=args.engine, weights=args.weights, device=args.device,
            imgsz=args.imgsz, conf=args.conf, iou=args.iou, names=args.names,
            every_n=args.mock_every_n,
        )
    except (RuntimeError, ValueError) as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1

    gps = make_provider(
        args.gps,
        url=args.gps_url,
        max_age_s=args.gps_max_age,
        require_3d=not args.allow_2d_fix,
        origin_lat=args.sim_origin[0],
        origin_lon=args.sim_origin[1],
        altitude_m=args.sim_altitude,
    )

    uplink = None
    mission_id = None
    if not args.no_uplink:
        if not args.api_key:
            print("WARNING: no --api-key and $AEROSHIELD_API_KEY is unset. The backend will\n"
                  "         reject every POST with 401 and everything will spool to disk.\n"
                  "         Mint one with: python backend/scripts/create_api_key.py",
                  file=sys.stderr)
        uplink = BackendUplink(
            args.backend_url,
            api_key=args.api_key,
            send_images=not args.no_images,
        )

    log = None
    frames_seen = 0
    detections_total = 0
    geotagged_total = 0
    fps_ema = 0.0

    try:
        gps.start()

        if uplink is not None:
            uplink.start()
            if args.replay_spool:
                uplink.replay_spool()
            mission_id = uplink.ensure_mission(mission_name)
            if mission_id is None and not args.quiet:
                print("[live] no mission id - detections will spool until the backend returns")

        log = DetectionLog(args.log_dir, mission_name)
        if not args.quiet:
            print("[live] logging to {0}".format(log.jsonl_path))
            print("[live] Ctrl-C to stop\n")

        if args.save_frames and not os.path.isdir(args.save_frames):
            os.makedirs(args.save_frames)

        while True:
            if cap is not None:
                ok, frame = cap.read()
                if not ok:
                    break
            else:
                frame = still.copy()

            frames_seen += 1
            frame_h, frame_w = frame.shape[:2]

            cam = CameraModel(hfov_deg=args.hfov, image_width=frame_w,
                              image_height=frame_h, vfov_deg=args.vfov)

            t0 = time.time()
            dets = detector.detect(frame)
            inference_s = time.time() - t0
            fps_ema = (0.9 * fps_ema + 0.1 / max(inference_s, 1e-6)) if fps_ema else (1.0 / max(inference_s, 1e-6))

            # One fix for the whole frame: every box in it was seen at the same instant.
            fix = gps.get_fix()

            if dets:
                # Encode the CLEAN frame now, before the HUD goes on.
                image_bytes = None
                if uplink is not None and not args.no_images:
                    ok_enc, buf = cv2.imencode(
                        ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), args.jpeg_quality])
                    if ok_enc:
                        image_bytes = buf.tobytes()

                captured_at = utc_now_iso()
                for d in dets:
                    detections_total += 1
                    pos = bbox_to_latlon(cam, fix, d.x1, d.y1, d.x2, d.y2)
                    if pos is not None:
                        geotagged_total += 1

                    record = {
                        "client_detection_id": new_client_id(),
                        # Both are sent. mission_id is the fast path; mission_name is
                        # what makes a spooled record still filable hours later, when
                        # the mission may not have existed at capture time.
                        "mission_id": mission_id,
                        "mission_name": mission_name,
                        "class_name": d.class_name,
                        "class_id": d.class_id,
                        "confidence": round(float(d.confidence), 4),
                        "bbox_x1": d.x1, "bbox_y1": d.y1, "bbox_x2": d.x2, "bbox_y2": d.y2,
                        "frame_width": frame_w, "frame_height": frame_h,
                        "inference_ms": round(inference_s * 1000.0, 1),
                        "model_version": os.path.basename(
                            args.engine if args.detector == "trt" else args.weights),
                        "source": "jetson-{0}".format(args.detector),
                        "captured_at": captured_at,
                        # GPS block - all null when there is no usable fix.
                        "latitude": None, "longitude": None,
                        "altitude_m": None, "relative_altitude_m": None,
                        "heading_deg": None, "gps_fix_type": None,
                        "satellites_visible": None, "horizontal_error_m": None,
                    }

                    if fix is not None:
                        record["altitude_m"] = round(fix.alt_msl_m, 2)
                        record["relative_altitude_m"] = round(fix.rel_alt_m, 2)
                        record["heading_deg"] = (None if fix.heading_deg is None
                                                 else round(fix.heading_deg, 1))
                        record["gps_fix_type"] = fix.fix_type
                        record["satellites_visible"] = fix.satellites
                    if pos is not None:
                        record["latitude"] = round(pos.lat, 7)
                        record["longitude"] = round(pos.lon, 7)
                        record["horizontal_error_m"] = round(pos.horizontal_error_m, 2)

                    log.write(record, uploaded=uplink is not None)
                    if uplink is not None:
                        uplink.submit(record, image_bytes)
                        # One image per frame, not per box - the second box in the
                        # same frame would upload a byte-identical copy.
                        image_bytes = None

                    if not args.quiet:
                        if pos is not None:
                            print("  {0}  {1:<20} {2:.2f}  lat={3:.7f} lon={4:.7f} +/-{5:.1f}m"
                                  .format(captured_at, d.class_name, d.confidence,
                                          pos.lat, pos.lon, pos.horizontal_error_m))
                        else:
                            print("  {0}  {1:<20} {2:.2f}  NO GEOTAG (no usable GPS fix)"
                                  .format(captured_at, d.class_name, d.confidence))

            # -- display / save -------------------------------------------
            need_render = (not args.headless) or (args.save_frames and dets)
            if need_render:
                shown = frame.copy()
                gps_text = "no fix" if fix is None else "{0:.6f},{1:.6f} fix{2} sats{3}".format(
                    fix.lat, fix.lon, fix.fix_type, fix.satellites)
                up_text = "off" if uplink is None else str(uplink.stats)
                draw_hud(shown, dets, fps_ema, gps_text, up_text)

                if args.save_frames and dets:
                    out_path = os.path.join(
                        args.save_frames, "frame_{0:06d}.jpg".format(frames_seen))
                    cv2.imwrite(out_path, shown)

                if not args.headless:
                    cv2.imshow("AeroShield - live detection", shown)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break

            if args.max_frames and frames_seen >= args.max_frames:
                break
            if cap is None and not args.max_frames:
                break        # single still image, one pass

    except KeyboardInterrupt:
        if not args.quiet:
            print("\n[live] stopped by user")
    except RuntimeError as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1
    finally:
        if cap is not None:
            cap.release()
        if not args.headless:
            cv2.destroyAllWindows()
        detector.close()
        gps.close()
        if log is not None:
            log.close()
        if uplink is not None:
            uplink.close()

    # -- summary -----------------------------------------------------------
    print("")
    print("=" * 74)
    print("  frames processed   : {0}".format(frames_seen))
    print("  detections         : {0}".format(detections_total))
    print("  geotagged          : {0}{1}".format(
        geotagged_total,
        "" if detections_total == 0 else "  ({0:.0f}%)".format(
            100.0 * geotagged_total / detections_total)))
    if log is not None:
        print("  local log          : {0}".format(log.jsonl_path))
        print("                       {0}".format(log.csv_path))
    if uplink is not None:
        print("  uplink             : {0}".format(uplink.stats))
        pending = uplink.pending_spool_count()
        if pending:
            print("  spooled (pending)  : {0} record(s)".format(pending))
            print("                       drain with: python3 jetson/uplink.py --replay "
                  "--backend-url {0} --api-key ...".format(args.backend_url))
    if detections_total and not geotagged_total:
        print("")
        print("  NOTE: nothing was geotagged. Every detection is recorded but has no")
        print("        coordinates. Check the GPS: a 2D fix or a stale link both cause")
        print("        this deliberately, rather than writing a wrong position.")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
