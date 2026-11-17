# flightcheck.ps1 - the Windows equivalent of `make status` / `make go`.
#
# WHY THIS EXISTS
# ---------------
# Every command in docs/RUNBOOK.md is a Make target, and Make does not exist on
# this laptop. Neither does `rsync`. WSL has only the docker-desktop distro, so
# `make go` - the command the runbook tells you to run before a demo - fails
# before it checks anything. That is not a hardware problem and it should not
# cost you a flight.
#
# scripts/drone_go.sh is the real orchestrator. This is a port of it, not a
# reimplementation: same order, same gates, same refusal to continue past a
# blocking failure. It also does two things drone_go.sh does not: it can fly on
# real GPS (MAVLink), and it can find the aircraft on a phone hotspot.
#
#   .\scripts\flightcheck.ps1                # read-only. Is everything up?
#   .\scripts\flightcheck.ps1 -Go            # checks + deploy + probe + LAUNCH
#   .\scripts\flightcheck.ps1 -Go -Gps sim   # fly on the simulated survey track
#   .\scripts\flightcheck.ps1 -Go -Serial    # DECOUPLED=0 (CUDA-context workaround)
#   .\scripts\flightcheck.ps1 -Stop          # stop the detector and its watchdog
#   .\scripts\flightcheck.ps1 -Snapshot      # full-res straight-down photo for the map
#   .\scripts\flightcheck.ps1 -JetsonIp 192.168.43.17   # skip discovery
#
# Run scripts\tunnel.ps1 in its own window first. It carries the detections to
# the backend and the camera feed back to the dashboard.
#
# Exit codes match drone_go.sh:
#   0  every attempted step passed
#   1  a step failed (reason + fix printed)
#   2  bad usage
#
# WHAT THIS STILL CANNOT DO
# -------------------------
# Nothing here proves the model detects mines. The probe proves TensorRT loads
# and infers on CSI frames. It says nothing about whether the boxes are right.

[CmdletBinding()]
param(
    [switch]$Go,
    [switch]$Stop,
    [switch]$Snapshot,
    [switch]$Serial,
    [switch]$NoDeploy,
    [switch]$NoStream,
    [ValidateSet('mavlink', 'sim')]
    [string]$Gps = 'mavlink',
    [string]$JetsonIp = '',
    [string]$Mission = 'kmit-01',
    [string]$BackendUrl = 'http://127.0.0.1:8000',
    [int]$StreamPort = 8080,
    [string]$GpsUrl = '/dev/ttyACM0:115200'
)

# Continue, NOT Stop: native-command failures are checked by exit code instead.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'jetson_common.ps1')
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

if (@($Go, $Stop, $Snapshot | Where-Object { $_ }).Count -gt 1) { Write-Host 'Use only one of -Go, -Stop, -Snapshot.' -ForegroundColor Red; exit 2 }

# ---------------------------------------------------------------------------
# Flight configuration. Mirrors the Makefile so the two cannot describe
# different flights. SURVEY_* must equal VITE_SURVEY_ORIGIN in
# frontend/.env.local, or the simulated track lands where the map is not looking.
# ---------------------------------------------------------------------------
$JetsonDir = '~/aeroshield'
$CvPath    = '/usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages'
$Py        = '/usr/bin/python3.6'
$Engine    = 'weights/best_512x288.engine'
$Imgsz     = '288 512'
$Conf      = '0.25'
$Names     = 'landmine'
$BoxHold   = '1.5'
$DedupeM   = '1.5'
$SimFlags  = '--sim-origin 17.396947 78.490706 --sim-leg-length 10 --sim-lane-spacing 3 --sim-lanes 4'
$GpsDevice = ($GpsUrl -split ':')[0]

$Decoupled = if ($Serial) { '' } else { "--decoupled --box-hold $BoxHold" }
$GpsFlags  = if ($Gps -eq 'mavlink') { "--gps mavlink --gps-url $GpsUrl --gps-max-age 2.0" } else { "--gps sim $SimFlags" }

$Stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutDir = Join-Path $Repo "logs/go/$Stamp"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$TotalSteps   = 9
$script:StepNo = 0
$script:Failed = 0

