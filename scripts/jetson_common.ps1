# jetson_common.ps1 - shared by flightcheck.ps1, tunnel.ps1 and find_jetson.ps1.
# Dot-source it:   . (Join-Path $PSScriptRoot 'jetson_common.ps1')
#
# WHY THIS EXISTS
# ---------------
# On a phone hotspot the aircraft gets whatever DHCP address the phone hands out.
# mDNS (`kmit-desktop.local`) does not resolve from this laptop, and `jetson-ip`
# is the old campus address, so neither ssh alias reaches it. Every script that
# talks to the drone therefore needs the same answer to "where is it right now",
# and they must agree, or the tunnel goes to one address while the check probes
# another. This file is that one answer.
#
# HOW AN ADDRESS IS USED
# ----------------------
# A discovered address is applied as `ssh -o HostName=<ip> jetson`, never as
# `ssh kmit@<ip>`. That keeps everything else the `Host jetson` block in
# ~/.ssh/config declares - the user, the key, IdentitiesOnly, keep-alives - so
# there is still exactly one place that says how to log in to the aircraft.
#
# HostKeyAlias pins every discovered address to ONE known_hosts entry. Without it
# each new DHCP lease is a new host as far as ssh is concerned, BatchMode turns
# the "are you sure?" prompt into "Host key verification failed", and that reads
# as a dead drone. accept-new records the key the first time and still refuses a
# key that CHANGES, which is the case that actually matters.

$script:JetsonAlias   = 'jetson'
$script:JetsonAliases = @('jetson', 'jetson-ip', 'jetson-ts')
$script:RepoRoot      = Split-Path -Parent $PSScriptRoot
$script:IpCacheFile   = Join-Path $script:RepoRoot 'logs/last_jetson_ip.txt'
# Host keys seen while PROBING sweep candidates go here, never into the real
# known_hosts under the aircraft's alias (see Get-SshOptions -Probe).
$script:ProbeKnownHosts = Join-Path $script:RepoRoot 'logs/known_hosts.probe'

# ---------------------------------------------------------------------------
# A target is what every ssh/scp call is aimed at: the alias, plus an address
# override when discovery found one.
# ---------------------------------------------------------------------------
function New-JetsonTarget {
    param([string]$Alias = 'jetson', [string]$Ip = '')
    return [pscustomobject]@{ Alias = $Alias; Ip = $Ip }
}

function Get-TargetLabel($Target) {
    if ($Target.Ip) { return "$($Target.Alias) @ $($Target.Ip)" }
    return $Target.Alias
}

# Options for every NON-tunnel connection.
#
# ClearAllForwardings is not tidying. `Host jetson` declares RemoteForward 8000,
# so once tunnel.ps1 holds that port, every other `ssh jetson` asks for it again
# and prints "remote port forwarding failed". That warning lands in the middle of
# output this script parses line by line.
function Get-SshOptions {
    param($Target, [int]$ConnectTimeout = 8, [switch]$Probe)
    $o = @(
        '-o', 'BatchMode=yes',
        '-o', "ConnectTimeout=$ConnectTimeout",
        '-o', 'ServerAliveInterval=15',
        '-o', 'ClearAllForwardings=yes'
    )
    if ($Target.Ip -and $Probe) {
        # A sweep candidate is not yet known to be the aircraft. Pinning its key under
        # the aircraft's alias (accept-new) would let the first stranger on the hotspot
        # with sshd claim that alias, and the real drone would then be refused as a
        # changed key. Probe keys go to a scratch file instead; the alias is only used
        # once the jetson key has actually logged in.
        $kh = $script:ProbeKnownHosts
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $kh) | Out-Null
        $o += @(
            '-o', "HostName=$($Target.Ip)",
            '-o', "UserKnownHostsFile=$kh",
            '-o', 'StrictHostKeyChecking=no'
        )
    }
    elseif ($Target.Ip) {
        $o += @(
            '-o', "HostName=$($Target.Ip)",
            '-o', 'HostKeyAlias=aeroshield-jetson',
            '-o', 'StrictHostKeyChecking=accept-new'
        )
    }
    return $o
}

