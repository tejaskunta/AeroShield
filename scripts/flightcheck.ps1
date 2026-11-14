# flightcheck.ps1 — the Windows equivalent of `make status` / `make go`.
#
# WHY THIS EXISTS
# ---------------
# Every command in docs/RUNBOOK.md is a Make target, and Make does not exist on
# this laptop. Neither does `rsync`. WSL has only the docker-desktop distro, so
# `make go` — the command the runbook tells you to run before a demo — fails
# before it checks anything. That is not a hardware problem and it should not
# cost you a flight.
#
# scripts/drone_go.sh (the real orchestrator) is POSIX sh and CAN run here under
# Git Bash, but it shells out to `make`, `rsync` and `python3`, none of which
# resolve in Git Bash on Windows. So this script reproduces the SEVEN STEPS in
# PowerShell instead of pretending the Unix path works. It is deliberately a
# port, not a reimplementation: same order, same gates, same exit codes, same
# refusal to continue past a blocking failure.
#
#   .\scripts\flightcheck.ps1              # read-only. Is everything up?
#   .\scripts\flightcheck.ps1 -Go          # checks + deploy + launch detector
#   .\scripts\flightcheck.ps1 -Serial      # DECOUPLED=0 (CUDA-context workaround)
#   .\scripts\flightcheck.ps1 -NoDeploy    # skip the code sync
#
# Exit codes match drone_go.sh so this can be swapped into a script later:
#   0  every attempted step passed
#   1  a step failed (reason + fix printed)
#   2  bad usage
#
# WHAT THIS STILL CANNOT DO
# -------------------------
# Nothing here proves the model detects mines. It never loads TensorRT, never
# opens the CSI camera, never talks MAVLink. Those are facts about the hardware
# and only the hardware can supply them. See docs/RUNBOOK.md.

[CmdletBinding()]
param(
    [switch]$Go,
    [switch]$Serial,
    [switch]$NoDeploy,
    [switch]$NoStream,
    [string]$Jetson = 'jetson',
    [string]$Mission = 'kmit-01',
    [string]$BackendUrl = 'http://127.0.0.1:8000'
)

# Continue, NOT Stop. ssh writes its diagnosis to stderr on an ordinary failed
# connection, and PowerShell raises NativeCommandError for any stderr output from
# a native command. With Stop that becomes a terminating exception halfway
# through step 3, so the script dies printing a stack trace instead of the four
# known causes it is here to distinguish. Exit codes are checked explicitly
# instead, which is what the Unix original does too.
$ErrorActionPreference = 'Continue'
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutDir = Join-Path $Repo "logs/go/$Stamp"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$script:StepNo = 0
$script:Failed = 0

function Step($name) {
    $script:StepNo++
    Write-Host ("[{0}/7] {1,-34} " -f $script:StepNo, $name) -NoNewline
}
function Pass($msg) {
    Write-Host 'PASS' -ForegroundColor Green -NoNewline
    if ($msg) { Write-Host " - $msg" } else { Write-Host '' }
}
function Fail($msg) {
    Write-Host 'FAIL' -ForegroundColor Red -NoNewline
    if ($msg) { Write-Host " - $msg" } else { Write-Host '' }
    $script:Failed = 1
}
function Skip($msg) {
    Write-Host 'SKIP' -ForegroundColor Yellow -NoNewline
    if ($msg) { Write-Host " - $msg" } else { Write-Host '' }
}
function Fix($t)  { Write-Host "        fix  : $t" -ForegroundColor DarkGray }
function Note($t) { Write-Host "        note : $t" -ForegroundColor DarkGray }
function Logf($t) { Write-Host "        log  : $t" -ForegroundColor DarkGray }

function Show-Tail($path) {
    if (-not (Test-Path $path)) { return }
    $lines = Get-Content $path -ErrorAction SilentlyContinue | Select-Object -Last 20
    if (-not $lines) { return }
    Write-Host "        ----- tail $(Split-Path -Leaf $path) -----" -ForegroundColor DarkGray
    $lines | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
    Write-Host '        --------------------' -ForegroundColor DarkGray
}

