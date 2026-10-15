JETSON ?= jetson
JETSON_DIR ?= ~/aeroshield
JETSON_PY ?= /usr/bin/python3.6
JETSON_CV_PATH ?= /usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages
MISSION ?= bench-jetson-1
MAX_FRAMES ?= 0

.PHONY: deploy bench run logs test-local

deploy:
	rsync -az --exclude .git ./jetson/ $(JETSON):$(JETSON_DIR)/

bench:
	ssh $(JETSON) 'cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) detector.py --help'

run:
	ssh $(JETSON) 'set -a; . $(JETSON_DIR)/.env; set +a; cd $(JETSON_DIR) && PYTHONPATH=$(JETSON_CV_PATH) $(JETSON_PY) live_detect.py --detector trt --engine weights/best.engine --gps sim --source csi --names landmine --backend-url http://10.11.100.191:8000 --mission-name $(MISSION) --max-frames $(MAX_FRAMES) --headless'

logs:
	ssh $(JETSON) 'tail -n 50 $(JETSON_DIR)/logs/detections.jsonl'

test-local:
	.venv312/bin/python -m pytest -q
