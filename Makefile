JETSON ?= jetson
JETSON_DIR ?= ~/aeroshield
JETSON_PY ?= /usr/bin/python3.6
JETSON_CV_PATH ?= /usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages

# The LAPTOP interpreter that runs the backend. An explicit path, not `python`:
# a bare `python` does not exist on a modern macOS, so `make api` used to die
# with "/bin/sh: python: command not found" before uvicorn ever started - which
# reads as "the backend is broken" rather than "the Makefile is". The backend
# venv is the right interpreter anyway: it has fastapi, uvicorn, the asyncpg
# driver and everything else app.main imports. Override with
# `make api BACKEND_PY=/usr/local/bin/python3.12` if you have no venv.
BACKEND_PY ?= $(CURDIR)/backend/.venv/bin/python

MISSION ?= kmit-01
MAX_FRAMES ?= 0
STREAM_PORT ?= 8080

# ---------------------------------------------------------------------------
# Where the drone posts its detections. This is the LAPTOP's LAN address, not
# the drone's - the drone is the client. It was hardcoded to 10.11.100.191,
# which is a DHCP lease that has almost certainly moved since it was written;
# a stale value here is invisible until you notice nothing ever arrives.
#
#   Re-derive with:  ipconfig getifaddr en0
#   Confirm it   :  make doctor
#
# WHY THIS IS 127.0.0.1 AND NOT THE LAPTOP'S LAN ADDRESS
# -----------------------------------------------------
# The drone is supposed to reach the laptop over the LAN, and on a healthy
# network it does. On THIS laptop it does not, and the failure is silent and
# very convincing:
#
#   * macOS Application Firewall is enabled (block-all off), and LuLu's network
#     system extension plus Malwarebytes' realtime daemon are both running.
#   * Loopback to 127.0.0.1 is fine. So is OUTBOUND from the laptop.
#   * LAN *inbound* to any listener owned by a binary that is not Apple-signed
#     is reset ("Empty reply from server", raw nc: "Connection reset by peer").
#     Measured, with everything else held constant:
#         /usr/bin/python3                 Apple-signed      works
#         /usr/bin/nc -l                   Apple-signed      works
#         /usr/local/bin/python3           Homebrew/ad-hoc   reset
#         backend/.venv/bin/python         Python.org        reset
#     The backend venv python is a symlink to
#     /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12, so a
#     LAN-bound uvicorn NEVER SEES THE REQUEST - it does not even log it. The
#     drone gets a reset, spools every detection, and the dashboard stays empty
#     while `curl 127.0.0.1:8000/health` reports the API perfectly healthy.
#
# The fix is a reverse SSH tunnel opened from this laptop:
#
#     ssh -N -R 8000:127.0.0.1:8000 jetson      # make tunnel
#
# The drone's sshd forwards its OWN loopback :8000 back over the existing,
# already-working SSH connection to the laptop's loopback :8000. Loopback is
# not filtered in either direction, so the payload does not matter - detections,
# the MJPEG camera stream, the websocket, all of it rides through untouched. It
# needs no admin rights, changes no firewall rule, and is the only route out.
#
# So: this value is the drone's VIEW of the backend, which is now its own
# loopback. It is NOT the laptop's address, and putting the laptop's LAN address
# here is exactly the bug this comment exists to prevent.
#
# Requires `make tunnel` to already be running. `make doctor` is the gate.
BACKEND_URL ?= http://127.0.0.1:8000

# ---------------------------------------------------------------------------
# The survey block's origin, as the dashboard sees it. This MUST equal
# VITE_SURVEY_ORIGIN in frontend/.env.local, or the aircraft is geotagged
# somewhere the map is not looking and the only honest reading available to an
# operator is that the drone has gone missing. The --gps sim default (Bengaluru)
# is ~600 km from the KMIT block, so passing this is not optional.
SURVEY_LAT ?= 17.396947
SURVEY_LON ?= 78.490706

# ---------------------------------------------------------------------------
# Simulated flight geometry, in metres. The dashboard's block is 10 x 10 m
# (frontend/src/lib/fixtures/mission.ts), so a track flown at the provider's
# defaults (60 m legs, 15 m lanes, 6 lanes) leaves the block within the first
# second and the drone is drawn off the edge of the survey for the rest of the
# run. Measured extents of the walk, relative to the survey origin:
#
#   60 m legs, 15 m lanes, 6 lanes  ->  east  0..60 m, north 0..75 m   (off the block)
#   10 m legs,  3 m lanes, 4 lanes  ->  east  0..10 m, north 0..9  m   (fits)
#
# Legs are flown EAST-WEST and lanes step NORTH, so leg length sets the east-west
# extent and lanes x spacing sets the north-south extent. Ten-metre legs put the
# aircraft's first lane exactly on the block's western edge and its return pass on
# the eastern edge, which is what makes the completed coverage hatch line up with
# the grid rather than overhanging it.
SIM_LEG_M ?= 10
SIM_LANE_M ?= 3
SIM_LANES ?= 4