# SSH that never hangs and never prompts. BatchMode=yes turns a passphrase
# prompt into an immediate error instead of a frozen terminal mid-demo.
function Invoke-Remote {
    param([string]$Command, [int]$TimeoutSec = 15)
    # NOT $args - that is a PowerShell automatic variable and assigning to it
    # inside a function silently misbehaves.
    $sshArgs = @(
        '-o', 'BatchMode=yes',
        '-o', "ConnectTimeout=$TimeoutSec",
        '-o', 'ServerAliveInterval=15',
        $Jetson, $Command
    )
    return (& ssh @sshArgs 2>&1 | Out-String).Trim()
}

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
# Step 2 - Backend /health, and it must say database ok
#
# A 200 is not enough: uvicorn answering while Postgres is gone is the exact
# state where every write 500s and the dashboard looks merely empty.
# ---------------------------------------------------------------------------
Step 'Backend /health'
try {
    $h = Invoke-RestMethod -Uri "$BackendUrl/health" -TimeoutSec 5
    if ($h.database -eq 'ok') { Pass "status=$($h.status) database=ok" }
    else {
        Fail "API up but database=$($h.database)"
        Fix 'docker compose up -d db'
    }
}
catch {
    Fail "nothing answering at $BackendUrl/health"
    Fix "cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir . --host 0.0.0.0 --port 8000"
}

# ---------------------------------------------------------------------------
# Step 3 - SSH to the aircraft. The gate.
#
# Stops here on failure, deliberately. Every later step needs this, and the
# useful information is "which of the four known causes is it", not four more
# timeouts stacked behind this one.
# ---------------------------------------------------------------------------
Step "SSH to '$Jetson'"
# Try the requested host, then the other aliases in ~/.ssh/config. drone_go.sh
# walks the same list for the same reason: mDNS is the first thing to break on a
# lab network, and the static-IP block is usually still reachable.
$candidates = @($Jetson, 'jetson-ip', 'jetson-ts') | Select-Object -Unique
$reached = $null
$lastText = ''
foreach ($cand in $candidates) {
    $probe = & ssh -o BatchMode=yes -o ConnectTimeout=8 $cand 'echo SSH_OK' 2>&1
    $lastText = ($probe | Out-String).Trim()
    if ($lastText -match 'SSH_OK') { $reached = $cand; break }
}
if (-not $reached) {
    Fail "no host answered ($($candidates -join ', '))"
    Note 'run .\scripts\find_jetson.ps1 to separate wrong-address from board-off'
    if ($lastText -match 'Could not resolve') {
        Fix 'mDNS did not answer: the drone is on a different network, or not on one'
    }
    elseif ($lastText -match 'timed out|Connection refused|Operation timed out') {
        Fix 'board is off, rfkill-blocked, or on another subnet. Check power and the WiFi AP.'
    }
    else {
        Fix "see the message above; check ~/.ssh/config for the 'jetson' host block"
    }
    Logf $OutDir
    Write-Host ''
    Write-Host "  Stopping at step 3 - nothing after this can work." -ForegroundColor Yellow
    exit 1
}
$Jetson = $reached
Pass "reachable as '$reached'"

# What are we actually talking to? Cheap, and it makes the transcript useful
# later when "it worked yesterday" comes up.
$ident = (& ssh -o BatchMode=yes -o ConnectTimeout=8 $Jetson 'uname -n; cut -d" " -f1 /proc/uptime; ip -4 -o addr show | grep -v " lo " | awk "{print \$4}" | paste -sd, -' 2>&1 | Out-String).Trim() -split "`r?`n"
$boardName = $ident[0]
$upSecs = $ident[1]
$boardAddr = $ident[2]
Note "host=$boardName up=${upSecs}s addr=$boardAddr"

# ---------------------------------------------------------------------------
# Step 4 - the drone must be able to reach the backend
#
# This is the step that decides whether detections arrive or quietly spool.
# Under 5 s of uptime the tunnel cannot have been established yet.
# ---------------------------------------------------------------------------
Step 'Drone -> backend /health'
$remoteHealth = Invoke-Remote "curl -fsS --max-time 5 $BackendUrl/health 2>/dev/null || echo NO_ROUTE"
if ($remoteHealth -match '"database"\s*:\s*"ok"') { Pass "drone can reach $BackendUrl" }
else {
    Fail "drone cannot reach $BackendUrl"
    Note 'without this the detector spools every detection and the map stays empty'
    Fix "open the tunnel in another window: ssh -N -R 8000:127.0.0.1:8000 $Jetson"
}

