# find_jetson.ps1 — locate the AeroShield Jetson on whatever network this laptop
# is attached to, and report the address `ssh` should use.
#
# WHY THIS EXISTS
# ---------------
# docs/RUNBOOK.md step 3 fails more often for address reasons than for drone
# reasons: the aircraft's DHCP lease has moved between .241 and .102.1 and back,
# and mDNS only answers when both machines are on the same layer-2 segment. Every
# one of those cases looks identical from `make status` — "cannot SSH" — so the
# first job is to separate "wrong address" from "board is off".
#
# This script does NOT change any state. It only reports.
#
#   .\scripts\find_jetson.ps1              # candidates + mDNS
#   .\scripts\find_jetson.ps1 -Scan        # also sweep the local /24 for :22
#
# The sweep is a plain TCP-connect probe over the subnet, one connection per
# address, 200 ms timeout. That is enough to find an SSH daemon and quiet enough
# not to trip anything, but it is not a port scanner and should not be used as one.

[CmdletBinding()]
param(
    [switch]$Scan,
    [int]$TimeoutMs = 200
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Head($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# 1. What this laptop looks like on each network.
# ---------------------------------------------------------------------------
Write-Head 'Laptop addresses'
$local = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
$local | Select-Object IPAddress, PrefixLength, InterfaceAlias | Format-Table -AutoSize

if (-not $local) {
    Write-Warning 'No usable IPv4 address. Not on any network.'
    return
}

# ---------------------------------------------------------------------------
# 2. mDNS. Preferred, because it survives DHCP churn — see the ssh config.
# ---------------------------------------------------------------------------
Write-Head 'mDNS (preferred)'
foreach ($name in @('kmit-desktop.local', 'jetson.local')) {
    $r = Resolve-DnsName $name
    if ($r) {
        $r | Where-Object { $_.IPAddress } |
            ForEach-Object { Write-Host ("  {0} -> {1}" -f $name, $_.IPAddress) -ForegroundColor Green }
    }
    else {
        Write-Host ("  {0} -> no answer" -f $name) -ForegroundColor DarkGray
    }
}

# ---------------------------------------------------------------------------
# 3. Known static candidates.
# ---------------------------------------------------------------------------
Write-Head 'Known addresses'
$candidates = @(
    @{ addr = '10.11.101.241'; note = 'campus LAN (AGENTS.md)' }
    @{ addr = '10.11.102.1';   note = 'campus LAN (RUNBOOK, later lease)' }
)
foreach ($c in $candidates) {
    $open = Test-NetConnection -ComputerName $c.addr -Port 22 -InformationLevel Quiet -WarningAction SilentlyContinue
    $color = if ($open) { 'Green' } else { 'DarkGray' }
    Write-Host ("  {0,-16} :22 {1}  ({2})" -f $c.addr, $(if ($open) { 'OPEN  ' } else { 'closed' }), $c.note) -ForegroundColor $color
}

# ---------------------------------------------------------------------------
# 4. Optional sweep of the local subnet for an SSH daemon.
# ---------------------------------------------------------------------------
if ($Scan) {
    Write-Head 'Subnet sweep (port 22)'
    foreach ($iface in $local) {
        $parts = $iface.IPAddress -split '\.'
        if ($parts.Count -ne 4) { continue }
        $prefix = ($parts[0..2] -join '.')
        Write-Host ("  sweeping {0}.0/24 via {1} ..." -f $prefix, $iface.InterfaceAlias) -ForegroundColor DarkGray

        $found = @()
        foreach ($host in 1..254) {
            $ip = "$prefix.$host"
            $client = New-Object System.Net.Sockets.TcpClient
            try {
                $task = $client.ConnectAsync($ip, 22)
                if ($task.Wait($TimeoutMs) -and $client.Connected) { $found += $ip }
            }
            catch { }
            finally { $client.Dispose() }
        }

        if ($found) {
            # Banner-grab each hit: the Jetson's sshd identifies itself, so this
            # distinguishes the drone from a router or another laptop.
            foreach ($ip in $found) {
                $banner = ''
                try {
                    $t = New-Object System.Net.Sockets.TcpClient($ip, 22)
                    $s = $t.GetStream()
                    $s.ReadTimeout = 800
                    $buf = New-Object byte[] 64
                    $n = $s.Read($buf, 0, 64)
                    $banner = ([System.Text.Encoding]::ASCII.GetString($buf, 0, $n)).Trim()
                    $t.Dispose()
                }
                catch { }
                Write-Host ("  {0,-16} OPEN  {1}" -f $ip, $banner) -ForegroundColor Green
            }
        }
        else {
            Write-Host '  nothing answering on :22' -ForegroundColor DarkGray
        }
    }
}

# ---------------------------------------------------------------------------
# 5. What to do next.
# ---------------------------------------------------------------------------
Write-Head 'Next step'
Write-Host @'
  If an address answered above that is not already in ~/.ssh/config, either
  add it, or use it directly:

      ssh kmit@<address>

  First connection needs the key installed (once, at the drone):

      ssh-copy-id kmit@<address>          # from Git Bash / WSL
      # or, from PowerShell:
      type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh kmit@<address> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"

  Then the Make targets work as documented:

      make doctor        # gate; stop if this fails
      make status
'@ -ForegroundColor Gray

Write-Host "`n  No address at all? The board is off, rfkill-blocked, or on a different" -ForegroundColor Yellow
Write-Host "  network than this laptop. See docs/RUNBOOK.md 'If make status fails'." -ForegroundColor Yellow

# This script only reports; a failed probe is information, not an error. Exit 0
# so it composes in a pipeline without a false red failure.
exit 0
