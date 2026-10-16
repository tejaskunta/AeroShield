JETSON ?= jetson
JETSON_DIR ?= ~/aeroshield
JETSON_PY ?= /usr/bin/python3.6
JETSON_CV_PATH ?= /usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages
MISSION ?= bench-jetson-1
MAX_FRAMES ?= 0
STREAM_PORT ?= 8080

# Inference size only affects the onnx/ultralytics detectors. With --detector trt
# the engine's baked shape decides, and this value is ignored. Kept so the same
# invocation works across backends.
IMGSZ ?= 640

# Engine is selectable so a rect (512x288) engine can be compared against the
# 640 baseline without editing this file:
#   make run ENGINE=weights/best_512x288.engine
#   make run ENGINE=weights/best_fp16io.engine
# For onnx instead of trt: make run ENGINE=weights/best_512x288.onnx DETECTOR=onnx
DETECTOR ?= trt
ENGINE ?= weights/best.engine

# Decoupled capture/inference (jetson/pipeline.py). Capture runs at camera rate
# and boxes are redrawn at the detection rate, so `make stream DECOUPLED=1` is
# what shows smooth ~30 FPS video. Without it, capture and detection are the
# same loop and the video frame rate IS the detection rate (~1.2 FPS at 640).
# BOX_HOLD is how long a box survives after its last measured detection; the
# serial path holds 5 frames, which is only 0.16 s at 30 FPS - far too short for
# a ~5 Hz detector, hence seconds here.
DECOUPLED ?= 0
BOX_HOLD ?= 1.5
ifeq ($(DECOUPLED),1)
DECOUPLED_FLAGS := --decoupled --box-hold $(BOX_HOLD)
else
DECOUPLED_FLAGS :=
endif

# Export toolchain lives in a Python 3.11 venv; the repo's default python3 is 3.14
# and ultralytics refuses it. numpy is pinned to 1.26.4 because torch 2.2.2 on
# Intel macOS is built against NumPy 1.x ("Numpy is not available" otherwise).
EXPORT_PY ?= /tmp/aero_export/bin/python
# The Mac has no CUDA, so exporting here must run on CPU. Override with
# EXPORT_DEVICE=0 on a CUDA box.
EXPORT_DEVICE ?= cpu

.PHONY: deploy bench run stream logs test-local export-rect

deploy:
	rsync -az --exclude .git ./jetson/ $(JETSON):$(JETSON_DIR)/

bench:
	ssh $(JETSON) 'cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) detector.py --help'

export-rect:
	$(EXPORT_PY) scripts/export_onnx.py --weights weights/best.pt --imgsz 512x288 --opset 12 --device $(EXPORT_DEVICE) --verify

run:
	ssh $(JETSON) 'set -a; . $(JETSON_DIR)/.env; set +a; cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) live_detect.py --detector $(DETECTOR) --engine $(ENGINE) --imgsz $(IMGSZ) --gps sim --source csi --names landmine --backend-url http://10.11.100.191:8000 --mission-name $(MISSION) --max-frames $(MAX_FRAMES) --headless $(DECOUPLED_FLAGS)'

stream:
	ssh $(JETSON) 'set -a; . $(JETSON_DIR)/.env; set +a; cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) live_detect.py --detector $(DETECTOR) --engine $(ENGINE) --imgsz $(IMGSZ) --gps sim --source csi --names landmine --backend-url http://10.11.100.191:8000 --mission-name $(MISSION) --max-frames $(MAX_FRAMES) --headless --stream-port $(STREAM_PORT) $(DECOUPLED_FLAGS)'

logs:
	ssh $(JETSON) 'tail -n 50 $(JETSON_DIR)/logs/detections.jsonl'

test-local:
	.venv312/bin/python -m pytest -q