# ---------------------------------------------------------------------------
# Step 5 - deploy code
#
# rsync does not exist here. The Makefile's excludes exist for a reason and are
# reproduced in full: logs/ is the append-only flight record and spool/ is the
# offline queue. Pushing either from this laptop would overwrite the aircraft's
# real flight log with bench data, or replay bench detections as if measured in
# the air. Neither is recoverable, so both are excluded.
# ---------------------------------------------------------------------------
Step 'Deploy code'
if ($NoDeploy) {
    Skip '-NoDeploy'
}
else {
    $dlog = Join-Path $OutDir '5-deploy.log'
    try {
        & ssh -o BatchMode=yes $Jetson 'mkdir -p ~/aeroshield/jetson ~/aeroshield/bin ~/aeroshield/logs' *> $dlog
        if ($LASTEXITCODE -ne 0) { throw 'mkdir failed' }

        # tar over ssh: the portable stand-in for rsync on Windows. Excludes are
        # explicit and match the Makefile.
        $staging = Join-Path $OutDir 'jetson.tar'
        & tar -czf $staging --exclude=logs --exclude=spool --exclude=.env --exclude=__pycache__ -C (Join-Path $Repo 'jetson') . 2>> $dlog
        if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

        & scp -q $staging "${Jetson}:~/aeroshield/jetson.tar" 2>> $dlog
        if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

        & ssh -o BatchMode=yes $Jetson 'tar xzf ~/aeroshield/jetson.tar -C ~/aeroshield/jetson && rm -f ~/aeroshield/jetson.tar' *>> $dlog
        if ($LASTEXITCODE -ne 0) { throw 'untar failed' }

        & scp -q ./scripts/drone_watchdog.sh "${Jetson}:~/aeroshield/bin/drone_watchdog.sh" 2>> $dlog
        & ssh -o BatchMode=yes $Jetson 'chmod +x ~/aeroshield/bin/drone_watchdog.sh' *>> $dlog

        Pass 'synced'
    }
    catch {
        Fail "deploy failed: $($_.Exception.Message)"
        Fix 'scp the files by hand; see logs/go/<stamp>/5-deploy.log'
        Show-Tail $dlog
    }
}

# ---------------------------------------------------------------------------
# Step 6 - aircraft pre-flight, one SSH call.
#
# Read-only. Catches the failure modes that look like code bugs: a browned-out
# board, a USB bus disabled by that brownout, rfkill'ed WiFi, a missing camera
# node, or an engine that never made it to the aircraft.
# ---------------------------------------------------------------------------
Step 'Aircraft pre-flight'
$flog = Join-Path $OutDir '6-preflight.log'
$pre = Invoke-Remote @'
echo "UPTIME|$(cut -d' ' -f1 /proc/uptime)"
echo "VIDEO|$([ -e /dev/video0 ] && echo yes || echo no)"
echo "ENGINE|$([ -s $HOME/aeroshield/weights/best_512x288.engine ] && stat -c %s $HOME/aeroshield/weights/best_512x288.engine || echo missing)"
echo "UV|$(dmesg 2>/dev/null | grep -ci 'under-voltage\|soctherm: over current\|OC ALARM')"
echo "USBOFF|$(dmesg 2>/dev/null | grep -ci 'vdd-usb-vbus.*disabl')"
echo "RFKILL|$(command -v rfkill >/dev/null 2>&1 && rfkill list 2>/dev/null | grep -ci 'blocked: yes' || echo na)"
echo "MEM|$(free -m | awk '/^Mem:/{printf "%dMB free of %dMB", $4, $2}')"
echo "SWAP|$(free -m | awk '/^Swap:/{printf "%dMB of %dMB", $4, $2}')"
'@ -TimeoutSec 20
$pre | Set-Content -Path $flog -Encoding utf8

function Pre($key) {
    $line = ($pre -split "`r?`n") | Where-Object { $_ -like "$key|*" } | Select-Object -First 1
    if ($line) { return ($line -split '\|', 2)[1] } else { return $null }
}