# Everything the drone needs to know about where it is and what it is flying
# over, in one place so `run` and `stream` cannot drift apart.
SIM_FLAGS := --sim-origin $(SURVEY_LAT) $(SURVEY_LON) \
             --sim-leg-length $(SIM_LEG_M) \
             --sim-lane-spacing $(SIM_LANE_M) \
             --sim-lanes $(SIM_LANES)

# ---------------------------------------------------------------------------
# Where the aircraft believes it is.
#
#   make stream GPS=sim        software track. No Pixhawk needed. Default.
#   make stream GPS=mavlink    real position off the flight controller.
#
# This is the difference between a dashboard showing a plausible flight and a
# dashboard showing THIS flight. Both are useful; they are not the same claim.
#
# GPS=mavlink needs pymavlink and pyserial importable by $(JETSON_PY). The
# JetPack 4.6 image does not ship them and its pip cannot install them - see
# `make deps-drone` for the working path and the reason.
GPS ?= sim
GPS_URL ?= /dev/ttyACM0:115200
GPS_MAX_AGE ?= 2.0

ifeq ($(GPS),mavlink)
GPS_FLAGS := --gps mavlink --gps-url $(GPS_URL) --gps-max-age $(GPS_MAX_AGE)
else
GPS_FLAGS := --gps sim $(SIM_FLAGS)
endif

# Where live_detect.py lands on the aircraft, and how it is invoked. The flight
# code lives in a `jetson/` directory INSIDE $(JETSON_DIR), not in $(JETSON_DIR)
# itself, because `weights/` sits beside it and the engine path is written
# relative to $(JETSON_DIR). Running `jetson/live_detect.py` from $(JETSON_DIR)
# makes `--engine weights/x.engine` resolve, and puts jetson/ on sys.path so the
# sibling imports (gps, uplink, beacon) resolve too.
JETSON_CODE_DIR ?= $(JETSON_DIR)/jetson
ENTRY ?= jetson/live_detect.py

# Inference size only affects the onnx/ultralytics detectors. With --detector trt
# the engine's baked shape decides, and this value is ignored. Kept so the same
# invocation works across backends.
#
# The default below is the engine's own shape (512x288 is width x height, and
# live_detect takes --imgsz as H W), so the onnx path matches the trt path rather
# than silently differing. 640 was a round-number guess that has never been the
# shape of the engine this aircraft ships.
IMGSZ ?= 288 512

# Engine is selectable so a rect (512x288) engine can be compared against the
# 640 baseline without editing this file:
#   make run ENGINE=weights/best_512x288.engine
#   make run ENGINE=weights/best_fp16io.engine
# For onnx instead of trt: make run ENGINE=weights/best_512x288.onnx DETECTOR=onnx
#
# best_512x288.engine is the default because it is the engine that has actually
# flown here: it is built for the camera's aspect ratio, and it is the one the
# recorded working command in this drone's shell history uses.
DETECTOR ?= trt
ENGINE ?= weights/best_512x288.engine

# Confidence floor for a detection to be reported. 0.25 is the value the flown
# configuration used. Raising it trades recall for fewer false positives, which
# on this task means a missed mine - so it is a deliberate choice, not a knob.
CONF ?= 0.25

# Decoupled capture/inference (jetson/pipeline.py). Capture runs at camera rate
# and boxes are redrawn at the detection rate, so this is what shows smooth
# ~30 FPS video. Without it, capture and detection are the same loop and the
# video frame rate IS the detection rate (~1.2 FPS at 640).
#
# DEFAULT 1. This was 0, which meant the threaded pipeline was written, tested
# and then never actually run: every bench run and every flight took the serial
# path and streamed at the detection rate, so the preview looked broken while the
# code to fix it sat unused next to it. A default that silently disables the
# optimisation is not a neutral default, it is an unused one. Off is still
# reachable with DECOUPLED=0 for A/B measurement.
#
# BOX_HOLD is how long a box survives after its last measured detection; the
# serial path holds 5 frames, which is only 0.16 s at 30 FPS - far too short for
# a ~5 Hz detector, hence seconds here.
DECOUPLED ?= 1
BOX_HOLD ?= 1.5

