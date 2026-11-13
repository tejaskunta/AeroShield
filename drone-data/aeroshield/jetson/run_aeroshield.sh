#!/bin/bash
set -e

cd "$HOME/aeroshield"

if [ -f "$HOME/aeroshield/.env" ]; then
  set -a
  . "$HOME/aeroshield/.env"
  set +a
fi

# Set these in your shell or replace the placeholders.
: "${AEROSHIELD_API_KEY:?Export AEROSHIELD_API_KEY before running}"
: "${AEROSHIELD_BACKEND_URL:?Export AEROSHIELD_BACKEND_URL, e.g. http://192.168.1.10:8000}"

export PYTHONPATH="/usr/lib/python3.6/dist-packages:${PYTHONPATH:-}"

python3.6 jetson/live_detect.py \
  --source csi \
  --detector trt \
  --engine weights/best_512x288.engine \
  --gps mavlink \
  --gps-url /dev/ttyACM0:115200 \
  --gps-max-age 2.0 \
  --imgsz 288 512 \
  --conf 0.25 \
  --backend-url "$AEROSHIELD_BACKEND_URL" \
  --api-key "$AEROSHIELD_API_KEY" \
  --mission-name "aeroshield-field-test-001" \
  --replay-spool
