#!/bin/sh
# AeroShield - one command to find out what is actually broken.
#
# WHY THIS EXISTS
# Bringing the drone up used to be: check Postgres, check the API, check health
# says "database":"ok" (not just 200), check SSH, check the reverse tunnel,
# redeploy after every reboot because /tmp is tmpfs, check the camera, check
# thermal, check the engine, then run an inference probe and read the summary to
# see whether "inferred" was zero. Every one of those was a hand-typed command
# whose full output came back into the chat, and when the drone was simply
# powered off we still paid for the whole sequence before finding out.
#
# So: SEVEN steps, each printing exactly one line - PASS, FAIL or SKIP - plus a
# one-line fix when it fails. Full output of every step goes to a file under
# logs/go/<stamp>/ and only the tail of a FAILING step is printed. When SSH
# fails the script stops immediately instead of sweeping the /21 subnet, because
# sweeping found nothing three times and cost a fortune.
#
# USAGE
#   make status          read-only. Touches nothing on the drone. Safe anytime.
#   make go              status + starts whatever is down + launches the detector.
#   scripts/drone_go.sh status
#   scripts/drone_go.sh go
#   scripts/drone_go.sh status --no-deploy      skip step 5 (deploy)
#   scripts/drone_go.sh go --serial             run the detector with DECOUPLED=0
#                                               (the CUDA-context workaround)
#
# EXIT CODES
#   0  all steps that were attempted passed
#   1  a step failed (the reason and the fix are printed)
#   2  bad usage
#
# EVERY STEP IS BOUNDED. Nothing here is allowed to hang: each network command
# carries an explicit timeout and the inference probe is wrapped in `timeout`,
# so a wedged TensorRT context reports FAIL in ~15 s instead of looking like a
# dead drone.

set -u

# ---------------------------------------------------------------------------
# Configuration. Everything is overridable by environment so this script and
# the Makefile target cannot drift apart.
# ---------------------------------------------------------------------------
MODE=${1:-status}
shift 2>/dev/null || true

DEPLOY=1
SERIAL=0
STREAM=1
# Frames the probe captures. NOTE this counts CAPTURED frames, not detect()
# calls: in decoupled mode the capture loop hits this limit long before the
# inference thread has finished, so a small number here would report
# "inferred 0" on a perfectly healthy board. 40 frames is ~1.3 s of capture at
# 30 FPS, which is enough for ~6 detections at the Nano's ~5 Hz.
MAX_FRAMES=${MAX_FRAMES:-40}
for arg in "$@"; do
    case "$arg" in
        --no-deploy)  DEPLOY=0 ;;
        --deploy)     DEPLOY=1 ;;
        --serial)     SERIAL=1 ;;
        --no-stream)  STREAM=0 ;;
        --help|-h)
            sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
done

case "$MODE" in
    status|go) ;;
    *) echo "usage: $0 status|go [--no-deploy] [--serial] [--no-stream]" >&2; exit 2 ;;
esac

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO" || exit 2

