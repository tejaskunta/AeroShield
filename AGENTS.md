# AGENTS.md

## Jetson constraints
- Target: Jetson Nano Developer Kit (`aarch64`, `t210ref`), JetPack 4.6 / L4T R32.7.6.
- **There is no virtualenv on the aircraft.** Two interpreters exist and they are not interchangeable:
  - `/usr/bin/python3.6` (3.6.9) — the **flight interpreter**. Has tensorrt 8.2.1.9, pycuda, cv2 4.1.1 *with* GStreamer 1.14.5, numpy 1.13.3, pymavlink 2.4.42, pyserial 3.5.
  - `/usr/bin/python3` (3.10.4) — cv2 4.12.0 **without** GStreamer and **without** TensorRT. Cannot run the detector.
  - `Makefile`'s `JETSON_PY ?= /usr/bin/python3.6` is therefore the one that matters, and `JETSON_CV_PATH` must be exported so cv2 is importable — both targets already do this.
- All code under `jetson/` must be **Python 3.6-safe**: no walrus operator, no dataclasses, no `from __future__ import annotations`, no f-string `=`, no `subprocess.run(capture_output=)`.
- `pip` for 3.6 is **broken** on this image (`lsb_release` in the wheel metadata). Do not try to fix it. Use `make deps-drone`, which cross-builds the payload on the laptop and installs into `~/.local/lib/python3.6/site-packages` with no pip, no sudo and no compiler.
- Access: `ssh jetson` (user kmit, LAN 10.11.101.241). Prefer `ssh-add ~/.ssh/id_ed25519`; never pass the passphrase through a command.
- Devices: Pixhawk on `/dev/ttyACM0`, CSI camera on `/dev/video0`.
- Do not change power mode, swap, JetPack/L4T, or system packages without explicit user approval.

## Aircraft filesystem layout
- `~/aeroshield/` — the **data** dir: `weights/` (including `best_512x288.engine`), `.env`, `logs/`, `spool/`. `logs/` and `spool/` are gitignored on the laptop and must never be rsynced over: `logs/detections.jsonl` is the append-only flight record and `spool/` is the offline queue of detections captured while the radio link was down. Uploading a laptop's spool would replay bench data as though it were measured in flight.
- `~/aeroshield/jetson/` — the **code** dir, populated by `make deploy`.
- Commands are run with cwd `~/aeroshield` and `ENTRY=jetson/live_detect.py`, so a path like `weights/best_512x288.engine` resolves against the data dir, not the code dir.

## Interpreters on the laptop (do not mix these up)
| path | version | pytest | requests | httpx | use for |
|---|---|---|---|---|---|
| `.venv312/bin/python` | 3.12.6 | yes | yes | no | `make test-local` → 119 passed |
| `backend/.venv/bin/python` | 3.12.6 | yes | no | yes | backend work, `scripts/create_api_key.py` |
| `/usr/local/bin/python3.12` | 3.12.6 | no | yes | no | anything importing `jetson/` (`scripts/verify_telemetry_path.py`) |
| `.venv/bin/python` | 3.14.6 | no | no | no | nothing — do not use |

`jetson/beacon.py` and `jetson/uplink.py` import `requests` lazily, so importing them is safe; only *running* the upload path needs an interpreter with `requests`.

## Make targets
- `make deploy`: rsync `jetson/` to the aircraft, excluding `logs/`, `spool/`, `.env` and `__pycache__/`.
- `make deps-drone`: build the Python 3.6 payload on the laptop and install pymavlink/pyserial into the aircraft's user site. Idempotent. Run once per drone before the first `make stream GPS=mavlink`.
- `make api`: run the backend on `0.0.0.0:8000`. uvicorn's default bind is `127.0.0.1`, which the drone cannot reach — it would spool every detection and report nothing while looking healthy.
- `make doctor`: pre-flight. Prints the laptop LAN address and checks *from the aircraft* that it can reach `/health`. Run before `make stream` and stop if it fails.
- `make bench`: run detector help on the aircraft (verifies the engine loads).
- `make stream`: headless live detection with the MJPEG stream enabled.
- `make run`: headless live detection.
- `make logs`: tail `logs/detections.jsonl` on the aircraft.
- `make test-local`: run the root pytest suite on the laptop.

Useful variables: `GPS=sim|mavlink` (default `sim`), `GPS_URL` (`/dev/ttyACM0:115200`), `GPS_MAX_AGE` (2.0), `MISSION` (`bench-jetson-1`), `CONF` (0.25), `STREAM_PORT` (8080), `ENTRY` (`jetson/live_detect.py`), `ENGINE` (`weights/best_512x288.engine`), `IMGSZ` (`288 512`), `BACKEND_URL`, and the `SIM_*` survey geometry.

## Mission name must agree across three places
The drone tags telemetry with `--mission-name` (from `make MISSION`), the frontend looks up its mission by `VITE_MISSION_NAME` in `frontend/.env.local`, and the API finds-or-creates by name. If they disagree the dashboard silently shows the simulator instead of live data. Set `VITE_MISSION_NAME` to exactly the name the drone posts with.

## Backend notes
- Health is **`/health`**, not `/api/health`.
- The frontend calls the backend through the relative base path `/api` (`frontend/src/lib/api.ts`), which the Vite dev server proxies. Do not point the browser at `:8000` directly.
- DB conventions in `app/db/base.py` use short constraint names; hand-written `op.create_table` migrations apply no convention, so live constraint names come out double-prefixed. That matches the existing `detections` table — it is the repo convention, not a bug.

## Tests
- Backend / API: `cd backend && ./.venv/bin/python -m pytest -q`.
- Root (jetson + scripts): `make test-local`, or `.venv312/bin/python -m pytest -q` → 119 passed.
- Frontend: `cd frontend && npm test`. This runs **Node's built-in test runner** (`node --experimental-strip-types --import ./scripts/register.mjs --test src/lib/*.test.ts`). There is no vitest and no jest — `npx vitest` will hang forever on an install prompt.
- Frontend build/typecheck: `cd frontend && npm run build` (runs `tsc --noEmit && vite build`).
