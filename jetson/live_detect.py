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
    python3 jetson/live_detect.py --detector ultralytics --gradcam --headless
        # Grad-CAM overlays: laptop only (needs pytorch-grad-cam); the Nano
        # cannot run a backward pass, so --gradcam there warns and is skipped

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
import threading
import time
from datetime import datetime, timezone

import cv2

# jetson/ is sys.path[0] when this file is run as a script, from any cwd.
import pipeline as pipeline_mod
from detector import make_detector
from geo import CameraModel, bbox_to_latlon
from gps import make_provider
from stream import FrameBroadcaster, start_server
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


def open_source(source, width, height):
    """Open a camera index, a video file, a still image, or the Jetson CSI camera.

    Returns (capture_or_None, single_frame_or_None).

    Pass --source csi  to use the Jetson Nano CSI camera via the nvarguscamerasrc
    GStreamer pipeline.  All other values are unchanged from before.
    """
    # ------------------------------------------------------------------ CSI cam
    # nvarguscamerasrc is only available on JetPack. cv2.VideoCapture(0) silently
    # returns black frames on the Nano CSI port; GStreamer is mandatory there.
    if source.lower() == "csi":
        cap_w, cap_h = width or 1280, height or 720
        # Scale in nvvidconv (hardware) so videoconvert (CPU) only sees
        # ~640x360: a 720p BGRx->BGR convert every frame costs a full A57 core.
        # 512x288 engine needs no more than this; detector letterboxes anyway.
        if cap_w >= 1280 and cap_h >= 720:
            ds_w, ds_h = 640, 360
        else:
            ds_w, ds_h = cap_w, cap_h
        gst = (
            "nvarguscamerasrc ! "
            "video/x-raw(memory:NVMM), width=(int){w}, height=(int){h}, "
            "format=(string)NV12, framerate=(fraction)30/1 ! "
            "nvvidconv ! "
            "video/x-raw(memory:NVMM), width=(int){dw}, height=(int){dh}, "
            "format=(string)NV12 ! "
            "nvvidconv ! "
            "video/x-raw, format=(string)BGRx ! "
            "videoconvert ! "
            "video/x-raw, format=(string)BGR ! "
            "appsink drop=true max-buffers=1 sync=false"
        ).format(w=cap_w, h=cap_h, dw=ds_w, dh=ds_h)

        try:
            cap = cv2.VideoCapture(gst, cv2.CAP_GSTREAMER)
        except Exception as exc:
            raise RuntimeError(
                "cv2.VideoCapture raised while opening the GStreamer pipeline: {0}\n"
                "    This usually means OpenCV was built without GStreamer support.\n"
                "    On JetPack 4.6 use the system python3-opencv package.".format(exc)
            )

        if not cap.isOpened():
            raise RuntimeError(
                "Could not open the CSI camera via GStreamer.\n"
                "    1. Start the camera daemon:  sudo systemctl start nvargus-daemon\n"
                "    2. Confirm the CSI ribbon is seated and the camera is enabled\n"
                "       in /boot/extlinux/extlinux.conf (dtb overlay).\n"
                "    3. Re-run with --source csi after the daemon is running."
            )
        return cap, None

    # ----------------------------------------------------------------- USB cam
    if source.isdigit():
        cap = cv2.VideoCapture(int(source))
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # Minimize buffer lag
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

    # -------------------------------------------------------------- video file
    if source.lower().endswith((".mp4", ".avi", ".mov", ".mkv")):
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            raise RuntimeError("Could not open video {0}".format(source))
        return cap, None

    # ------------------------------------------------------------------- image
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
    det.add_argument("--detector", default="mock", choices=["trt", "onnx", "ultralytics", "mock"],
                     help="trt on the Nano, onnx/ultralytics on a PC, mock for plumbing tests")
    det.add_argument("--engine", default="best.engine", help="TensorRT engine (--detector trt)")
    det.add_argument("--weights", default="weights/best.pt", help="PyTorch weights (--detector ultralytics)")
    det.add_argument("--device", default="cpu", help="'0' for GPU, 'cpu' (--detector ultralytics)")
    det.add_argument("--imgsz", nargs="+", default=[640],
                     help="Inference size: 640, '288 512' ([H W]), or '512x288' "
                          "(WxH). Must match the ONNX/engine export size.")
    det.add_argument("--conf", type=float, default=0.25,
                     help="Confidence threshold. Lower favours recall - see PRD section 9")
    det.add_argument("--iou", type=float, default=0.45)
    det.add_argument("--names", nargs="*", default=None,
                     help="Class names in TRAINING order - must match data.yaml exactly")
    det.add_argument("--mock-every-n", type=int, default=15,
                     help="Frames between synthetic detections (--detector mock)")
    det.add_argument("--mock-delay", type=float, default=0.0,
                     help="Seconds each mock detect() call takes. Default 0 is "
                          "instant, which never applies back-pressure; set it to the "
                          "real engine latency (~0.17 rect, ~0.69 for 640) to exercise "
                          "the decoupled pipeline on the CPU with no GPU and no model")
    det.add_argument("--gradcam", action="store_true",
                     help="Attach Grad-CAM explainability overlays to detections. "
                          "Laptop + --detector ultralytics + pytorch-grad-cam only; "
                          "unavailable anywhere else, the run warns once and continues "
                          "without overlays - detections are never lost to them")
    det.add_argument("--gradcam-top-k", type=int, default=1,
                     help="Explain this many boxes per frame; the overlay is filed "
                          "against the first detection of the frame")

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
    out.add_argument("--stream-port", type=int, default=0,
                     help="Serve annotated frames as MJPEG on this port (0 = off)")
    out.add_argument("--decoupled", action="store_true",
                     help="Run capture and inference on separate threads. The preview "
                          "stream then runs at the CAMERA rate (30 FPS) while boxes "
                          "refresh at the DETECTION rate (~5-6 FPS). Without this the "
                          "stream is pinned to the detection rate. Only affects the "
                          "preview; detection, logging and upload are unchanged.")
    out.add_argument("--box-hold", type=float, default=1.5,
                     help="--decoupled only: seconds to keep the last boxes on screen "
                          "after a detecting frame, so a missed frame does not blank "
                          "the display (default 1.5)")
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

    # --imgsz accepts 640, '288 512' ([H W]), or '512x288' (WxH) -> [h, w].
    raw_sz = []
    flip_wh = False
    for tok in (args.imgsz if isinstance(args.imgsz, list) else [args.imgsz]):
        s = str(tok).lower()
        if "x" in s:
            flip_wh = True
            s = s.replace("x", " ")
        raw_sz.extend(s.split())
    try:
        dims = [int(v) for v in raw_sz]
    except ValueError:
        print("ERROR: --imgsz must be ints, got {0}".format(args.imgsz), file=sys.stderr)
        return 1
    if len(dims) == 1:
        args.imgsz = dims[0]
    elif len(dims) == 2:
        if flip_wh:
            dims = [dims[1], dims[0]]
        args.imgsz = dims
    else:
        print("ERROR: --imgsz takes 1 or 2 ints, got {0}".format(args.imgsz), file=sys.stderr)
        return 1

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
            every_n=args.mock_every_n, delay_s=args.mock_delay,
        )
    except (RuntimeError, ValueError) as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1

    # -- Grad-CAM (optional, laptop-only) ----------------------------------
    # Built once, reused every frame: loading YOLOv8 weights is the expensive
    # part, and the heatmap must come from the same model that drew the boxes -
    # so when the detector already holds an Ultralytics model we hand its weights
    # to the session instead of loading a second copy. Any failure here (no
    # pytorch-grad-cam, mock/trt detector with no torch model) disables overlays
    # with one warning; the detection pipeline itself is untouched.
    gradcam_session = None
    gradcam_mod = None
    if args.gradcam:
        try:
            import gradcam as gradcam_mod
        except ImportError as exc:
            print("WARNING: --gradcam disabled: cannot import gradcam.py ({0})".format(exc),
                  file=sys.stderr)
            gradcam_mod = None
        if gradcam_mod is not None:
            try:
                # Reuse the detector's weights when it holds an Ultralytics model;
                # pass the path otherwise. A heatmap from a different model than
                # the one drawing the boxes would be a lie.
                gradcam_session = gradcam_mod.GradCamSession(
                    weights=args.weights, device=args.device, imgsz=args.imgsz,
                    model=getattr(detector, "model", None),
                )
                if not args.quiet:
                    print("[gradcam] overlays enabled")
            except gradcam_mod.GradCamUnavailable as exc:
                print("WARNING: --gradcam disabled: {0}".format(exc), file=sys.stderr)
                gradcam_session = None

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
    broadcaster = None
    stream_server = None
    if args.stream_port:
        broadcaster = FrameBroadcaster()
        stream_server = start_server(args.stream_port, broadcaster)
        print("[stream] http://<jetson-ip>:{0}/".format(args.stream_port))
    geotagged_total = 0
    fps_ema = 0.0
    wall_start = time.time()
    stage_total = {"capture": 0.0, "detect": 0.0, "encode": 0.0, "render": 0.0}
    stage_count = {"capture": 0, "detect": 0, "encode": 0, "render": 0}

    def handle_detections(frame, dets, inference_s):
        """Geotag, log and queue whatever was found in ONE frame.

        This is the only place that produces uplink records, so it is the single
        source of database rows. It is called inline by the serial loop and from
        the inference thread in --decoupled mode - one implementation either way,
        so a schema change cannot land on one path and miss the other.

        Boxes that are merely DISPLAY state (persisted or carried over from an
        older frame) never reach here, so they can never be uploaded as if they
        had been measured on the current frame.

        Returns the GPS fix used, so callers can render the same one.
        """
        nonlocal detections_total, geotagged_total, gradcam_session

        frame_h, frame_w = frame.shape[:2]
        cam = CameraModel(hfov_deg=args.hfov, image_width=frame_w,
                          image_height=frame_h, vfov_deg=args.vfov)

        # One fix for the whole frame: every box in it was seen at the same instant.
        fix = gps.get_fix()

        t_enc = time.time()
        if dets:
            # Encode the CLEAN frame now, before the HUD goes on.
            image_bytes = None
            if uplink is not None and not args.no_images:
                ok_enc, buf = cv2.imencode(
                    ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), args.jpeg_quality])
                if ok_enc:
                    image_bytes = buf.tobytes()

            # One Grad-CAM overlay per frame, filed against the first
            # detection in it. A heatmap per box would re-run the backward
            # pass per box for marginal review value; top_k>1 is there for
            # dense scenes if a demo needs it. If the stack fails mid-run
            # (e.g. OOM on a gradient pass), overlays are disabled with one
            # warning - the detection keeps flowing, which is the contract.
            gradcam_bytes = None
            if gradcam_session is not None and uplink is not None and not args.no_images:
                d0 = dets[0]
                box0 = (d0.x1, d0.y1, d0.x2, d0.y2, d0.class_id,
                        float(d0.confidence), d0.class_name)
                try:
                    overlays = gradcam_session.explain(frame, [box0],
                                                       top_k=args.gradcam_top_k)
                    if overlays:
                        gradcam_bytes = gradcam_mod.encode_jpeg(overlays[0])
                except gradcam_mod.GradCamUnavailable as exc:
                    print("WARNING: --gradcam disabled mid-run: {0}".format(exc),
                          file=sys.stderr)
                    gradcam_session = None

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
                    uplink.submit(record, image_bytes, gradcam_bytes)
                    # One image (and one overlay) per frame, not per box - the
                    # second box in the same frame would upload a byte-identical
                    # copy of both.
                    image_bytes = None
                    gradcam_bytes = None

                if not args.quiet:
                    if pos is not None:
                        print("  {0}  {1:<20} {2:.2f}  lat={3:.7f} lon={4:.7f} +/-{5:.1f}m"
                              .format(captured_at, d.class_name, d.confidence,
                                      pos.lat, pos.lon, pos.horizontal_error_m))
                    else:
                        print("  {0}  {1:<20} {2:.2f}  NO GEOTAG (no usable GPS fix)"
                              .format(captured_at, d.class_name, d.confidence))
        stage_total["encode"] += time.time() - t_enc
        stage_count["encode"] += 1
        return fix

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

        active_display_dets = []
        det_persist_counter = 0

        if args.decoupled:
            # ------------------------------------------------------------------
            # Decoupled mode: capture and inference on separate threads.
            #
            # The preview stream runs at the CAMERA rate; boxes refresh at the
            # DETECTION rate. The serial loop below cannot do this - it calls
            # detect() inline, so a 690 ms detection caps the video at ~1.4 FPS.
            #
            # Detection, geotagging, logging and upload are IDENTICAL to the
            # serial path: both go through handle_detections(), which runs on the
            # inference thread here.
            #
            # A note on box persistence: the serial loop keeps the last boxes on
            # screen for 5 frames to stop a single missed frame from clearing the
            # display. Here capture and detection are decoupled, so the natural
            # equivalent is a TIME window rather than a frame count - a fixed
            # 5-capture-frame hold would be 0.16 s at 30 FPS and expire long
            # before the next detection arrives. pipeline.run_threaded applies
            # box_hold_s instead.
            # ------------------------------------------------------------------
            if cap is None:
                print("ERROR: --decoupled needs a live source (it cannot be used "
                      "with --source image).", file=sys.stderr)
                return 2

            stop_event = threading.Event()
            fps_box = [0.0]
            last_render_fix = [None]

            def render_and_publish(frame, boxes, fps, fresh, stats):
                """Thread A: annotate a copy and push the preview.

                `frame` is NEVER written to - it is still in the inference slot.
                """
                fps_box[0] = fps
                need_render = ((not args.headless) or (broadcaster is not None)
                               or bool(args.save_frames and fresh))
                if not need_render:
                    return

                fix = gps.get_fix()
                last_render_fix[0] = fix
                shown = frame.copy()
                gps_text = "no fix" if fix is None else "{0:.6f},{1:.6f} fix{2} sats{3}".format(
                    fix.lat, fix.lon, fix.fix_type, fix.satellites)
                up_text = "off" if uplink is None else str(uplink.stats)
                draw_hud(shown, boxes, fps, gps_text, up_text)

                if broadcaster is not None:
                    # Downscale before publish so the copy + JPEG encode are ~4x
                    # cheaper. Uplink images are encoded full-res on the
                    # inference thread from the clean frame; this is preview only.
                    pub = shown
                    if shown.shape[1] > 640:
                        scale = 640.0 / shown.shape[1]
                        pub = cv2.resize(shown, (640, int(shown.shape[0] * scale)),
                                         interpolation=cv2.INTER_LINEAR)
                    broadcaster.publish(pub)

                if args.save_frames and fresh:
                    out_path = os.path.join(
                        args.save_frames,
                        "frame_{0:06d}.jpg".format(stats.frames_captured))
                    cv2.imwrite(out_path, shown)

                if not args.headless:
                    cv2.imshow("AeroShield - live detection", shown)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        stop_event.set()

            try:
                pstats = pipeline_mod.run_threaded(
                    cap, detector, stop_event, handle_detections,
                    render_and_publish, max_frames=args.max_frames,
                    box_hold_s=args.box_hold)

                frames_seen = pstats.frames_captured
                print("")
                print("[pipeline] decoupled mode")
                print("           {0}".format(pstats))
                print("           capture {0:.1f} FPS / detection {1:.1f} FPS "
                      "(boxes refresh at the detection rate)".format(
                          pstats.capture_fps, pstats.detect_fps))
                if pstats.last_infer_s:
                    print("           last inference {0:.0f} ms".format(
                        pstats.last_infer_s * 1000.0))
            finally:
                stop_event.set()

        # The serial loop runs only when NOT decoupled. Both paths share the
        # cleanup and summary below, and both produce records through
        # handle_detections(), so they cannot drift apart.
        while not args.decoupled:
            t_cap = time.time()
            if cap is not None:
                ok, frame = cap.read()
                if not ok:
                    break
            else:
                frame = still.copy()
            stage_total["capture"] += time.time() - t_cap
            stage_count["capture"] += 1

            frames_seen += 1
            frame_h, frame_w = frame.shape[:2]

            t0 = time.time()
            dets = detector.detect(frame)
            inference_s = time.time() - t0
            stage_total["detect"] += inference_s
            stage_count["detect"] += 1
            fps_ema = (0.9 * fps_ema + 0.1 / max(inference_s, 1e-6)) if fps_ema else (1.0 / max(inference_s, 1e-6))

            fix = handle_detections(frame, dets, inference_s)

            # -- display / save -------------------------------------------
            # Keep the last boxes on screen for a few frames when a frame misses them.
            if dets:
                active_display_dets = dets
                det_persist_counter = 5
            elif det_persist_counter > 0:
                det_persist_counter -= 1
            else:
                active_display_dets = []

            need_render = (not args.headless) or bool(args.save_frames and dets) or (broadcaster is not None)
            if need_render:
                t_ren = time.time()
                shown = frame.copy()
                gps_text = "no fix" if fix is None else "{0:.6f},{1:.6f} fix{2} sats{3}".format(
                    fix.lat, fix.lon, fix.fix_type, fix.satellites)
                up_text = "off" if uplink is None else str(uplink.stats)
                draw_hud(shown, active_display_dets, fps_ema, gps_text, up_text)

                if broadcaster is not None:
                    # Downscale before publish so the copy + JPEG encode are ~4x
                    # cheaper. Uplink images (above) stay full-res; this is only
                    # the preview stream.
                    pub = shown
                    if shown.shape[1] > 640:
                        scale = 640.0 / shown.shape[1]
                        pub = cv2.resize(shown, (640, int(shown.shape[0] * scale)),
                                         interpolation=cv2.INTER_LINEAR)
                    broadcaster.publish(pub)
                stage_total["render"] += time.time() - t_ren
                stage_count["render"] += 1

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
        if broadcaster is not None:
            broadcaster.close()
        if stream_server is not None:
            stream_server.shutdown()
        if not args.headless:
            cv2.destroyAllWindows()
        detector.close()
        gps.close()
        if log is not None:
            log.close()
        if uplink is not None:
            uplink.close()

    # -- summary -----------------------------------------------------------
    wall_s = max(time.time() - wall_start, 1e-6)
    print("")
    print("=" * 74)
    print("  frames processed   : {0}".format(frames_seen))
    if args.decoupled:
        # In decoupled mode the two rates are different by design, so a single
        # "wall-clock FPS" would be actively misleading. Report both.
        print("  wall-clock FPS     : {0:.1f}  (capture; boxes refresh at the "
              "detection rate)".format(frames_seen / wall_s))
    else:
        print("  wall-clock FPS     : {0:.1f}".format(frames_seen / wall_s))
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
    for stage in ("capture", "detect", "encode", "render"):
        n = stage_count.get(stage, 0)
        if n:
            print("  stage {0:<8}: {1:7.1f} ms avg over {2}".format(
                stage, 1000.0 * stage_total[stage] / n, n))
    print("=" * 74)
    return 0


if __name__ == "__main__":
    sys.exit(main())