# Spatial de-duplication radius in metres. A fixed ground object is seen on
# dozens of consecutive frames, and each sighting is geotagged with a +/-3 m
# error, so the same stone lands as a scatter of near-identical rows a metre
# apart. TVision is landscape-scale, an unexploded ordnance is one object at one
# place, so within this radius a second sighting of the same class is the same
# object seen again and is dropped before it is logged or uploaded. 0 disables it
# and restores one-row-per-frame.
DEDUPE_M ?= 1.5

ifeq ($(DECOUPLED),1)
DECOUPLED_FLAGS := --decoupled --box-hold $(BOX_HOLD)
else
DECOUPLED_FLAGS :=
endif
DEDUPE_FLAGS := --dedupe-radius-m $(DEDUPE_M)

# Export toolchain lives in a Python 3.11 venv; the repo's default python3 is 3.14
# and ultralytics refuses it. numpy is pinned to 1.26.4 because torch 2.2.2 on
# Intel macOS is built against NumPy 1.x ("Numpy is not available" otherwise).
EXPORT_PY ?= /tmp/aero_export/bin/python
# The Mac has no CUDA, so exporting here must run on CPU. Override with
# EXPORT_DEVICE=0 on a CUDA box.
EXPORT_DEVICE ?= cpu

.PHONY: deploy bench run stream api logs doctor test-local export-rect deps-drone tunnel go status probe-cuda watchdog-log stop-drone

tunnel:
	@echo "opening reverse tunnel: drone:8000 -> laptop:127.0.0.1:8000"
	@echo "leave this running; ctrl-c to close. verify with: make doctor"
	@ssh -N -R 8000:127.0.0.1:8000 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes $(JETSON)

# Runtime state that belongs to the AIRCRAFT, not to this checkout. `logs/` is
# the append-only mission record and `spool/` is the offline queue of detections
# captured while the radio link was down. Both exist on the laptop (a bench run
# writes them), and both are gitignored, so nothing warns you before rsync
# overwrites the aircraft's flight log with a laptop's - or, worse, pushes a
# laptop's spool onto the drone to be replayed and uploaded as though it had been
# measured in the air. Excluded, along with any local .env.
deploy:
	ssh $(JETSON) 'mkdir -p $(JETSON_CODE_DIR)'
	rsync -az --exclude .git \
		--exclude 'logs/' \
		--exclude 'spool/' \
		--exclude '.env' \
		--exclude '__pycache__/' \
		./jetson/ $(JETSON):$(JETSON_CODE_DIR)/

bench:
	ssh $(JETSON) 'cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) $(ENTRY) --help'

# The backend the drone posts to, reachable from the LAN.
#
# This target exists because uvicorn's default bind is 127.0.0.1, which is
# reachable from this laptop and from nowhere else. Starting the API the ordinary
# way therefore produces a drone that logs detections locally, spools every one
# of them, and reports nothing - with the API looking perfectly healthy the whole
# time. Binding 0.0.0.0 is the entire difference between a working demo and a
# confusing one, so it is not left to memory.
#
# macOS will prompt to allow incoming connections the first time. Allow it.
#
# --reload is included because this is a dev target, but note it costs you the
# in-process broadcast bus: uvicorn's reloader restarts the worker on every file
# save, and each restart drops every open mission socket. The browser hook
# reconnects, so it self-heals, but do not "fix" a dropped socket by disabling
# the browser's reconnect loop - just stop editing files mid-demo.
api:
	cd backend && $(BACKEND_PY) -m uvicorn app.main:app --reload --app-dir . --host 0.0.0.0 --port 8000

# Pre-flight for the class demo. Run this BEFORE `make stream`, and stop if the
# drone cannot see the backend: nothing downstream can work, and the failure
# otherwise shows up 40 seconds later as an empty dashboard.
doctor:
	@echo "laptop LAN address : $$(ipconfig getifaddr en0 2>/dev/null || echo '(en0 has no address)')"
	@echo "drone posting to   : $(BACKEND_URL)"
	@echo "survey origin      : $(SURVEY_LAT), $(SURVEY_LON)"
	@echo "sim flight         : $(SIM_LEG_M) m legs, $(SIM_LANE_M) m lanes, $(SIM_LANES) lanes"
	@echo ""
	@echo "[1/2] is the API up locally?"
	@curl -fsS --max-time 3 http://127.0.0.1:8000/health >/dev/null \
		&& echo "      OK - /health answers" \
		|| echo "      FAIL - start it with: make api"
	@echo "[2/2] can the DRONE reach it? (this is the gate)"
	@ssh -o ConnectTimeout=8 $(JETSON) 'curl -fsS --max-time 5 $(BACKEND_URL)/health >/dev/null \
		&& echo "      OK - drone can reach $(BACKEND_URL)" \
		|| echo "      FAIL - is the tunnel up? run: make tunnel"' \
		|| echo "      FAIL - cannot SSH to '$(JETSON)' at all"

