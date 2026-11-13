#!/bin/sh
# AeroShield - detector watchdog. THIS RUNS ON THE AIRCRAFT, not on the laptop.
#
# WHY
# The Nano has dropped off the network three times, twice while TensorRT was
# inferring, and one `uptime` read "up 2 min" right after a session that had
# been running for 9. Sometimes that is a brownout and the whole board resets -
# nothing here can help with that. But often the *process* dies while the board
# stays up: the CSI pipeline drops, an out-of-memory kill, a TensorRT error on a
# frame. In that case every second between the crash and a human noticing is a
# second the aircraft is flying without a detector, and the only evidence is a
# traceback nobody is reading.
#
# So: relaunch on exit, and write exactly one line per restart to
# logs/watchdog.log. A crash becomes a log entry with a timestamp, an exit code
# and the system uptime - which is enough to tell "the detector crashed" (exit
# code, uptime climbing) from "the board rebooted" (uptime reset to a small
# number). That distinction is the whole reason this file exists.
#
# USAGE (normally launched by `make go`, which builds the argument list)
#   bin/drone_watchdog.sh --detector trt --engine weights/best_512x288.engine ...
#
# STOPPING IT
#   touch ~/aeroshield/logs/watchdog.stop     # then it exits within ~5 s
#   (delete the file before starting it again - the watchdog does that itself
#    on startup, so a stale stop file cannot silently prevent a restart)
#
# It does NOT use pip, sudo, or the network, and it changes no system setting.
# PYTHONPATH is set here because this shell is not the Makefile: without the cv2
# dist-packages path, "import cv2" fails and the watchdog would restart the
# detector in a tight loop, which looks exactly like a broken detector.

set -u

APP_DIR=${APP_DIR:-$HOME/aeroshield}
OUT=${OUT:-$APP_DIR/logs/detector.out}
LOG=${LOG:-$APP_DIR/logs/watchdog.log}
STOP=${STOP:-$APP_DIR/logs/watchdog.stop}
PY=${PY:-/usr/bin/python3.6}
RESTART_DELAY=${RESTART_DELAY:-5}
# Rotate the detector output before it fills the SD card. 20 MB is ~40x more
# than any single run needs, so nothing diagnostic is lost.
MAX_OUT_BYTES=${MAX_OUT_BYTES:-20000000}

PYTHONPATH=${PYTHONPATH:-/usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages}
export PYTHONPATH

mkdir -p "$APP_DIR/logs" || exit 1
cd "$APP_DIR" || exit 1

# Detections post with an API key; it lives in the data dir, not in the code.
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi

rm -f "$STOP"

if [ ! -f "$PY" ]; then
    echo "FATAL: interpreter $PY does not exist" >> "$LOG"
    exit 1
fi
if [ ! -f jetson/live_detect.py ]; then
    echo "FATAL: jetson/live_detect.py missing under $APP_DIR - run 'make deploy'" >> "$LOG"
    exit 1
fi

echo "--- watchdog pid=$$ start $(date '+%Y-%m-%d %H:%M:%S') uptime=$(cut -d. -f1 /proc/uptime)s" >> "$LOG"
echo "    py=$PY app_dir=$APP_DIR" >> "$LOG"
echo "    args: $*" >> "$LOG"

restart=0
while :; do
    if [ -f "$STOP" ]; then
        echo "--- watchdog stop file found, exiting" >> "$LOG"
        break
    fi

    # Keep the log bounded. -f guards against a missing file on the first pass.
    if [ -f "$OUT" ]; then
        size=$(wc -c < "$OUT" 2>/dev/null || echo 0)
        if [ "$size" -gt "$MAX_OUT_BYTES" ]; then
            mv -f "$OUT" "$OUT.1"
            echo "--- rotated $OUT (${size} bytes)" >> "$LOG"
        fi
    fi

    restart=$((restart + 1))
    uptime_s=$(cut -d. -f1 /proc/uptime)
    t0=$(date +%s)

    "$PY" -u jetson/live_detect.py "$@" >> "$OUT" 2>&1
    rc=$?

    t1=$(date +%s)
    ran=$((t1 - t0))

    if [ "$rc" -eq 0 ]; then
        why="clean exit"
    else
        why="crash"
    fi

    # One line per restart. uptime= is the SYSTEM's uptime, not the run's, so a
    # small value here means the board rebooted rather than the process dying.
    echo "$(date '+%Y-%m-%d %H:%M:%S') restart=$restart exit=$rc ran=${ran}s uptime=${uptime_s}s ($why) last: $(tail -n 1 "$OUT" 2>/dev/null | cut -c1-160)" >> "$LOG"

    if [ -f "$STOP" ]; then
        echo "--- watchdog stop file found after run, exiting" >> "$LOG"
        break
    fi

    sleep "$RESTART_DELAY"
done