# ---------------------------------------------------------------------------
# Run a native program with clean stdout, stderr, exit code and a hard timeout.
#
# Not `& ssh ... 2>&1`. On Windows PowerShell 5.1 that wraps every stderr line
# in an ErrorRecord, so the "output" comes back decorated with `At line:` noise,
# and an exit code of 0 can still set $? to false. A Process object gives the
# three streams separately, and lets a hung connection be killed instead of
# freezing the check mid-demo.
# ---------------------------------------------------------------------------
function Invoke-Native {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSec = 30
    )
    $quoted = $ArgumentList | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ($quoted -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    try { [void]$p.Start() }
    catch {
        return [pscustomobject]@{ Code = 127; Out = ''; Err = $_.Exception.Message; TimedOut = $false }
    }
    $p.StandardInput.Close()
    # Read both streams concurrently, or a chatty stderr fills its pipe buffer and
    # the child blocks forever waiting for us to drain it.
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()

    $timedOut = -not $p.WaitForExit($TimeoutSec * 1000)
    if ($timedOut) {
        try { $p.Kill() } catch { }
        [void]$p.WaitForExit(3000)
    }
    $code = if ($timedOut) { 124 } else { $p.ExitCode }
    return [pscustomobject]@{
        Code     = $code
        Out      = $outTask.Result.Trim()
        Err      = $errTask.Result.Trim()
        TimedOut = $timedOut
    }
}

# ---------------------------------------------------------------------------
# Run a shell script on the aircraft.
#
# The script travels base64-encoded and is decoded on the far side. That is what
# makes quoting a non-issue: PowerShell 5.1 does not escape embedded double
# quotes when it builds a native command line, so `cut -d" "` or an awk program
# arrives at the drone mangled. A base64 blob has no quotes, no spaces and no
# `$` for anything to mangle. Line endings are forced to LF first, because a .ps1
# saved with CRLF would hand `sh` a `\r` at the end of every line.
# ---------------------------------------------------------------------------
function Invoke-Remote {
    param($Target, [Parameter(Mandatory)] [string]$Script, [int]$TimeoutSec = 30)
    $lf = ($Script -replace "`r`n", "`n") -replace "`r", "`n"
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($lf))
    $remote = "echo $b64 | base64 -d | sh"
    $a = (Get-SshOptions -Target $Target) + @($Target.Alias, $remote)
    return Invoke-Native -FilePath 'ssh.exe' -ArgumentList $a -TimeoutSec $TimeoutSec
}

function Copy-ToJetson {
    param($Target, [string]$LocalPath, [string]$RemotePath, [int]$TimeoutSec = 120)
    $a = (Get-SshOptions -Target $Target) + @('-q', $LocalPath, "$($Target.Alias):$RemotePath")
    return Invoke-Native -FilePath 'scp.exe' -ArgumentList $a -TimeoutSec $TimeoutSec
}

function Copy-FromJetson {
    param($Target, [string]$RemotePath, [string]$LocalPath, [int]$TimeoutSec = 120)
    $a = (Get-SshOptions -Target $Target) + @('-q', "$($Target.Alias):$RemotePath", $LocalPath)
    return Invoke-Native -FilePath 'scp.exe' -ArgumentList $a -TimeoutSec $TimeoutSec
}

function Test-JetsonTarget {
    param($Target, [int]$ConnectTimeout = 6, [switch]$Probe)
    $a = (Get-SshOptions -Target $Target -ConnectTimeout $ConnectTimeout -Probe:$Probe) + @($Target.Alias, 'echo SSH_OK')
    $r = Invoke-Native -FilePath 'ssh.exe' -ArgumentList $a -TimeoutSec ($ConnectTimeout + 6)
    return [pscustomobject]@{ Ok = ($r.Out -match 'SSH_OK'); Detail = $r.Err }
}

# ---------------------------------------------------------------------------
# Subnet sweep for an open :22, in parallel.
#
# Only interfaces with a default gateway are swept. That is the phone hotspot or
# the venue WiFi, and it skips the VMware, VirtualBox and Tailscale adapters that
# would otherwise triple the sweep and find nothing. All 254 connects are
# started at once and given one shared deadline, so a /24 takes about a second
# rather than the ~50 s a one-at-a-time sweep needs.
# ---------------------------------------------------------------------------
function Get-SweepInterfaces {
    $gw = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address }
    foreach ($cfg in $gw) {
        foreach ($a in @($cfg.IPv4Address)) {
            if ($a.IPAddress -like '169.254.*' -or $a.IPAddress -like '127.*') { continue }
            [pscustomobject]@{ IPAddress = $a.IPAddress; Alias = $cfg.InterfaceAlias }
        }
    }
}