export-rect:
	$(EXPORT_PY) scripts/export_onnx.py --weights weights/best.pt --imgsz 512x288 --opset 12 --device $(EXPORT_DEVICE) --verify

run:
	ssh $(JETSON) 'set -a; . $(JETSON_DIR)/.env; set +a; cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) -u $(ENTRY) --detector $(DETECTOR) --engine $(ENGINE) --imgsz $(IMGSZ) --conf $(CONF) $(GPS_FLAGS) --source csi --names landmine --backend-url $(BACKEND_URL) --mission-name $(MISSION) --max-frames $(MAX_FRAMES) --headless $(DEDUPE_FLAGS) $(DECOUPLED_FLAGS)'

stream:
	ssh $(JETSON) 'set -a; . $(JETSON_DIR)/.env; set +a; cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) -u $(ENTRY) --detector $(DETECTOR) --engine $(ENGINE) --imgsz $(IMGSZ) --conf $(CONF) $(GPS_FLAGS) --source csi --names landmine --backend-url $(BACKEND_URL) --mission-name $(MISSION) --max-frames $(MAX_FRAMES) --headless --stream-port $(STREAM_PORT) $(DEDUPE_FLAGS) $(DECOUPLED_FLAGS)'

logs:
	ssh $(JETSON) 'tail -n 50 $(JETSON_DIR)/logs/detections.jsonl'

# Install pymavlink + pyserial for the interpreter that also has TensorRT.
#
# Run this once per drone, before the first `make stream GPS=mavlink`. It is
# idempotent and safe to re-run.
#
# Nothing here uses pip or sudo, and nothing is written outside ~/.local - the
# image's pip is broken (see scripts/build_py36_deps.sh for the mechanism) and
# changing system packages on the aircraft is not something to do casually. The
# payload is built on the laptop and copied in, so the drone needs no compiler,
# no network, and no privileges.
DEPS_TARBALL ?= /tmp/aeroshield_py36_deps.tar.gz

deps-drone:
	@echo "== [1/3] building Python 3.6 payload on the laptop =="
	scripts/build_py36_deps.sh $(DEPS_TARBALL)
	@echo "== [2/3] shipping it to the aircraft =="
	scp -q $(DEPS_TARBALL) $(JETSON):/tmp/aeroshield_py36_deps.tar.gz
	@echo "== [3/3] installing into the user site and verifying =="
	ssh $(JETSON) 'rm -rf /tmp/a36deps && mkdir -p /tmp/a36deps \
		&& tar xzf /tmp/aeroshield_py36_deps.tar.gz -C /tmp/a36deps \
		&& SITE=$$HOME/.local/lib/python3.6/site-packages \
		&& mkdir -p $$SITE \
		&& cp -r /tmp/a36deps/pkg/pymavlink /tmp/a36deps/pkg/serial $$SITE/ \
		&& find $$SITE/pymavlink $$SITE/serial -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null; \
		echo ""; \
		PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) -c "import sys; \
print(\"  interpreter :\", sys.version.split()[0]); \
import pymavlink; from pymavlink import mavutil; print(\"  pymavlink   :\", pymavlink.__version__ if hasattr(pymavlink,\"__version__\") else \"ok\"); \
import serial; print(\"  pyserial    :\", serial.VERSION); \
from pymavlink.dialects.v20 import ardupilotmega as ap; print(\"  dialect     : ardupilotmega\"); \
print(\"  GLOBAL_POSITION_INT:\", ap.MAVLink_global_position_int_message.__name__); \
print(\"  GPS_RAW_INT        :\", ap.MAVLink_gps_raw_int_message.__name__); \
import tensorrt; print(\"  tensorrt    :\", tensorrt.__version__); \
import cv2; print(\"  cv2         :\", cv2.__version__, \"| GStreamer:\", \"YES\" if \"GStreamer:                   YES\" in cv2.getBuildInformation() else \"NO\")"'

