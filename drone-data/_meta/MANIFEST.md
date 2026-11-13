# Drone snapshot — kmit-desktop (Jetson Nano)

Pulled 2026-11-13 ~16:48–16:49 local, via `rsync -az` over SSH from
`kmit@kmit-desktop.local:~/aeroshield/`.

## Status: PARTIAL — complete except `weights/`

| Item | Status |
|---|---|
| `aeroshield/jetson/` (code) | COMPLETE — 25M, all 11 `.py` md5-verified |
| `aeroshield/logs/` (flight record) | COMPLETE — 1.9M |
| `aeroshield/spool/` (offline queue) | COMPLETE — 642 files / 9.7M |
| `aeroshield/jetson/spool/` | COMPLETE — 1314 files |
| `aeroshield/bin/drone_watchdog.sh` | COMPLETE |
| `aeroshield/integration_patch (1)/` | COMPLETE |
| `aeroshield/.env` + backups | COMPLETE (**contains API key — do not commit**) |
| Loose scripts (build_engine, gps_check, mavlink_test, pixhawk_telemetry, gradcam, infer_trt) | COMPLETE |
| `aeroshield/weights/` | **Only the 2 `.engine` files are absent — see below** |
| `~/aeroshield` home extras (.bash_history, rtl8188fu, CSI-Camera, etc.) | **NOT PULLED** |

Total on disk: ~37M, 2006 files.

## Verification

- `logs/detections.jsonl` — **2234 lines** (matches drone exactly)
- `logs/detections.csv` — 2235 lines
- `spool/` — **642 files** (matches drone: 321 jpg + 321 json)
- `jetson/*.py` — all 11 md5s identical to the drone AND to the laptop repo:
  ```
  2511fd875fd2d9dcb8b1b86d16324e2c  jetson/beacon.py
  5e8fed4dba591cd2e3b000829f1877d3  jetson/detector.py
  58bdf3d718dd618341a9f68d34d63683  jetson/geo.py
  3c0287635c65cb21eabafdeb338b6e3b  jetson/gps_telemetry.py
  8407cba8bb62a9fa7cd082d17b65b085  jetson/gps.py
  c88942583937a71278e2b38b2685ef53  jetson/gradcam.py
  b942bc6663202e9fe256fbae342a679e  jetson/infer_trt.py
  9830ee7fe24a36b0477cc79f928e8433  jetson/live_detect.py
  7ca7c93e9f7cc97335abda9ca4b201d8  jetson/pipeline.py
  67f8ad5a9caee83c3d60edd7d0bb99ae  jetson/stream.py
  77139e1bf905fce54a5e0162d9188c5b  jetson/uplink.py
  ```

## Weights: nothing of value is missing

The 431M `weights/` directory did not transfer, but the three portable files
already exist in the repo and are **byte-size identical** to the drone's copies:

| file | drone bytes | repo bytes | match |
|---|---|---|---|
| `best.pt` | 52,033,099 | 52,033,099 | YES |
| `best_512x288.onnx` | 103,517,531 | 103,517,531 | YES |
| `best.onnx` | 103,625,106 | 103,625,106 | YES |

What genuinely did **not** transfer, and cannot be pulled now:

- `weights/best_512x288.engine` — 107,291,659 B (the **flight** engine)
- `weights/best.engine` — 84,801,198 B

Both are TensorRT engines built for this specific Jetson (JetPack 4.6,
TensorRT 8.2.1.9, aarch64). They are machine-specific build artifacts, not
source. Regenerate with `jetson/build_engine.sh` on any matching Jetson. Nothing
needed for laptop-side work is lost.

## Not pulled from the drone home directory

