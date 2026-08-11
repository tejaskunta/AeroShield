#!/usr/bin/env bash
# SafeMine - build a TensorRT engine from best.onnx, ON the Jetson Nano.
#
# Run this on the NANO, never on the training PC. A TensorRT engine is compiled
# against one specific GPU architecture and TensorRT version; an engine built on
# an RTX 4070 will refuse to load on the Nano's Maxwell GPU.
#
#   scp weights/best.onnx  <user>@<nano-ip>:~/safemine/
#   ssh <user>@<nano-ip>
#   cd ~/safemine && bash build_engine.sh best.onnx
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
  echo "       scp weights/best.onnx <user>@<nano-ip>:~/safemine/" >&2
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
# --workspace: scratch memory in MB. The Nano has 4 GB shared with the OS, so
#             2048 is about the ceiling. Drop to 1024 if the build OOMs.
"$TRTEXEC" \
  --onnx="$ONNX" \
  --saveEngine="$ENGINE" \
  --fp16 \
  --workspace="$WORKSPACE_MB" \
  --verbose 2>&1 | tee build_engine.log

echo
if [[ -f "$ENGINE" ]]; then
  echo "=============================================================="
  echo "SUCCESS: $ENGINE  ($(du -h "$ENGINE" | cut -f1))"
  echo "=============================================================="
  echo
  echo "Benchmark it:"
  echo "  $TRTEXEC --loadEngine=$ENGINE --fp16"
  echo
  echo "Run live inference:"
  echo "  python3 infer_trt.py --engine $ENGINE --source 0"
else
  echo "BUILD FAILED - see build_engine.log" >&2
  echo
  echo "Most common causes:" >&2
  echo "  * Unsupported op   -> re-export from the PC with --opset 11" >&2
  echo "  * Out of memory    -> WORKSPACE_MB=1024 bash build_engine.sh $ONNX" >&2
  echo "  * Dynamic shapes   -> re-export with dynamic=False (the default)" >&2
  exit 1
fi
