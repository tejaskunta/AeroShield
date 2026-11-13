#!/usr/bin/env bash
# SafeMine - build a TensorRT engine from best.onnx, ON the Jetson Nano.
#
# Run this on the NANO, never on the training PC. A TensorRT engine is compiled
# against one specific GPU architecture and TensorRT version; an engine built on
# an RTX 4070 will refuse to load on the Nano's Maxwell GPU.
#
#   scp weights/best.onnx  <user>@<nano-ip>:~/aeroshield/
#   ssh <user>@<nano-ip>
#   cd ~/aeroshield && bash build_engine.sh best.onnx
#
# Rectangular engines: export at 512x288 first, then build from that ONNX.
#   bash build_engine.sh weights/best_512x288.onnx weights/best_512x288.engine
# FP16_IO=1 adds --inputIOFormats/--outputIOFormats fp16:chw. Build both ways
# and keep the faster engine:
#   FP16_IO=1 bash build_engine.sh weights/best_512x288.onnx weights/best_512x288_fp16io.engine
#
# Expect this to take 5-20 minutes. That is normal - TensorRT is benchmarking
# every kernel it might use. It is not hung.

set -euo pipefail

ONNX="${1:-best.onnx}"
ENGINE="${2:-${ONNX%.onnx}.engine}"
WORKSPACE_MB="${WORKSPACE_MB:-2048}"
TRTEXEC="/usr/src/tensorrt/bin/trtexec"

echo "=============================================================="
echo "SafeMine - TensorRT engine build"
echo "=============================================================="

if [[ ! -f "$ONNX" ]]; then
  echo "ERROR: $ONNX not found in $(pwd)" >&2
  echo "       Copy it from the training PC first:" >&2
  echo "       scp weights/best.onnx <user>@<nano-ip>:~/aeroshield/" >&2
  exit 1
fi

if [[ ! -x "$TRTEXEC" ]]; then
  echo "ERROR: trtexec not found at $TRTEXEC" >&2
  echo "       Install it with: sudo apt-get install tensorrt" >&2
  echo "       (it ships with JetPack; if missing, reflash JetPack 4.6.x)" >&2
  exit 1
fi

echo "ONNX      : $ONNX"
echo "Engine    : $ENGINE"
echo "Workspace : ${WORKSPACE_MB} MB"
echo

# Lock the Nano to max clocks first - the build and the benchmark numbers are
# both meaningless at the default power profile.
if command -v nvpmodel >/dev/null 2>&1; then
  echo ">> Setting max power mode (10W) and pinning clocks..."
  sudo nvpmodel -m 0 || true
  sudo jetson_clocks || true
  echo
fi

echo ">> Building engine (5-20 min, this is NOT hung)..."
echo

# --fp16    : Maxwell has no INT8 tensor cores worth using, but FP16 roughly
#             doubles throughput at negligible accuracy cost. Always use it here.
#             INT8 is deliberately not offered: no FPS gain on Nano, worse mAP.
# --workspace: scratch memory in MB. The Nano has 4 GB shared with the OS, so
#             2048 is about the ceiling. Drop to 1024 if the build OOMs.
# FP16_IO=1 : also try --inputIOFormats/--outputIOFormats fp16. Sometimes helps
#             by skipping FP32 casts; sometimes hurts on Maxwell. Rebuild both
#             ways and keep the faster engine (compare trtexec ms).
EXTRA_FLAGS=""
if [[ "${FP16_IO:-0}" == "1" ]]; then
  EXTRA_FLAGS="--inputIOFormats=fp16:chw --outputIOFormats=fp16:chw"
fi
"$TRTEXEC" \
  --onnx="$ONNX" \
  --saveEngine="$ENGINE" \
  --fp16 \
  $EXTRA_FLAGS \
  --workspace="$WORKSPACE_MB" \
  --verbose 2>&1 | tee build_engine.log

echo
if [[ -f "$ENGINE" ]]; then
  echo "=============================================================="
  echo "SUCCESS: $ENGINE  ($(du -h "$ENGINE" | cut -f1))"
  echo "=============================================================="
  echo
  echo "Benchmark it:"
  echo "  $TRTEXEC --loadEngine=$ENGINE --fp16 --iterations=100 --avgRuns=10"
  echo
  echo "Run live inference (from the repo root on the PC):"
  echo "  make run ENGINE=weights/$(basename "$ENGINE")"
  echo
  echo "Or directly on the Nano (needs the OpenCV PYTHONPATH):"
  echo "  PYTHONPATH=/usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages \\"
  echo "    /usr/bin/python3.6 live_detect.py --detector trt --engine weights/$(basename "$ENGINE") \\"
  echo "    --gps sim --source csi --names landmine --headless"
else
  echo "BUILD FAILED - see build_engine.log" >&2
  echo
  echo "Most common causes:" >&2
  echo "  * Unsupported op   -> re-export from the PC with --opset 11" >&2
  echo "  * Out of memory    -> WORKSPACE_MB=1024 bash build_engine.sh $ONNX" >&2
  echo "  * Dynamic shapes   -> re-export with dynamic=False (the default)" >&2
  exit 1
fi
