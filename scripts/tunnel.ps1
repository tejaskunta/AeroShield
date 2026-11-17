# tunnel.ps1 - the one SSH connection the whole flight rides on.
#
#   .\scripts\tunnel.ps1                    # find the aircraft, hold the tunnel
#   .\scripts\tunnel.ps1 -JetsonIp 10.0.0.7 # skip discovery
#
# Leave it running in its own window for the whole flight.
#
# WHAT IT CARRIES
# ---------------
#   -R 8000  drone 127.0.0.1:8000  ->  laptop 127.0.0.1:8000   detections + telemetry
#   -L 8080  laptop 127.0.0.1:8080 ->  drone  127.0.0.1:8080   the MJPEG camera feed
#
# The drone posts to its own loopback and the backend's port arrives there over
# this connection (FLIGHT-DAY.md section 3). The feed now comes back the same
# way, which is the point of this script: the dashboard reads the camera from
# http://127.0.0.1:8080 (frontend/vite.config.ts) whatever address the phone
# hotspot gave the aircraft. Nothing in the frontend has to change when the DHCP
# lease does, and which of the Jetson's two WiFi interfaces holds the default
# route stops mattering, because no traffic leaves loopback on either end.
#
# WHY A LOOP
# ----------
# A phone hotspot drops clients. A plain `ssh -N` exits when that happens, the
# drone's next POST hits a closed loopback port, and every detection spools
# while the drone's own log says all is well (the failure FLIGHT-DAY.md warns is
# the most embarrassing, because nothing visibly errors). Here a drop is a
# timestamped line and a reconnect three seconds later. The spool replays
# itself once the link is back, so a blip costs latency, not data.
#
# ServerAliveInterval=5 x CountMax=3 notices a dead link in ~15 s rather than the
# TCP default of minutes. ExitOnForwardFailure makes a port that is already taken
# (a stale tunnel, or dev_mjpeg.py holding :8080) a loud exit instead of a
# tunnel that connects but carries nothing.

[CmdletBinding()]
param(
    [string]$JetsonIp = '',
    [int]$BackendPort = 8000,
    [int]$StreamPort = 8080,
    [int]$RetryDelaySec = 3
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'jetson_common.ps1')

function Stamp { (Get-Date -Format 'HH:mm:ss') }

# A stand-in camera on :8080 would make -L fail on every attempt. Say so once,
# clearly, instead of looping on an opaque forwarding error.
$busy = Get-NetTCPConnection -LocalPort $StreamPort -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $owner = (Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Write-Host "[$(Stamp)] :$StreamPort is already in use on this laptop (process: $owner)." -ForegroundColor Yellow
    Write-Host "           If that is scripts/dev_mjpeg.py, stop it - the real feed needs this port." -ForegroundColor Yellow
}

$backendUp = Test-NetConnection -ComputerName 127.0.0.1 -Port $BackendPort -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $backendUp) {
    Write-Host "[$(Stamp)] nothing listening on 127.0.0.1:$BackendPort yet - start the backend too, or the drone spools." -ForegroundColor Yellow
}

$attempt = 0
while ($true) {
    $attempt++
    Write-Host "[$(Stamp)] locating the aircraft..." -ForegroundColor Cyan
    $target = Resolve-Jetson -Ip $JetsonIp
    if (-not $target) {
        Write-Host "[$(Stamp)] aircraft not found. Is it powered, and has its dongle joined the hotspot? Retrying in 10 s." -ForegroundColor Red
        Start-Sleep -Seconds 10
        continue
    }

    $sshArgs = @(
        '-N',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        # The config's own RemoteForward would be requested a second time
        # alongside -R and fail; clear it and state both forwards here.
        '-o', 'ClearAllForwardings=yes',
        '-R', "${BackendPort}:127.0.0.1:${BackendPort}",
        '-L', "${StreamPort}:127.0.0.1:${StreamPort}"
    )
    if ($target.Ip) {
        $sshArgs += @('-o', "HostName=$($target.Ip)",
                      '-o', 'HostKeyAlias=aeroshield-jetson',
                      '-o', 'StrictHostKeyChecking=accept-new')
    }
    $sshArgs += $target.Alias

    Write-Host "[$(Stamp)] tunnel UP to $(Get-TargetLabel $target)  (drone:$BackendPort -> backend, laptop:$StreamPort -> feed). Ctrl-C to close." -ForegroundColor Green
    $started = Get-Date
    & ssh @sshArgs
    $code = $LASTEXITCODE
    $held = [int]((Get-Date) - $started).TotalSeconds
    Write-Host "[$(Stamp)] tunnel DOWN after ${held}s (ssh exit $code). Detections spool on the drone until it is back. Reconnecting in ${RetryDelaySec}s." -ForegroundColor Red

    # A forwarding failure exits immediately; do not spin on it.
    if ($held -lt 5) {
        Write-Host "           exited within 5 s - usually a port already taken: another tunnel window, dev_mjpeg.py on :$StreamPort, or the drone still holding :$BackendPort from the dropped session." -ForegroundColor DarkGray
        # After a hotspot drop the drone's sshd keeps the OLD session's 127.0.0.1:8000
        # forward bound for minutes (no ClientAliveInterval on the image), so every
        # reconnect would fail on `ExitOnForwardFailure` while detections spool. Free
        # it: the stale sshd child runs as our own user, so `ss -p` names it and we may
        # kill it. Over a separate connection with no forwards of its own.
        $free = @'
pid=$(ss -ltnp 2>/dev/null | grep '127.0.0.1:__PORT__ ' | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2)
if [ -n "$pid" ]; then kill "$pid" 2>/dev/null && echo "FREED|$pid" || echo "FREED|denied"; else echo "FREED|none"; fi
'@
        $r = Invoke-Remote -Target $target -Script ($free.Replace('__PORT__', "$BackendPort")) -TimeoutSec 15
        if ($r.Out -match 'FREED\|(\d+)') {
            Write-Host "           freed the drone's stale :$BackendPort forward (sshd pid $($Matches[1]))." -ForegroundColor Yellow
        }
        Start-Sleep -Seconds 2
    }
    Start-Sleep -Seconds $RetryDelaySec
}
