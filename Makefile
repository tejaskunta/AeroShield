JETSON ?= jetson
JETSON_DIR ?= ~/aeroshield

.PHONY: deploy bench run logs test-local

deploy:
	rsync -az --exclude .git ./jetson/ $(JETSON):$(JETSON_DIR)/

bench:
	ssh $(JETSON) 'cd $(JETSON_DIR) && python3 detector.py --help'

run:
	ssh $(JETSON) 'cd $(JETSON_DIR) && python3 live_detect.py --headless'

logs:
	ssh $(JETSON) 'tail -n 50 $(JETSON_DIR)/logs/detections.jsonl'

test-local:
	.venv312/bin/python -m pytest -q
