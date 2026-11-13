# AeroShield Jetson integration patch

## Files
- `live_detect.py`: your uploaded detector orchestration, with explicit coordinate-reference metadata and safe handling of unknown GPS horizontal error.
- `gps.py`: Python 3.6-compatible MAVLink GPS provider using one serial connection.
- `geo.py`: conservative aircraft-position association. It does NOT claim to calculate the detected object's ground coordinate.
- `uplink.py`: asynchronous JSON uploader, mission creation, and JSONL spool/replay.
- `run_aeroshield.sh`: launch command matching the current TensorRT/CSI setup.

## Install/check dependencies on Jetson
```bash
python3.6 -c "import cv2; print(cv2.__version__)"
python3.6 -c "from pymavlink import mavutil; print('pymavlink OK')"
python3.6 -c "import requests; print(requests.__version__)"
```
If requests is missing, install it into the same Python 3.6 environment used by the app:
```bash
python3.6 -m pip install requests
```

## Install
Back up your existing files first. Copy the files into the same directory as `live_detect.py` (the project folder used by your imports). Do not overwrite `detector.py`, `pipeline.py`, `stream.py`, model weights, or the TensorRT engine.

```bash
cd ~/aeroshield
cp live_detect.py live_detect.py.backup
cp gps.py gps.py.backup 2>/dev/null || true
cp geo.py geo.py.backup 2>/dev/null || true
cp uplink.py uplink.py.backup 2>/dev/null || true
```
Copy the supplied files from the extracted patch into `~/aeroshield/`.

## Configure and run
```bash
export AEROSHIELD_API_KEY='YOUR_REAL_API_KEY'
export AEROSHIELD_BACKEND_URL='http://YOUR_BACKEND_HOST:8000'
chmod +x run_aeroshield.sh
./run_aeroshield.sh
```

Do not run `pixhawk_telemetry.py` at the same time. `live_detect.py` now owns `/dev/ttyACM0`.

## Backend contract assumptions that MUST be verified
This patch uses:
- `POST /api/v1/missions` with JSON `{ "mission_name": "...", "status": "active" }`
- `POST /api/v1/detections` with one JSON detection record
- API key header `X-API-Key`

These details were not confirmed by the uploaded backend router source. Change `uplink.py` if your actual backend uses a different header, route, or request schema. The uploaded roadmap is a feature plan, not the implemented FastAPI contract.

The uploader sends metadata JSON only. Image/Grad-CAM multipart upload is disabled because the supplied backend contract does not define its upload format.

## Coordinate safety
`latitude` and `longitude` in this patch are the aircraft GPS position at the detection time. `coordinate_reference` is `aircraft_gps_position`, and `target_ground_coordinate_available` is false. This is an honest capture-location association, NOT the detected object's exact ground coordinate.

To compute object ground coordinates, calibrate camera intrinsics/FOV, camera-to-body mounting rotation, camera pitch/roll offset, timestamp synchronization, terrain/ground plane, and use vehicle attitude + altitude in a ray/ground intersection. Validate the result against surveyed test points before relying on it.

## Critical missing source files
Your uploaded materials did not include `detector.py`, `pipeline.py`, `stream.py`, or the actual backend router/models. This patch preserves those imports and cannot validate their interfaces. The actual backend API and database persistence still need an end-to-end test.