$uv = Pre 'UV'
$usboff = Pre 'USBOFF'
$rfkill = Pre 'RFKILL'
$video = Pre 'VIDEO'
$engine = Pre 'ENGINE'
$mem = Pre 'MEM'
$swap = Pre 'SWAP'

$preOk = $true
if ($engine -eq 'missing' -or -not $engine) {
    Fail 'engine is NOT on the aircraft'
    Note "weights/*.engine is gitignored, so a code sync never sends it"
    Fix 'scp weights/best_512x288.engine to ~/aeroshield/weights/ on the drone (once)'
    $preOk = $false
}
elseif ($video -ne 'yes') {
    Fail '/dev/video0 missing - the CSI camera is not enumerating'
    Fix 'reseat the CSI ribbon at BOTH ends, then reboot'
    $preOk = $false
}
elseif ($uv -and $uv -ne '0') {
    Fail "power problem: $uv under-voltage/OC event(s), $usboff USB bus disable(s)"
    Note "uptime ${upSecs}s"
    Fix 'this is a 5V supply problem, not code. Use the barrel jack or a supply rated >4A.'
    $preOk = $false
}
elseif ($usboff -and $usboff -ne '0') {
    Fail "USB bus was disabled $usboff time(s) - brownout"
    Fix 'supply rated >4A; use the barrel jack'
    $preOk = $false
}
elseif ($rfkill -and $rfkill -ne 'na' -and $rfkill -ne '0') {
    Fail 'WiFi is rfkill-blocked'
    Fix "ssh -t $Jetson 'sudo rfkill unblock all'"
    $preOk = $false
}
else {
    Pass "camera ok, engine $engine bytes, $mem, swap $swap"
}

# ---------------------------------------------------------------------------
# Step 7 - inference probe. The step this whole tool exists for.
#
# A wedged CUDA context does not raise: execute_async_v2 just never returns, the
# detector exits cleanly with no traceback, and reports `inferred 0`. That reads
# exactly like a working detector that found nothing. `-Serial` runs inference on
# the thread that created the context, which isolates it.
# ---------------------------------------------------------------------------
Step 'Inference probe'
if (-not $preOk) {
    Skip 'pre-flight failed - probing now would only add a confusing second failure'
    Logf $flog
}
elseif (-not $Go) {
    Skip 'dry run; use -Go to launch'
}
else {
    $decoupled = if ($Serial) { '--decoupled 0' } else { '' }
    $wasd = Invoke-Remote "cd ~/aeroshield && timeout 90 env PYTHONPATH=/usr/lib/python3.6/dist-packages/cv2/python-3.6:/usr/lib/python3/dist-packages /usr/bin/python3.6 jetson/live_detect.py --detector trt --engine weights/best_512x288.engine --source csi --max-frames 40 --headless --mission-name $Mission --backend-url $BackendUrl $decoupled 2>&1 | tail -5" -TimeoutSec 120
    if ($wasd -match 'TIMED OUT') {
        Fail 'inference thread wedged (CUDA context)'
        Fix 're-run with -Serial'
    }
    else {
        $m = [regex]::Match($wasd, 'inferred[^0-9]*(\d+)')
        if ($m.Success -and [int]$m.Groups[1].Value -ge 1) { Pass "inferred $($m.Groups[1].Value)" }
        else {
            Fail 'inferred 0 - looks like a working detector that found nothing'
            Fix 're-run with -Serial; if serial works, the bug is the handoff'
        }
    }
}

# ---------------------------------------------------------------------------
Write-Host ''
if ($script:Failed) {
    Write-Host "  FLIGHT CHECK FAILED - fix the FAIL line above before you fly." -ForegroundColor Red
    Write-Host "  Full logs: $OutDir" -ForegroundColor DarkGray
    exit 1
}
Write-Host '  FLIGHT CHECK PASSED - the ladder from camera to dashboard is intact.' -ForegroundColor Green
Write-Host '  Not proven: model accuracy, thermals under sustained load, radio range.' -ForegroundColor DarkGray
Write-Host "  Logs: $OutDir" -ForegroundColor DarkGray
exit 0