test-local:
	.venv312/bin/python -m pytest -q

# ---------------------------------------------------------------------------
# The two commands to use from now on.
#
# `make status` answers "what is broken?" and changes NOTHING on the aircraft -
# it is safe to run when someone else is flying it. Seven bounded steps, one
# line each, and it stops at the first hard blocker instead of timing out six
# more times behind it. Full logs land in logs/go/<stamp>/.
#
# `make go` does the same checks, then starts whatever is down, deploys the
# code, probes inference (this is what catches "inferred 0"), and launches the
# detector under the watchdog.
#
# Deliberately NOT a shell loop over ssh: every remote step has its own timeout,
# and when SSH itself fails the script exits at step 3 with the four known
# causes rather than sweeping the subnet.
#
#   make go --serial        run with DECOUPLED=0 (the CUDA-context workaround)
#   make status --no-deploy skip the rsync
# ---------------------------------------------------------------------------
# The variables are passed with `env` rather than as `A=b cmd` prefixes because
# IMGSZ is two numbers ("288 512") and a quoted assignment prefix is not a valid
# command word in POSIX sh - `"IMGSZ=288 512" cmd` is read as the name of a
# program, which fails with "command not found" before the script ever runs.
status:
	@env JETSON=$(JETSON) JETSON_DIR=$(JETSON_DIR) JETSON_PY=$(JETSON_PY) \
	 JETSON_CV_PATH="$(JETSON_CV_PATH)" BACKEND_URL=$(BACKEND_URL) \
	 ENGINE=$(ENGINE) MISSION=$(MISSION) CONF=$(CONF) IMGSZ="$(IMGSZ)" \
	 STREAM_PORT=$(STREAM_PORT) DEDUPE_M=$(DEDUPE_M) BOX_HOLD=$(BOX_HOLD) \
	 SURVEY_LAT=$(SURVEY_LAT) SURVEY_LON=$(SURVEY_LON) SIM_LEG_M=$(SIM_LEG_M) \
	 SIM_LANE_M=$(SIM_LANE_M) SIM_LANES=$(SIM_LANES) \
	 scripts/drone_go.sh status $(GO_ARGS)

go:
	@env JETSON=$(JETSON) JETSON_DIR=$(JETSON_DIR) JETSON_PY=$(JETSON_PY) \
	 JETSON_CV_PATH="$(JETSON_CV_PATH)" BACKEND_URL=$(BACKEND_URL) \
	 ENGINE=$(ENGINE) MISSION=$(MISSION) CONF=$(CONF) IMGSZ="$(IMGSZ)" \
	 STREAM_PORT=$(STREAM_PORT) DEDUPE_M=$(DEDUPE_M) BOX_HOLD=$(BOX_HOLD) \
	 SURVEY_LAT=$(SURVEY_LAT) SURVEY_LON=$(SURVEY_LON) SIM_LEG_M=$(SIM_LEG_M) \
	 SIM_LANE_M=$(SIM_LANE_M) SIM_LANES=$(SIM_LANES) \
	 scripts/drone_go.sh go $(GO_ARGS)

# Fact-check the CUDA-context hypothesis on the aircraft.
#
# Reads pycuda's version, whether Context.get_current exists, and whether a
# context obtained by each available strategy can actually be pushed AND used
# for a memcpy on a DIFFERENT thread. The last part is the whole question: a
# context that pushes but cannot allocate is the hang we have been chasing.
# Exit 0 means at least one strategy works from another thread.
probe-cuda:
	@echo "probing CUDA context acquisition on $(JETSON)"
	@scp -q scripts/probe_cuda_ctx.py $(JETSON):/tmp/probe_cuda_ctx.py
	@ssh -o ConnectTimeout=8 $(JETSON) \
		'cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) /tmp/probe_cuda_ctx.py' \
		|| echo "" && echo "exit $$? - nonzero means no strategy works from another thread; use DECOUPLED=0"

# Tail the watchdog's restart history. One line per detector restart, with the
# system uptime, so "the process died" and "the board rebooted" are
# distinguishable.
watchdog-log:
	@ssh $(JETSON) 'tail -n 40 $(JETSON_DIR)/logs/watchdog.log'

# Stop the watchdog cleanly (it relaunches the detector otherwise).
stop-drone:
	@ssh $(JETSON) 'touch $(JETSON_DIR)/logs/watchdog.stop; sleep 2; \
		pgrep -f live_detect.py >/dev/null && echo "still running - stop file not honoured" \
		|| echo "detector stopped"'