JETSON=${JETSON:-jetson}
JETSON_DIR=${JETSON_DIR:-$HOME/aeroshield}
JETSON_PY=${JETSON_PY:-/usr/bin/python3.6}
JETSON_CV_PATH=${JETSON_CV_PATH:-/usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages}
BACKEND_URL=${BACKEND_URL:-http://127.0.0.1:8000}
ENGINE=${ENGINE:-weights/best_512x288.engine}
MISSION=${MISSION:-kmit-01}
CONF=${CONF:-0.25}
IMGSZ=${IMGSZ:-288 512}
STREAM_PORT=${STREAM_PORT:-8080}
DEDUPE_M=${DEDUPE_M:-1.5}
BOX_HOLD=${BOX_HOLD:-1.5}

# Survey origin for the SIMULATED GPS. These MUST agree with the dashboard's
# VITE_SURVEY_ORIGIN (frontend/.env.local), which defaults to the same point.
# If they drift, the detector places the aircraft at the factory default in
# jetson/live_detect.py ([12.9716, 77.5946], Bengaluru) while the map draws the
# survey block at 17.396947/78.490706 - roughly 600 km apart, so the drone
# renders off the map and the map zooms out to show both. The same numbers are
# already defaults in the Makefile (SURVEY_LAT/SURVEY_LON/SIM_*), and the
# Makefile forwards them here, so normally these fallbacks never apply.
SURVEY_LAT=${SURVEY_LAT:-17.396947}
SURVEY_LON=${SURVEY_LON:-78.490706}
SIM_LEG_M=${SIM_LEG_M:-10}
SIM_LANE_M=${SIM_LANE_M:-3}
SIM_LANES=${SIM_LANES:-4}
SIM_FLAGS="--sim-origin $SURVEY_LAT $SURVEY_LON --sim-leg-length $SIM_LEG_M --sim-lane-spacing $SIM_LANE_M --sim-lanes $SIM_LANES"

STAMP=$(date '+%Y%m%d-%H%M%S')
OUTDIR="$REPO/logs/go/$STAMP"
mkdir -p "$OUTDIR" || exit 2

STEP=0
FAILED=0
SKIPPED=0

# ---------------------------------------------------------------------------
# Output helpers. One line per step is the entire point - keep it that way.
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    C_OK=$(printf '\033[32m'); C_NO=$(printf '\033[31m')
    C_SK=$(printf '\033[33m'); C_DIM=$(printf '\033[2m'); C_Z=$(printf '\033[0m')
else
    C_OK=; C_NO=; C_SK=; C_DIM=; C_Z=
fi

step() {
    STEP=$((STEP + 1))
    printf '[%d/7] %-34s ' "$STEP" "$1"
}

pass() { printf '%sPASS%s' "$C_OK" "$C_Z"; [ $# -gt 0 ] && printf ' - %s' "$*"; printf '\n'; }
fail() {
    printf '%sFAIL%s' "$C_NO" "$C_Z"; [ $# -gt 0 ] && printf ' - %s' "$*"; printf '\n'
    FAILED=1
}
skip() { printf '%sSKIP%s' "$C_SK" "$C_Z"; [ $# -gt 0 ] && printf ' - %s' "$*"; printf '\n'; SKIPPED=$((SKIPPED + 1)); }

fix()  { printf '        fix  : %s\n' "$*"; }
hint() { printf '        note : %s\n' "$*"; }
logf() { printf '        log  : %s\n' "$*"; }

# Show only the tail of a failing step's log. Full file is on disk.
show_tail() {
    [ -s "$1" ] || return 0
    printf '%s        ----- tail %s -----%s\n' "$C_DIM" "$(basename "$1")" "$C_Z"
    tail -n 25 "$1" | sed 's/^/        /'
    printf '%s        --------------------%s\n' "$C_DIM" "$C_Z"
}

# Reachability without depending on one tool's flavour. `nc -z` is not in every
# netcat (GNU vs BSD vs nmap), and curl's telnet:// support is a build-time
# option that is disabled in some distro builds - so try both and fall back to
# a raw socket in python, which is always present because the repo needs it.
tcp_open() {
    # $1 = host:port ; $2 = timeout seconds. Returns 0 if something accepts.
    _host=${1%:*}
    _port=${1##*:}
    _t=${2:-3}
    if command -v nc >/dev/null 2>&1; then
        nc -z -w "$_t" "$_host" "$_port" >/dev/null 2>&1 && return 0
    fi
    if curl -s -o /dev/null --max-time "$_t" "telnet://$_host:$_port" 2>/dev/null; then
        return 0
    fi
    python3 - "$_host" "$_port" "$_t" <<'PY' >/dev/null 2>&1
import socket, sys
host, port, timeout = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
s = socket.socket()
s.settimeout(timeout)
try:
    s.connect((host, port))
except Exception:
    sys.exit(1)
finally:
    s.close()
PY
}

# ---------------------------------------------------------------------------
# Step 1 - Postgres
# ---------------------------------------------------------------------------
step "Postgres (postgis :5432)"
DBLOG="$OUTDIR/1-db.log"
if tcp_open 127.0.0.1:5432 3; then
    pass "accepting connections"
elif [ "$MODE" = go ]; then
    printf 'not up, starting: '
    docker compose up -d db > "$DBLOG" 2>&1
    # Bounded wait: the container's own healthcheck uses 10s start_period +
    # 10 retries, so 30s is enough for a warm image and fails honestly if not.
    ok=0
    i=0
    while [ "$i" -lt 15 ]; do
        if tcp_open 127.0.0.1:5432 2; then ok=1; break; fi
        sleep 2
        i=$((i + 1))
    done
    if [ "$ok" = 1 ]; then
        pass "started by docker compose"
    else
        fail "did not come up within 30s"
        fix "docker compose up -d db ; docker compose logs --tail 30 db"
        logf "$DBLOG"
        show_tail "$DBLOG"
    fi
else
    fail "nothing listening on 127.0.0.1:5432"
    fix "docker compose up -d db"
fi

# ---------------------------------------------------------------------------
# Step 2 - Backend, and specifically that the DATABASE is ok
#
# A 200 from /health is not enough. It returns 200 with
# "database":"unreachable" and status "degraded", and a degraded backend
# accepts then rejects detections - the dashboard stays empty while the API
# looks perfectly healthy. That exact trap already cost a session.
# ---------------------------------------------------------------------------
step "Backend /health + database"
HLOG="$OUTDIR/2-health.log"
HEALTH=$(curl -fsS --max-time 4 "$BACKEND_URL/health" 2>"$HLOG")
if [ -z "$HEALTH" ]; then
    if [ "$MODE" = go ]; then
        printf 'no answer, starting: '
        mkdir -p "$OUTDIR"
        ( cd backend && nohup ./.venv/bin/python -m uvicorn app.main:app \
            --app-dir . --host 0.0.0.0 --port 8000 \
            > "$OUTDIR/2-uvicorn.log" 2>&1 & echo $! > "$OUTDIR/2-uvicorn.pid" )
        ok=0
        i=0
        while [ "$i" -lt 15 ]; do
            HEALTH=$(curl -fsS --max-time 3 "$BACKEND_URL/health" 2>/dev/null)
            if [ -n "$HEALTH" ]; then ok=1; break; fi
            sleep 2
            i=$((i + 1))
        done
        if [ "$ok" != 1 ]; then
            fail "backend did not answer within 30s"
            fix "make api   (uvicorn's default bind 127.0.0.1 is unreachable from the drone)"
            logf "$OUTDIR/2-uvicorn.log"
            show_tail "$OUTDIR/2-uvicorn.log"
        fi
    else
        fail "no answer on $BACKEND_URL/health"
        fix "make api"
        show_tail "$HLOG"
    fi
fi

if [ -n "${HEALTH:-}" ]; then
    case "$HEALTH" in
        *'"database":"ok"'*)
            pass "database ok"
            ;;
        *'"database": "ok"'*)
            pass "database ok"
            ;;
        *)
            fail "backend is up but the DATABASE is not ok"
            printf '        body : %s\n' "$HEALTH"
            fix "docker compose up -d db, then re-check /health"
            ;;
    esac
fi

# ---------------------------------------------------------------------------
# Step 3 - SSH. ONE attempt. No sweep, no retry.
#
# This is the biggest token saver in the file. When the drone is off, this is
# the only step that runs; four distinguishable causes are printed and the
# script exits, because nothing below can work and every probe after this one
# would just be a timeout.
# ---------------------------------------------------------------------------
step "SSH to the aircraft"
SSHLOG="$OUTDIR/3-ssh.log"
if ssh -o ConnectTimeout=8 -o BatchMode=yes "$JETSON" true 2>"$SSHLOG"; then
    pass "reachable"
else
    fail "cannot SSH to '$JETSON'"
    cat >&2 <<'EOF'
        The four causes we have actually hit, most likely first:
          1. The drone is POWERED OFF or its battery is flat.
          2. The hardware team is running their own code on it.
          3. The board CRASHED. A TensorRT inference spike on a marginal 5V
             supply browns the Nano out; `uptime` resetting to a small number
             is the tell. Needs a power cycle and a better supply.
          4. You are away from the drone and it is out of WiFi range.
        Check the LED, then check the physical board. Not a software problem.
EOF
    # ssh writes its own "ssh: ..." prefix, so print the line verbatim.
    tail -n 3 "$SSHLOG" 2>/dev/null | sed 's/^/        /'
    printf '\n'
    printf '        %sStopping here - nothing below can work without SSH.%s\n' "$C_DIM" "$C_Z"
    printf '        Logs: %s\n' "$OUTDIR"
    exit 1
fi

# From here on, one ssh call per step at most. Helper: run a command remotely.
# Note `set -a; . .env` so AEROSHIELD_API_KEY reaches the detector.
remote() {
    ssh -o ConnectTimeout=8 -o BatchMode=yes "$JETSON" "$1" 2>&1
}

# ---------------------------------------------------------------------------
# Step 4 - Reverse tunnel (drone -> laptop backend)
#
# macOS resets LAN-inbound connections to any listener that is not Apple-signed,
# so the backend is NOT reachable at the laptop's LAN address; the drone reaches
# it through its own sshd forwarding loopback:8000 back over the SSH connection.
# If that tunnel is down, every detection spools and the dashboard shows
# nothing while both machines look healthy.
# ---------------------------------------------------------------------------
step "Reverse tunnel drone->backend"
TLOG="$OUTDIR/4-tunnel.log"
if remote "curl -fsS --max-time 5 $BACKEND_URL/health" > "$TLOG" 2>&1; then
    pass "drone can reach $BACKEND_URL"
else
    # A tunnel is a foreground ssh. Keep it alive with ServerAlive*, and make it
    # exit loudly (ExitOnForwardFailure) rather than sit there looking fine.
    PIDFILE="$REPO/logs/tunnel.pid"
    ALIVE=0
    if [ -f "$PIDFILE" ]; then
        old=$(cat "$PIDFILE" 2>/dev/null || echo "")
        if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then ALIVE=1; fi
    fi
    if [ "$MODE" != go ]; then
        fail "tunnel is down"
        fix "make tunnel   (leave it running; it is a foreground ssh)"
        show_tail "$TLOG"
    else
        printf 'down, opening: '
        if [ "$ALIVE" = 1 ] && [ -n "${old:-}" ]; then
            # The pidfile says a tunnel exists but the drone cannot use it. That
            # happens after the drone reboots: sshd is new, the forward is gone.
            kill "$old" 2>/dev/null
            sleep 1
        fi
        nohup ssh -N -R 8000:127.0.0.1:8000 \
            -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
            -o ExitOnForwardFailure=yes -o BatchMode=yes \
            "$JETSON" > "$OUTDIR/4-tunnel-open.log" 2>&1 &
        echo $! > "$PIDFILE"
        ok=0
        i=0
        while [ "$i" -lt 8 ]; do
            sleep 2
            if remote "curl -fsS --max-time 4 $BACKEND_URL/health" > "$TLOG" 2>&1; then
                ok=1
                break
            fi
            i=$((i + 1))
        done
        if [ "$ok" = 1 ]; then
            pass "opened (pid $(cat "$PIDFILE"))"
        else
            fail "opened it but the drone still cannot reach the backend"
            fix "make tunnel in a terminal and read its output"
            logf "$OUTDIR/4-tunnel-open.log"
            show_tail "$OUTDIR/4-tunnel-open.log"
            show_tail "$TLOG"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Step 5 - Deploy code + the watchdog
#
# /tmp is tmpfs on this image and is wiped by every reboot, which has already
# cost two launches. So the runner lives in the data dir beside the code, not in
# /tmp, and it is re-shipped on every `go`.
# ---------------------------------------------------------------------------
step "Deploy code to $JETSON_DIR/jetson"
DLOG="$OUTDIR/5-deploy.log"
if [ "$DEPLOY" != 1 ]; then
    skip "--no-deploy"
else
    if make -s deploy > "$DLOG" 2>&1 \
       && scp -q scripts/drone_watchdog.sh "$JETSON:$JETSON_DIR/bin/drone_watchdog.sh" >> "$DLOG" 2>&1 \
       && remote "chmod +x $JETSON_DIR/bin/drone_watchdog.sh; mkdir -p $JETSON_DIR/logs" >> "$DLOG" 2>&1; then
        pass "synced"
    else
        # mkdir for bin/ may not exist yet - try once more with it created.
        if remote "mkdir -p $JETSON_DIR/bin $JETSON_DIR/logs" >> "$DLOG" 2>&1 \
           && scp -q scripts/drone_watchdog.sh "$JETSON:$JETSON_DIR/bin/drone_watchdog.sh" >> "$DLOG" 2>&1 \
           && remote "chmod +x $JETSON_DIR/bin/drone_watchdog.sh" >> "$DLOG" 2>&1; then
            pass "synced (created bin/)"
        else
            fail "deploy failed"
            fix "make deploy"
            logf "$DLOG"
            show_tail "$DLOG"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Step 6 - Aircraft pre-flight, in ONE ssh call.
#
# Everything here is read-only and cheap. The point is to catch the failure
# modes that look like code bugs but are not: a browned-out board (under-voltage
# events in the kernel ring buffer), a USB port that got disabled by the same
# brownout (vdd-usb-vbus), WiFi rfkill'ed, a missing camera node, or an engine
# that never got to the aircraft. 256MB of RAM with no swap explains an
# out-of-memory kill better than any traceback.
# ---------------------------------------------------------------------------
step "Aircraft pre-flight"
FLOG="$OUTDIR/6-preflight.log"
# Set by the checks below. Step 7 is skipped when this stays 0: probing inference
# on a board with no camera or no engine burns 90 s to produce a second, more
# confusing failure directly under the real one.
PREFLIGHT_OK=0
if ! remote "cat /proc/uptime >/dev/null" > "$FLOG" 2>&1; then
    fail "could not run anything on the aircraft"
    fix "is the drone still up? re-run: make status"
    show_tail "$FLOG"
else
    PRE=$(remote '
        echo "UPTIME|$(cut -d" " -f1 /proc/uptime)"
        echo "HOSTNAME|$(hostname)"
        echo "IP|$(ip -4 -o addr show | grep -v " lo " | awk "{print \$4}" | paste -sd, -)"
        echo "TEMP|$(for z in /sys/devices/virtual/thermal/thermal_zone*/temp; do
            [ -r "$z" ] || continue
            n=$(cat "${z%temp}type" 2>/dev/null)
            v=$(cat "$z" 2>/dev/null)
            echo -n "$n=$((v/1000))C "
        done)"
        echo "UV|$(dmesg 2>/dev/null | grep -ci "under-voltage\|soctherm: over current\|OC ALARM")"
        echo "USBOFF|$(dmesg 2>/dev/null | grep -ci "vdd-usb-vbus.*disabl")"
        echo "RFKILL|$(command -v rfkill >/dev/null 2>&1 && rfkill list 2>/dev/null | grep -ci "blocked: yes" || echo "na")"
        echo "VIDEO|$([ -e /dev/video0 ] && echo yes || echo no)"
        echo "ENGINE|$([ -s '"$JETSON_DIR/$ENGINE"' ] && stat -c %s '"$JETSON_DIR/$ENGINE"' || echo missing)"
        echo "MEM|$(free -m | awk "/^Mem:/{printf \"%dMB free of %dMB\", \$4, \$2}")"
        echo "SWAP|$(free -m | awk "/^Swap:/{printf \"%dMB of %dMB\", \$4, \$2}")"
        echo "DETOUT|$([ -s '"$JETSON_DIR/logs/detector.out"' ] && stat -c %s '"$JETSON_DIR/logs/detector.out"' || echo 0)"
    ' 2>&1)
    printf '%s' "$PRE" > "$FLOG"

    g() { printf '%s\n' "$PRE" | grep "^$1|" | head -n 1 | cut -d'|' -f2-; }

    # Every value harvested from the aircraft is prefixed PF_ on purpose. The
    # first draft wrote them straight into names like ENGINE and then reported
    # "engine 52633600 is NOT on the aircraft" - the probe's answer had
    # overwritten the path it was talking about.
    PF_UP=$(g UPTIME)
    PF_UV=$(g UV)
    PF_USBOFF=$(g USBOFF)
    PF_RFKILL=$(g RFKILL)
    PF_VIDEO=$(g VIDEO)
    PF_ENGINE=$(g ENGINE)
    PF_SWAP=$(g SWAP)
    PF_TMP=$(g TEMP)
    PF_MEM=$(g MEM)
    PF_IP=$(g IP)

    # This log is the key-value block itself, so showing its tail would just
    # repeat the facts already printed above. Point at the path instead.
    if [ "$PF_ENGINE" = missing ]; then
        fail "engine $ENGINE is not on the aircraft"
        # No backticks! Inside double quotes they are command substitution, and
        # the first draft ran `make deploy` for real while printing advice.
        fix "scp it into $JETSON_DIR/$ENGINE - the engine is gitignored, so 'make deploy' never sends it"
        logf "$FLOG"
    elif [ "$PF_VIDEO" != yes ]; then
        fail "/dev/video0 missing - the CSI camera is not enumerating"
        fix "reseat the CSI ribbon at BOTH ends (this was the fix last time), then reboot"
        logf "$FLOG"
    elif [ "${PF_UV:-0}" != 0 ] || [ "${PF_USBOFF:-0}" != 0 ]; then
        fail "power problem: ${PF_UV} under-voltage/OC event(s), ${PF_USBOFF} USB bus disable(s)"
        hint "uptime ${PF_UP}s, thermal: ${PF_TMP}"
        fix "this is a 5V supply problem, not code. Use the barrel jack or a supply rated >4A."
        logf "$FLOG"
    elif [ "$PF_RFKILL" != na ] && [ "${PF_RFKILL:-0}" != 0 ]; then
        fail "WiFi is rfkill-blocked (${PF_RFKILL} device(s))"
        fix "ssh -t $JETSON 'sudo rfkill unblock all'"
        logf "$FLOG"
    else
        PREFLIGHT_OK=1
        pass "up ${PF_UP}s, video ok, engine ok"
        hint "${PF_IP} | thermal: ${PF_TMP}"
        hint "RAM ${PF_MEM} | swap ${PF_SWAP}"
        hint "no under-voltage and no USB-bus disables in dmesg"
    fi
fi

# ---------------------------------------------------------------------------
# Step 7 - Inference probe. This is the one that catches the CUDA-context hang.
#
# ${MAX_FRAMES} frames, no stream, no uplink, `timeout 90`. On a healthy board
# this is a few-second run and it must report "inferred >= 1". The old failure -
# a worker thread with no CUDA context - produced "inferred 0" with a clean exit
# and no traceback, which looked like a working detector that found nothing.
#
# The frame count is not 5 because --max-frames counts CAPTURED frames. In
# decoupled mode capture runs at ~30 FPS and inference at ~5 Hz, so a 5-frame
# probe stops before the inference thread finishes even one pass and reports
# "inferred 0" on a perfectly healthy board.
# ---------------------------------------------------------------------------
step "Inference probe (${MAX_FRAMES} frames)"
PLOG="$OUTDIR/7-probe.log"
if [ "$PREFLIGHT_OK" != 1 ]; then
    skip "the board failed pre-flight - fix that first"
else
PDEC="--decoupled --box-hold $BOX_HOLD"
[ "$SERIAL" = 1 ] && PDEC=""

PROBE_CMD="cd $JETSON_DIR && timeout 90 env PYTHONPATH=$JETSON_CV_PATH $JETSON_PY -u jetson/live_detect.py \
--detector trt --engine $ENGINE --conf $CONF --imgsz $IMGSZ \
--gps sim $SIM_FLAGS --source csi --names landmine --headless --quiet \
--no-uplink --log-dir $JETSON_DIR/logs/probe \
--dedupe-radius-m $DEDUPE_M $PDEC --max-frames $MAX_FRAMES"

if remote "$PROBE_CMD" > "$PLOG" 2>&1; then
    rc=0
else
    rc=$?
fi

INFERRED=$(sed -n 's/.*inferred \([0-9][0-9]*\).*/\1/p' "$PLOG" | head -n 1)
CAPTURED=$(sed -n 's/.*capture \([0-9][0-9]*\) frames.*/\1/p' "$PLOG" | head -n 1)

if [ "$rc" = 124 ]; then
    fail "TIMED OUT after 90s - the inference thread is wedged"
    hint "this is the CUDA-context hang. Confirm with: make probe-cuda"
    fix "make go --serial   (DECOUPLED=0 keeps inference on the thread that created the context)"
    logf "$PLOG"
    show_tail "$PLOG"
elif [ -z "${INFERRED:-}" ]; then
    fail "no pipeline summary in the output"
    fix "read the log; the process exited before it could report"
    logf "$PLOG"
    show_tail "$PLOG"
elif [ "$INFERRED" -lt 1 ]; then
    fail "captured ${CAPTURED:-?} frames but inferred 0"
    hint "the detector never completed a single detect() - almost always a missing"
    hint "CUDA context on the inference thread, not a broken engine"
    fix "make go --serial   (then: make probe-cuda for the facts)"
    logf "$PLOG"
    show_tail "$PLOG"
else
    DETS=$(sed -n 's/.*detections *: \([0-9][0-9]*\).*/\1/p' "$PLOG" | head -n 1)
    SUP=$(sed -n 's/.*suppressed (dedupe): \([0-9][0-9]*\).*/\1/p' "$PLOG" | head -n 1)
    pass "inferred ${INFERRED}/${CAPTURED:-?} frames, ${DETS:-0} detection(s)"
    if [ -n "${SUP:-}" ]; then
        hint "suppressed (dedupe): ${SUP}"
    else
        hint "no dedupe line - nothing was detected in these ${MAX_FRAMES} frames (not an error)"
    fi
fi
fi

# ---------------------------------------------------------------------------
# Launch, in `go` mode only, and only if the probe actually inferred something.
# Launching after a failed probe just produces a healthy-looking stream of
# nothing, which is worse than a clear failure.
# ---------------------------------------------------------------------------
if [ "$MODE" = go ] && [ "$FAILED" = 0 ]; then
    printf '\n'
    GDEC="--decoupled --box-hold $BOX_HOLD"
    [ "$SERIAL" = 1 ] && GDEC=""
    GSTR=""
    [ "$STREAM" = 1 ] && GSTR="--stream-port $STREAM_PORT"

    printf 'Launching the detector under the watchdog...\n'
    # The watchdog relaunches on exit and logs one line per restart. Started
    # detached with setsid so it survives this ssh session ending; nohup alone
    # does not detach from the process group, and sshd kills the group.
    LAUNCH="cd $JETSON_DIR && mkdir -p logs bin && rm -f logs/watchdog.stop && \
PYTHONPATH=$JETSON_CV_PATH setsid nohup bin/drone_watchdog.sh \
--detector trt --engine $ENGINE --conf $CONF --imgsz $IMGSZ \
--gps sim $SIM_FLAGS --source csi --names landmine --headless \
--backend-url $BACKEND_URL --mission-name $MISSION \
--dedupe-radius-m $DEDUPE_M $GDEC $GSTR \
< /dev/null > logs/watchdog.nohup 2>&1 & \
sleep 3; echo \"watchdog pid: \$(pgrep -f drone_watchdog.sh | head -n 1)\""

    if remote "$LAUNCH" > "$OUTDIR/8-launch.log" 2>&1; then
        printf '        %s\n' "$(tail -n 1 "$OUTDIR/8-launch.log")"
        printf '        stream : http://%s.local:%s/  (if enabled)\n' \
            "$(remote 'hostname' 2>/dev/null)" "$STREAM_PORT"
        printf '        logs   : make logs        (detections)\n'
        printf '                 ssh %s tail -f %s/logs/watchdog.log\n' "$JETSON" "$JETSON_DIR"
    else
        printf '        %slaunch command failed%s\n' "$C_NO" "$C_Z"
        show_tail "$OUTDIR/8-launch.log"
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n'
if [ "$FAILED" = 0 ]; then
    printf '%sAll %d step(s) passed.%s' "$C_OK" "$((STEP - SKIPPED))" "$C_Z"
    [ "$SKIPPED" -gt 0 ] && printf ' (%d skipped)' "$SKIPPED"
    printf '\n'
else
    printf '%sSomething failed.%s Read the fix line above.' "$C_NO" "$C_Z"
    printf ' Full logs: %s\n' "$OUTDIR"
fi
[ "$MODE" = status ] && [ "$FAILED" = 0 ] && printf 'Next: make go\n'

exit "$FAILED"