function Step($name) {
    $script:StepNo++
    Write-Host ("[{0}/{1}] {2,-34} " -f $script:StepNo, $TotalSteps, $name) -NoNewline
}
function Pass($msg) { Write-Host 'PASS' -ForegroundColor Green -NoNewline; if ($msg) { Write-Host " - $msg" } else { Write-Host '' } }
function Fail($msg) { Write-Host 'FAIL' -ForegroundColor Red -NoNewline; if ($msg) { Write-Host " - $msg" } else { Write-Host '' }; $script:Failed = 1 }
function Skip($msg) { Write-Host 'SKIP' -ForegroundColor Yellow -NoNewline; if ($msg) { Write-Host " - $msg" } else { Write-Host '' } }
function Fix($t)  { Write-Host "        fix  : $t" -ForegroundColor DarkGray }
function Note($t) { Write-Host "        note : $t" -ForegroundColor DarkGray }
function Logf($t) { Write-Host "        log  : $t" -ForegroundColor DarkGray }

function Show-Text($text, $label) {
    if (-not $text) { return }
    $lines = ($text -split "`r?`n") | Select-Object -Last 20
    Write-Host "        ----- $label -----" -ForegroundColor DarkGray
    $lines | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
    Write-Host '        --------------------' -ForegroundColor DarkGray
}

function Save-Log($name, $r) {
    $p = Join-Path $OutDir $name
    @("exit=$($r.Code) timedout=$($r.TimedOut)", '--- stdout', $r.Out, '--- stderr', $r.Err) |
        Set-Content -Path $p -Encoding utf8
    return $p
}

# Key|value lines printed by a remote script -> hashtable.
function ConvertFrom-Kv($text) {
    $h = @{}
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^([A-Z_]+)\|(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() }
    }
    return $h
}

# Stop the watchdog and the detector, and wait until both are gone. The camera
# and the GPS serial port are exclusive, so the probe and the GPS check cannot
# run while a detector from an earlier launch still holds them.
$StopScript = @'
cd ~/aeroshield 2>/dev/null || exit 0
mkdir -p logs
touch logs/watchdog.stop
pkill -f drone_watchdog.sh 2>/dev/null
pkill -INT -f live_detect.py 2>/dev/null
i=0
while pgrep -f live_detect.py >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
pkill -9 -f live_detect.py 2>/dev/null
sleep 1
if pgrep -f 'live_detect.py|drone_watchdog.sh' >/dev/null 2>&1; then echo "STOP|still-running"; else echo "STOP|stopped"; fi
'@