function Find-OpenSsh {
    param([int]$TimeoutMs = 1200)
    $hits = @()
    foreach ($iface in @(Get-SweepInterfaces)) {
        $parts = $iface.IPAddress -split '\.'
        if ($parts.Count -ne 4) { continue }
        $prefix = ($parts[0..2] -join '.')
        $pending = @()
        foreach ($n in 1..254) {
            $ip = "$prefix.$n"
            if ($ip -eq $iface.IPAddress) { continue }
            $c = New-Object System.Net.Sockets.TcpClient
            try { $pending += [pscustomobject]@{ Ip = $ip; Client = $c; Task = $c.ConnectAsync($ip, 22) } }
            catch { $c.Dispose() }
        }
        $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
        foreach ($p in $pending) {
            $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
            try {
                if ($p.Task.Wait($left) -and $p.Client.Connected) {
                    $hits += [pscustomobject]@{ Ip = $p.Ip; Via = $iface.Alias }
                }
            }
            catch { }
        }
        foreach ($p in $pending) { $p.Client.Dispose() }
    }
    return $hits
}

# ---------------------------------------------------------------------------
# Where is the aircraft right now?
#
#   1. -JetsonIp given explicitly          (the operator knows; trust them)
#   2. the address that worked last time   (logs/last_jetson_ip.txt)
#   3. the ssh aliases                     (mDNS, then the campus static IP)
#   4. a sweep of the current WiFi /24     (the phone-hotspot case)
#
# A candidate only counts once `ssh ... echo SSH_OK` succeeds with the jetson
# key. An open :22 alone could be a router or someone's laptop. Logging in proves
# it is the aircraft.
# ---------------------------------------------------------------------------
function Save-JetsonIp([string]$Ip) {
    if (-not $Ip) { return }
    $dir = Split-Path -Parent $script:IpCacheFile
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-Content -Path $script:IpCacheFile -Value $Ip -Encoding ascii
}

function Resolve-Jetson {
    param([string]$Ip = '', [switch]$Quiet)
    function Say($t) { if (-not $Quiet) { Write-Host "        find : $t" -ForegroundColor DarkGray } }

    if ($Ip) {
        $t = New-JetsonTarget -Ip $Ip
        $r = Test-JetsonTarget $t
        if ($r.Ok) { Save-JetsonIp $Ip; return $t }
        Say "$Ip given with -JetsonIp did not accept the jetson key: $($r.Detail)"
        return $null
    }

    if (Test-Path $script:IpCacheFile) {
        $cached = (Get-Content $script:IpCacheFile -TotalCount 1).Trim()
        if ($cached) {
            $t = New-JetsonTarget -Ip $cached
            if ((Test-JetsonTarget $t -ConnectTimeout 4).Ok) { Say "last known address $cached"; return $t }
            Say "last known address $cached no longer answers"
        }
    }

    foreach ($alias in $script:JetsonAliases) {
        # jetson-ts ships pointing at a 100.64.0.0 placeholder until Tailscale is set
        # up; probing that would only add a timeout. Try it once it is real.
        if ($alias -eq 'jetson-ts') {
            $tsHost = (& ssh -G jetson-ts 2>$null | Select-String '^hostname ' | ForEach-Object { ($_ -split ' ', 2)[1] }) | Select-Object -First 1
            if (-not $tsHost -or $tsHost -eq '100.64.0.0' -or $tsHost -eq 'jetson-ts') { continue }
        }
        $t = New-JetsonTarget -Alias $alias
        if ((Test-JetsonTarget $t -ConnectTimeout 5).Ok) {
            # The `jetson` block owns the key and options, so if a fallback alias
            # answered, re-express it as jetson + HostName so every later call is
            # identical in shape.
            if ($alias -ne $script:JetsonAlias) {
                $addr = (& ssh -G $alias 2>$null | Select-String '^hostname ' | ForEach-Object { ($_ -split ' ', 2)[1] }) | Select-Object -First 1
                if ($addr) { Save-JetsonIp $addr; return (New-JetsonTarget -Ip $addr) }
            }
            Say "alias '$alias'"
            return $t
        }
    }

    Say 'aliases did not answer; sweeping the WiFi subnet for :22'
    $hits = @(Find-OpenSsh)
    if (-not $hits) { Say 'nothing on the local subnet answers on :22'; return $null }
    foreach ($h in $hits) {
        $t = New-JetsonTarget -Ip $h.Ip
        if ((Test-JetsonTarget $t -ConnectTimeout 5 -Probe).Ok) {
            Say "found at $($h.Ip) via $($h.Via)"
            Save-JetsonIp $h.Ip
            return $t
        }
        Say "$($h.Ip) has :22 open but is not the aircraft (key refused)"
    }
    return $null
}