`~/.bash_history` (85,287 B), `~/rtl8188fu` (71M), `~/RTL8188FU` (20M),
`~/CSI-Camera`, `~/depth_cam`, `~/jetson-imx708`, `~/jetson-kernel`,
`~/jetson-utils`, `~/TerraVigil` (8K), `~/images`, `~/4.6.4_nano_imx708_v0.1.0.patch`
and the loose scripts (`safemine_sender.py`, `test_landmine_model.py`,
`test_pixhawk.py`, `yolo_camera.py`, `yolo_firebase.py`).

## What the pulled data actually contains

### `logs/detections.jsonl` — 2234 records, 15 missions

Provenance is **mixed**, which matters before any of it is treated as evidence:

| `source` | count |
|---|---|
| `jetson-mock` | 1253 |
| `jetson-onnx` | 518 |
| `jetson-trt` | 363 |
| `jetson-ultralytics` | 100 |

| `uploaded` | count |
|---|---|
| `spooled` | 1867 |
| `yes` | 367 |

**Only 367 of 2234 records (16%) ever reached the backend.** The rest are
offline-queue records that are still pending. `jetson-mock` (56% of the file)
is synthetic, not real detections.

Class labels are inconsistent across the file — `landmine_metal` (1253),
`landmine` (544), `class0` (337), `Landmine` (100). The `class0` label comes
from the TensorRT path, where the engine never had names baked in.

### `spool/` — 342 detection ids, 2016-10-16 → 2026-10-30

- **300 complete `jpg`+`json` pairs** (usable — image and metadata both present)
- **42 json-only orphans** (metadata without a frame; the image was never
  written or was already drained)

### `jetson/spool/` — 1314 files (647 jpg, 665 json, 1 `rejected`)

A second, larger spool nested inside the code dir. `rejected` is **empty**.

### `logs/live_detect.log` — the one run that actually worked

Records a full successful pipeline: CSI camera opened via Argus (1280x720 mode
5), `[gps] heartbeat from system 1 component 0` from a real Pixhawk on
`/dev/ttyACM0`, beacons posting to `/api/missions/1/telemetry` at 1.0 Hz, and
detections logging to `jetson/logs/detections.jsonl`. It ended with
`[gps] read error: device reports readiness to read but returned no data`
— the Pixhawk was unplugged mid-run.

### `logs/live_detect-console.err` — the later failure

Confirms the drone has since **lost the Pixhawk**:
`SerialException: [Errno 2] could not open port /dev/ttyACM0`. The camera still
opened fine. Because `--gps mavlink` is a hard requirement at startup, this is
fatal to the run — it died at `gps.start()` before any detection. The same
trace also shows the backend was unreachable (`Connection refused` on
127.0.0.1:8000), which is the tunnel being down.

### `bin/drone_watchdog.sh` — drone-only, and it never ran

4162 B, Nov 13 14:38. Relaunches `live_detect.py` on crash and writes one line
per restart to `logs/watchdog.log`, distinguishing "process died" (uptime
climbing) from "board rebooted" (uptime reset). Stops via
`logs/watchdog.stop`; rotates `detector.out` at 20 MB.

**This file is byte-identical to `scripts/drone_watchdog.sh` in the repo**
(md5 `b181ef3546203440ff1a002aaf56f673`) — nothing new to commit.

The real finding: **neither `logs/watchdog.log` nor `logs/detector.out` exists
on the drone, so it has never been executed.** It also sets
`PYTHONPATH=/usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages`,
which mixes the 3.6 and 3.10 paths — the exact shadowing that makes `import cv2`
fail. Worth fixing before trusting it.

### `aeroshield_jetson_integration_patch (1)/` — stale, superseded

All four `.py` files differ from the deployed copies and are **smaller**
(live_detect 817 vs 958 lines, gps differing by 728 lines). This is an older
patch snapshot; the deployed `jetson/` is ahead of it. Kept for reference only.

## Drone was NOT reachable afterwards

At home, `kmit-desktop.local` fails to resolve — the drone is on the lab LAN
(10.11.100.0/21) and is not on this network. Anything still on it requires being
back on that LAN.