# ---------------------------------------------------------------------------
# -Stop: the stop-drone port. Find the aircraft, stop it, leave.
# ---------------------------------------------------------------------------
if ($Stop) {
    Write-Host 'Stopping the detector on the aircraft...'
    $t = Resolve-Jetson -Ip $JetsonIp
    if (-not $t) { Write-Host '  aircraft not reachable - nothing stopped.' -ForegroundColor Red; exit 1 }
    $r = Invoke-Remote -Target $t -Script $StopScript -TimeoutSec 40
    $kv = ConvertFrom-Kv $r.Out
    if ($kv['STOP'] -eq 'stopped') { Write-Host '  detector and watchdog stopped.' -ForegroundColor Green; exit 0 }
    Write-Host "  could not confirm the stop: $($r.Out) $($r.Err)" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# -Snapshot: one clean, full-resolution, straight-down photo for the map.
#
# Not a frame from the detector: live_detect.py scales to 640x360 in hardware and
# draws boxes on what it saves. This grabs the sensor's full 3264x2464 through
# nvjpegenc (about 0.7 cm/px from 20 m), keeping the last of 40 frames so auto-
# exposure has settled. The camera is exclusive, so a running detector is stopped
# for the capture and relaunched with the exact arguments it had - read from its
# own /proc cmdline, so the snapshot cannot change the flight's configuration.
# Then the photo is copied back and the georef command printed.
# ---------------------------------------------------------------------------
if ($Snapshot) {
    Write-Host 'Taking a straight-down photo for the map overlay...'
    $t = Resolve-Jetson -Ip $JetsonIp
    if (-not $t) { Write-Host '  aircraft not reachable.' -ForegroundColor Red; exit 1 }
    $snapScript = @'
cd ~/aeroshield || exit 1
mkdir -p logs/snapshots
WD=$(pgrep -f bin/drone_watchdog.sh | head -n 1)
ARGS=""
if [ -n "$WD" ]; then ARGS=$(tr '\0' ' ' < /proc/$WD/cmdline | sed 's/^.*drone_watchdog\.sh //'); fi
if [ -n "$WD" ]; then
__STOP__
  sleep 2
fi
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OUT=logs/snapshots/block_$(date -u +%Y%m%dT%H%M%SZ).jpg
rm -f /tmp/aeroshield_snap_*.jpg
for MODE in "3264,2464,21" "1920,1080,30"; do
  W=${MODE%%,*}; R=${MODE#*,}; H=${R%%,*}; F=${R#*,}
  timeout 30 gst-launch-1.0 -q nvarguscamerasrc num-buffers=40 ! "video/x-raw(memory:NVMM),width=$W,height=$H,framerate=$F/1" ! nvjpegenc quality=95 ! multifilesink location=/tmp/aeroshield_snap_%03d.jpg >/dev/null 2>&1
  LAST=$(ls /tmp/aeroshield_snap_*.jpg 2>/dev/null | tail -n 1)
  [ -n "$LAST" ] && break
done
if [ -n "$LAST" ]; then cp "$LAST" "$OUT"; echo "SNAP|$OUT|${W}x${H}|$STAMP"; else echo "SNAP|fail"; fi
rm -f /tmp/aeroshield_snap_*.jpg
if [ -n "$ARGS" ]; then
  rm -f logs/watchdog.stop
  PYTHONPATH=__CVPATH__ setsid nohup bin/drone_watchdog.sh $ARGS < /dev/null > logs/watchdog.nohup 2>&1 &
  sleep 2
  echo "RELAUNCH|$(pgrep -f bin/drone_watchdog.sh | head -n 1)"
fi
'@
    # The stop logic is reused verbatim (minus its own cd/echo), indented into the if.
    $stopBody = (($StopScript -split "`r?`n") | Where-Object { $_ -and $_ -notmatch '^cd |^if pgrep' } | ForEach-Object { "  $_" }) -join "`n"
    $snapScript = $snapScript.Replace('__STOP__', $stopBody).Replace('__CVPATH__', $CvPath)
    $r = Invoke-Remote -Target $t -Script $snapScript -TimeoutSec 120
    $kv = ConvertFrom-Kv $r.Out
    if (-not $kv['SNAP'] -or $kv['SNAP'] -eq 'fail') {
        Write-Host '  capture failed - is the CSI camera free and enumerating?' -ForegroundColor Red
        Show-Text ($r.Out + "`n" + $r.Err) 'snapshot'
        exit 1
    }
    $parts = $kv['SNAP'] -split '\|'
    $remote = "aeroshield/$($parts[0])"
    $localDir = Join-Path $Repo 'logs/snapshots'
    New-Item -ItemType Directory -Force -Path $localDir | Out-Null
    $local = Join-Path $localDir (Split-Path -Leaf $parts[0])
    $c = Copy-FromJetson -Target $t -RemotePath $remote -LocalPath $local
    if ($c.Code -ne 0) { Write-Host "  copy back failed: $($c.Err)" -ForegroundColor Red; exit 1 }
    Write-Host "  photo  : $local  ($($parts[1]))" -ForegroundColor Green
    if ($kv.ContainsKey('RELAUNCH')) {
        if ($kv['RELAUNCH']) { Write-Host "  detector relaunched (watchdog pid $($kv['RELAUNCH']))" -ForegroundColor Green }
        else { Write-Host '  detector did NOT come back - run .\scripts\flightcheck.ps1 -Go -NoDeploy' -ForegroundColor Red }
    }
    Write-Host ''
    Write-Host '  Pin it to the map (click SW, SE, NE, NW corner markers, then Enter):'
    Write-Host "    python scripts\georef_overlay.py --image `"$local`" --click --captured-at $($parts[2])"
    exit 0
}

Write-Host ("AeroShield flight check  mission={0}  gps={1}  mode={2}" -f $Mission, $Gps, $(if ($Go) { 'GO' } else { 'check only' })) -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Step 1 - Postgres
# ---------------------------------------------------------------------------
Step 'Postgres :5432'
$pg = Test-NetConnection -ComputerName 127.0.0.1 -Port 5432 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($pg) { Pass } else {
    Fail 'nothing listening on :5432'
    Fix 'docker compose up -d db'
}

# ---------------------------------------------------------------------------
# Step 2 - Backend /health, and it must say database ok. A 200 alone is not
# enough: uvicorn answering while Postgres is gone is the exact state where
# every write fails with a 500 and the dashboard looks merely empty.
# ---------------------------------------------------------------------------
Step 'Backend /health'
try {
    $h = Invoke-RestMethod -Uri "$BackendUrl/health" -TimeoutSec 5
    if ($h.database -eq 'ok') { Pass "status=$($h.status) database=ok" }
    else { Fail "API up but database=$($h.database)"; Fix 'docker compose up -d db' }
}
catch {
    Fail "nothing answering at $BackendUrl/health"
    Fix "cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir . --host 0.0.0.0 --port 8000"
}

# ---------------------------------------------------------------------------
# Step 3 - find and log in to the aircraft. The gate.
# ---------------------------------------------------------------------------
Step 'Find + SSH to the aircraft'
Write-Host ''
$T = Resolve-Jetson -Ip $JetsonIp
if (-not $T) {
    Write-Host ("[3/{0}] {1,-34} " -f $TotalSteps, 'Find + SSH to the aircraft') -NoNewline
    Fail 'not reachable by alias, last-known address, or subnet sweep'
    Note 'the laptop and the drone dongle must be on the SAME phone hotspot'
    Fix 'power the drone (barrel jack); confirm its dongle joined the hotspot (phone shows connected devices)'
    Fix 'if the phone lists it, re-run with -JetsonIp <that address>'
    Logf $OutDir
    Write-Host ''
    Write-Host '  Stopping at step 3 - nothing after this can work.' -ForegroundColor Yellow
    exit 1
}
$identScript = @'
echo "HOST|$(uname -n)"
echo "UP|$(cut -d' ' -f1 /proc/uptime)"
echo "ADDR|$(ip -4 -o addr show | grep -v ' lo ' | awk '{print $2"="$4}' | paste -sd, -)"
echo "SSID|$(iwgetid -r 2>/dev/null)"
'@
$ident = ConvertFrom-Kv (Invoke-Remote -Target $T -Script $identScript -TimeoutSec 15).Out
$upSecs = $ident['UP']
Write-Host ("[3/{0}] {1,-34} " -f $TotalSteps, 'Find + SSH to the aircraft') -NoNewline
Pass "reachable as $(Get-TargetLabel $T)"
Note "host=$($ident['HOST']) up=${upSecs}s ssid=$($ident['SSID']) addr=$($ident['ADDR'])"

# ---------------------------------------------------------------------------
# Step 4 - the drone must be able to reach the backend THROUGH THE TUNNEL.
# This decides whether detections arrive or quietly spool.
# ---------------------------------------------------------------------------
Step 'Drone -> backend /health'
$rh = Invoke-Remote -Target $T -Script "curl -fsS --max-time 5 $BackendUrl/health 2>/dev/null || echo NO_ROUTE" -TimeoutSec 20
if ($rh.Out -match '"database"\s*:\s*"ok"') { Pass "drone reaches $BackendUrl over the tunnel" }
else {
    Fail "drone cannot reach $BackendUrl"
    Note 'without this the detector spools every detection and the map stays empty'
    Fix 'start .\scripts\tunnel.ps1 in its own window and leave it open'
}

# ---------------------------------------------------------------------------
# Step 5 - deploy code. tar over scp, because there is no rsync here. logs/ and
# spool/ are excluded for the reason AGENTS.md gives: pushing either from this
# laptop overwrites the real flight record or replays bench data as flown.
# ---------------------------------------------------------------------------
Step 'Deploy code'
if ($NoDeploy) { Skip '-NoDeploy' }
else {
    $staging = Join-Path $OutDir 'jetson.tar.gz'
    & tar -czf $staging --exclude=logs --exclude=spool --exclude=.env --exclude=__pycache__ -C (Join-Path $Repo 'jetson') . 2>$null
    if ($LASTEXITCODE -ne 0) {
        Fail 'tar failed on this laptop'
    }
    else {
        $r1 = Invoke-Remote -Target $T -Script 'mkdir -p ~/aeroshield/jetson ~/aeroshield/bin ~/aeroshield/logs' -TimeoutSec 15
        # Home-relative remote paths, not `~/...`: Windows scp speaks SFTP, and the
        # Jetson's OpenSSH 7.6 server cannot expand a tilde in that mode.
        $r2 = Copy-ToJetson -Target $T -LocalPath $staging -RemotePath 'aeroshield/jetson.tar.gz'
        $r3 = Copy-ToJetson -Target $T -LocalPath (Join-Path $Repo 'scripts/drone_watchdog.sh') -RemotePath 'aeroshield/bin/drone_watchdog.sh'
        $r4 = Invoke-Remote -Target $T -Script 'cd ~/aeroshield && tar xzf jetson.tar.gz -C jetson && rm -f jetson.tar.gz && sed -i "s/\r$//" bin/drone_watchdog.sh && chmod +x bin/drone_watchdog.sh && echo DEPLOY_OK' -TimeoutSec 60
        if ($r1.Code -eq 0 -and $r2.Code -eq 0 -and $r3.Code -eq 0 -and $r4.Out -match 'DEPLOY_OK') { Pass 'synced jetson/ and the watchdog' }
        else {
            $p = Save-Log '5-deploy.log' ([pscustomobject]@{ Code = "$($r1.Code)/$($r2.Code)/$($r3.Code)/$($r4.Code)"; TimedOut = $false; Out = $r4.Out; Err = ($r2.Err + "`n" + $r3.Err + "`n" + $r4.Err) })
            Fail 'deploy failed'
            Logf $p
        }
    }
}

# ---------------------------------------------------------------------------
# Step 6 - aircraft pre-flight, one SSH call, read-only. Catches the failures
# that look like code bugs: brownout, a USB bus disabled by that brownout,
# rfkill, a missing camera, no engine, no API key, no flight controller.
# ---------------------------------------------------------------------------
Step 'Aircraft pre-flight'
$preScript = @'
cd ~/aeroshield 2>/dev/null
echo "VIDEO|$([ -e /dev/video0 ] && echo yes || echo no)"
echo "ENGINE|$([ -s __ENGINE__ ] && stat -c %s __ENGINE__ || echo missing)"
echo "UV|$(dmesg 2>/dev/null | grep -ci 'under-voltage\|soctherm: over current\|OC ALARM')"
echo "USBOFF|$(dmesg 2>/dev/null | grep -ci 'vdd-usb-vbus.*disabl')"
echo "RFKILL|$(command -v rfkill >/dev/null 2>&1 && rfkill list 2>/dev/null | grep -ci 'blocked: yes' || echo na)"
echo "MEM|$(free -m | awk '/^Mem:/{printf "%dMB free of %dMB", $4, $2}')"
echo "KEY|$([ -f .env ] && grep -c '^AEROSHIELD_API_KEY=..*' .env || echo noenv)"
echo "TTY|$([ -e __GPSDEV__ ] && echo yes || echo no)"
echo "MAV|$(PYTHONPATH=__CVPATH__ __PY__ -c 'import pymavlink, serial; print("ok")' 2>/dev/null || echo missing)"
echo "RUNNING|$(pgrep -f live_detect.py >/dev/null 2>&1 && echo yes || echo no)"
'@
$preScript = $preScript.Replace('__ENGINE__', $Engine).Replace('__GPSDEV__', $GpsDevice).Replace('__CVPATH__', $CvPath).Replace('__PY__', $Py)
$rp = Invoke-Remote -Target $T -Script $preScript -TimeoutSec 25
$preLog = Save-Log '6-preflight.log' $rp
$pre = ConvertFrom-Kv $rp.Out

$preOk = $true
if (-not $pre['ENGINE'] -or $pre['ENGINE'] -eq 'missing') {
    Fail 'engine is NOT on the aircraft'
    Note 'weights/*.engine is gitignored and device-built, so a code sync never sends it'
    Fix "build it on the drone (jetson/build_engine.sh) or scp an engine built ON THIS Nano to ~/aeroshield/$Engine"
    $preOk = $false
}
elseif ($pre['VIDEO'] -ne 'yes') {
    Fail '/dev/video0 missing - the CSI camera is not enumerating'
    Fix 'reseat the CSI ribbon at BOTH ends, then reboot'
    $preOk = $false
}
elseif ($pre['UV'] -and $pre['UV'] -ne '0') {
    Fail "power problem: $($pre['UV']) under-voltage/OC event(s), $($pre['USBOFF']) USB bus disable(s) since boot"
    Note "uptime ${upSecs}s - the WiFi dongle is on that USB bus"
    Fix 'this is the 5V supply, not code. Barrel jack, supply rated >4A.'
    $preOk = $false
}
elseif ($pre['USBOFF'] -and $pre['USBOFF'] -ne '0') {
    Fail "USB bus was disabled $($pre['USBOFF']) time(s) - brownout"
    Fix 'supply rated >4A on the barrel jack'
    $preOk = $false
}
elseif ($pre['RFKILL'] -and $pre['RFKILL'] -ne 'na' -and $pre['RFKILL'] -ne '0') {
    Fail 'WiFi is rfkill-blocked'
    Fix "ssh -t jetson 'sudo rfkill unblock all'"
    $preOk = $false
}
elseif (-not ($pre['KEY'] -match '^\d+$' -and [int]$pre['KEY'] -ge 1)) {
    Fail 'no AEROSHIELD_API_KEY in ~/aeroshield/.env on the aircraft'
    Note 'every POST would be refused with 401 and spool - a silent dashboard, not an error'
    Fix 'cd backend; .\.venv\Scripts\python.exe scripts\create_api_key.py --name drone-01 --preset drone   then put it in the drone .env'
    $preOk = $false
}
elseif ($Gps -eq 'mavlink' -and $pre['TTY'] -ne 'yes') {
    Fail "flight controller not on $GpsDevice"
    Fix 'plug the Pixhawk USB into the Jetson, or fly the simulated track:  -Go -Gps sim'
    $preOk = $false
}
elseif ($Gps -eq 'mavlink' -and $pre['MAV'] -ne 'ok') {
    Fail 'pymavlink/pyserial not importable by python3.6'
    Fix 'make deps-drone (from a machine with make), or fly the simulated track:  -Go -Gps sim'
    $preOk = $false
}
else {
    Pass "camera ok, engine $($pre['ENGINE']) bytes, $($pre['MEM']), api key set"
}
if ($pre['RUNNING'] -eq 'yes') { Note 'a detector is already running on the aircraft' }
if (-not $preOk) { Logf $preLog }

# With -Go, stop any earlier run now: the GPS port and the camera are exclusive.
$detectorBusy = ($pre['RUNNING'] -eq 'yes')
if ($Go -and $preOk -and $detectorBusy) {
    $rs = Invoke-Remote -Target $T -Script $StopScript -TimeoutSec 40
    if ((ConvertFrom-Kv $rs.Out)['STOP'] -eq 'stopped') { Note 'stopped the earlier detector so the port and camera are free'; $detectorBusy = $false }
    else { Note "could not stop the earlier detector: $($rs.Out)" }
}

# ---------------------------------------------------------------------------
# Step 7 - a real GPS fix, read straight off the flight controller. Without a 3D
# fix every detection is logged with no position and the map, correctly,
# refuses to plot it - so the flight would look like it found nothing.
# ---------------------------------------------------------------------------
Step 'GPS fix (MAVLink)'
if ($Gps -ne 'mavlink') { Skip '-Gps sim: positions come from the simulated survey track' }
elseif (-not $preOk) { Skip 'pre-flight failed' }
elseif ($detectorBusy) { Skip 'a detector holds the serial port; -Go stops it first' }
else {
    $gpsScript = "cd ~/aeroshield && timeout 25 env PYTHONPATH=$CvPath $Py -u jetson/gps.py --gps mavlink --url $GpsUrl --count 12 2>&1"
    $rg = Invoke-Remote -Target $T -Script $gpsScript -TimeoutSec 40
    $gpsLog = Save-Log '7-gps.log' $rg
    $fixLine = ($rg.Out -split "`r?`n") | Where-Object { $_ -match 'lat=' } | Select-Object -Last 1
    if ($fixLine) {
        $sats = if ($fixLine -match 'sats=(\S+)') { $Matches[1] } else { '?' }
        Pass "3D fix, $sats satellites"
        Note $fixLine.Trim()
    }
    else {
        Fail 'no 3D fix from the flight controller'
        Note 'outdoors with clear sky, a cold start can take a few minutes. Indoors it will not lock.'
        Fix 'wait for the fix and re-run, or fly the simulated track:  -Go -Gps sim'
        Logf $gpsLog
        Show-Text $rg.Out 'gps.py'
    }
}

# ---------------------------------------------------------------------------
# Step 8 - inference probe. --no-uplink and its own log dir, exactly as
# drone_go.sh: the probe must never post to the live mission or leave rows in
# the spool, because a spool replays later as though it were flown.
#
# A wedged CUDA context does not raise - the detector exits cleanly having
# inferred nothing, which reads exactly like a working detector that found no
# mines. -Serial keeps inference on the thread that owns the context.
# ---------------------------------------------------------------------------
Step 'Inference probe (40 frames)'
$probeOk = $false
if (-not $Go) { Skip 'check only; -Go runs the probe and launches' }
elseif ($script:Failed) { Skip 'an earlier step failed - fix that first' }
else {
    $probeScript = "cd ~/aeroshield && timeout 90 env PYTHONPATH=$CvPath $Py -u jetson/live_detect.py --detector trt --engine $Engine --conf $Conf --imgsz $Imgsz --gps sim $SimFlags --source csi --names $Names --headless --quiet --no-uplink --log-dir logs/probe --dedupe-radius-m $DedupeM $Decoupled --max-frames 40 2>&1; echo EXIT_CODE=`$?"
    $rpr = Invoke-Remote -Target $T -Script $probeScript -TimeoutSec 120
    $probeLog = Save-Log '8-probe.log' $rpr
    $exit = if ($rpr.Out -match 'EXIT_CODE=(\d+)') { [int]$Matches[1] } else { -1 }
    $inferred = if ($rpr.Out -match 'inferred\s+(\d+)') { [int]$Matches[1] } else { $null }
    $captured = if ($rpr.Out -match 'capture\s+(\d+)\s+frames') { $Matches[1] } else { '?' }
    if ($exit -eq 124 -or $rpr.TimedOut) {
        Fail 'TIMED OUT - the inference thread is wedged (CUDA context)'
        Fix 're-run with -Serial'
        Logf $probeLog
    }
    elseif ($null -eq $inferred) {
        Fail "no pipeline summary (exit $exit) - the detector died before reporting"
        Logf $probeLog
        Show-Text $rpr.Out 'probe'
    }
    elseif ($inferred -lt 1) {
        Fail "captured $captured frames but inferred 0"
        Fix 're-run with -Serial; if serial works, the bug is the thread handoff'
        Logf $probeLog
    }
    else {
        $dets = if ($rpr.Out -match 'detections\s*:\s*(\d+)') { $Matches[1] } else { '0' }
        Pass "inferred $inferred/$captured frames, $dets detection(s), nothing uploaded"
        $probeOk = $true
    }
}

# ---------------------------------------------------------------------------
# Step 9 - LAUNCH under the watchdog, then prove the feed reaches this laptop.
# Only if every earlier step passed: launching after a failure produces a
# healthy-looking stream of nothing, which is worse than a clear failure.
#
# setsid, not nohup alone: sshd kills the session's process group when the
# connection closes, and nohup does not leave the group (RUNBOOK.md).
# ---------------------------------------------------------------------------
Step 'Launch + live feed'
if (-not $Go) { Skip 'check only' }
elseif ($script:Failed -or -not $probeOk) { Skip 'not launching after a failed step' }
else {
    $streamFlag = if ($NoStream) { '' } else { "--stream-port $StreamPort" }
    $launchScript = "cd ~/aeroshield && mkdir -p logs bin && rm -f logs/watchdog.stop && PYTHONPATH=$CvPath setsid nohup bin/drone_watchdog.sh --detector trt --engine $Engine --conf $Conf --imgsz $Imgsz $GpsFlags --source csi --names $Names --headless --backend-url $BackendUrl --mission-name $Mission --dedupe-radius-m $DedupeM $Decoupled $streamFlag < /dev/null > logs/watchdog.nohup 2>&1 &`nsleep 3`necho `"WD|`$(pgrep -f drone_watchdog.sh | head -n 1)`""
    $rl = Invoke-Remote -Target $T -Script $launchScript -TimeoutSec 30
    $launchLog = Save-Log '9-launch.log' $rl
    $wd = (ConvertFrom-Kv $rl.Out)['WD']
    if (-not $wd) {
        Fail 'watchdog did not start'
        Logf $launchLog
        Show-Text ($rl.Out + "`n" + $rl.Err) 'launch'
    }
    elseif ($NoStream) {
        Pass "detector running under watchdog pid $wd (no stream, -NoStream)"
    }
    else {
        # The engine takes a while to deserialise; poll the feed for up to ~60 s.
        $tmp = Join-Path $OutDir 'frame.mjpg'
        # Is laptop :8080 really the tunnel? Anything listening there used to count,
        # so a leftover dev_mjpeg.py (a stand-in camera) gave a false "feed live".
        # Only an ssh process holding the port is the tunnel. Re-checked every poll.
        function Test-TunnelFeed {
            $c = Get-NetTCPConnection -LocalPort $StreamPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $c) { return 'none' }
            $name = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            if ($name -like 'ssh*') { return 'tunnel' }
            return "other:$name"
        }
        $holder = Test-TunnelFeed
        $tunnelFeed = $holder -eq 'tunnel'
        if ($holder -like 'other:*') {
            Note "laptop :$StreamPort is held by '$($holder.Substring(6))', not the tunnel - stop it (dev_mjpeg.py?) and run tunnel.ps1"
        }
        $okFeed = $false
        $bytes = 0
        for ($i = 0; $i -lt 12 -and -not $okFeed; $i++) {
            Start-Sleep -Seconds 5
            $tunnelFeed = (Test-TunnelFeed) -eq 'tunnel'
            if ($tunnelFeed) {
                Remove-Item $tmp -ErrorAction SilentlyContinue
                $null = Invoke-Native -FilePath 'curl.exe' -ArgumentList @('-s', '--max-time', '4', '-o', $tmp, "http://127.0.0.1:$StreamPort/stream") -TimeoutSec 10
                if (Test-Path $tmp) {
                    $data = [System.IO.File]::ReadAllBytes($tmp)
                    $bytes = $data.Length
                    # JPEG start-of-image marker anywhere in the multipart body.
                    $soi = $false
                    for ($k = 0; $k -lt [Math]::Min($data.Length - 1, 4096); $k++) {
                        if ($data[$k] -eq 0xFF -and $data[$k + 1] -eq 0xD8) { $soi = $true; break }
                    }
                    if ($soi -and $bytes -gt 10240) { $okFeed = $true }
                }
            }
            else {
                $rr = Invoke-Remote -Target $T -Script "ss -ltn 2>/dev/null | grep -q ':$StreamPort ' && echo LISTEN" -TimeoutSec 10
                if ($rr.Out -match 'LISTEN') { $okFeed = $true }
            }
        }
        $wdTail = (Invoke-Remote -Target $T -Script 'tail -n 3 ~/aeroshield/logs/watchdog.log 2>/dev/null' -TimeoutSec 10).Out
        if ($okFeed -and $tunnelFeed) {
            Pass "watchdog pid $wd, feed live through the tunnel ($([int]($bytes/1024)) KB in 4 s)"
        }
        elseif ($okFeed) {
            Pass "watchdog pid $wd, drone serving :$StreamPort"
            Note "but nothing on this laptop's :$StreamPort - the dashboard cannot see it until tunnel.ps1 is running"
        }
        else {
            Fail "detector launched (watchdog pid $wd) but no camera frames after 60 s"
            Fix 'ssh jetson tail -n 40 ~/aeroshield/logs/detector.out'
            Show-Text $wdTail 'watchdog.log'
        }
        if ($wdTail) { Note ('watchdog: ' + (($wdTail -split "`r?`n") | Select-Object -Last 1)) }
    }
}

# ---------------------------------------------------------------------------
Write-Host ''
if ($script:Failed) {
    Write-Host '  FLIGHT CHECK FAILED - fix the FAIL line above before you fly.' -ForegroundColor Red
    Write-Host "  Full logs: $OutDir" -ForegroundColor DarkGray
    exit 1
}
if ($Go) {
    Write-Host '  LAUNCHED. Dashboard: http://localhost:5173/mission - it flips Simulated -> Live on the first telemetry post.' -ForegroundColor Green
    Write-Host '  Stop the detector:  .\scripts\flightcheck.ps1 -Stop' -ForegroundColor DarkGray
}
else {
    Write-Host '  CHECKS PASSED. Run with -Go to probe and launch.' -ForegroundColor Green
}
Write-Host '  Not proven: model accuracy, thermals under sustained load, radio range.' -ForegroundColor DarkGray
Write-Host "  Logs: $OutDir" -ForegroundColor DarkGray
exit 0
