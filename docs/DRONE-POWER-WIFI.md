# Power, cable, WiFi, and the live feed

Everything here is about the aircraft, and it is ordered by how often it is the
actual cause of a "the software is broken" report. Work down it in order.

`make status` runs most of these checks automatically and prints one line each.
This document is the manual version, for when you want to see the raw numbers or
you are diagnosing something `make status` summarised away.

---

## 0. The short version

| Symptom | Real cause | Fix |
|---|---|---|
| Board drops off the network the moment inference starts | 5 V rail sags under TensorRT load | Barrel jack, supply ≥ 4 A |
| `ssh` works after a power cycle, `uptime` is small | The **system** rebooted, not a process | Same as above |
| `make status` step 6 fails with under-voltage / USB disable counts | Same | Same |
| `ssh` connects, `curl :8000/health` fails | Reverse tunnel is down | `make tunnel`, then `make doctor` |
| `curl :8080/stream` hangs or 404s | Detector not running, or `--stream-port` was not passed | `make stream` (not `make run`) |
| Live feed is a black frame | Camera enumerating but nothing publishing | `make status` step 6, check `/dev/video0` |
| Positions are 2–3 m off | GPS receiver, not the WiFi link | See §5. Nothing in software fixes this. |

---

## 1. Why the official cable cannot work

The Nano Developer Kit has two micro-USB ports and they are **not**
interchangeable:

| Port | What it is | Can it power the board? |
|---|---|---|
| J28 (micro-USB, next to HDMI) | Device-mode USB — serial console + `l4tbr0` networking | Only for bring-up. Current-limited to ~2 A and it disables itself on draw. |
| J25 (DC barrel jack) | The **input** | Yes. 5 V, 4 A recommended, 2 A absolute minimum with nothing on the USB bus. |
| J41 (40-pin header, pins 2/4) | 5 V *output* | No. Back-feeding here bypasses the input protection. |

TensorRT inference on this board is a burst load: the GPU clocks up and the rail
sags for tens of milliseconds. A supply that holds a multimeter at 5.0 V at idle
can still dip below the Nano's 4.75 V brownout threshold under that burst. The
board does not crash — the PMIC resets it, which is why the tell is `uptime`
going small rather than a traceback.

**The official micro-USB cable is a data cable.** Using it as the power input is
the single most common cause of "inference starts and the drone disappears."

### The tell

```sh
ssh jetson 'cut -d" " -f1 /proc/uptime'
```

Run it before `make stream` and again 60 s into a run. If it went *down*, the
system rebooted. That is a power bug, not a code bug. `docs/RUNBOOK.md`
("The 5V power problem") has the same test with the log-reading version.

The kernel logs the same event directly:

```sh
ssh jetson 'dmesg | grep -iE "under-voltage|soctherm: over current|OC ALARM|vdd-usb-vbus.*disabl" | tail -n 20'
```

Any output at all is a power event. `make status` counts these for you
(step 6, the `UV` / `USBOFF` keys in `logs/go/<stamp>/6-preflight.log`).

---

## 2. Power model

The board ships in `nvpmodel` mode 0 (MAXN) — every core unparked, maximum
clocks. `jetson/build_engine.sh` re-asserts it:

```sh
sudo nvpmodel -m 0
sudo jetson_clocks
```

That is correct **for building an engine** (you want the whole board) and it is
the worst case **for flight**, because MAXN is exactly when the rail sags.

### What is safe to run (read-only)

These change nothing. Run them any time, including mid-flight:

```sh
ssh jetson 'sudo nvpmodel -q --verbose'      # current mode and which cores are on
ssh jetson 'tegrastats --interval 1000'      # 1 Hz power/thermal, ctrl-c to stop
ssh jetson 'cat /sys/devices/system/cpu/cpu*/online'
```

`make power` wraps the first two.

In `tegrastats` the numbers that matter are:

| Field | Meaning | Watch for |
|---|---|---|
| `VDD_IN` | total board power, mW | Spiking toward the supply's rating |
| `VDD_GPU` / `VDD_CPU` | the two bursty rails | Jumping hard at model load |
| `GR3D_FREQ` | GPU utilisation | Going to 99% the instant inference begins — expected |
| `tj@` | junction temperature | Above ~85 °C the board clamps clocks |

Power at the wall is `VDD_IN` plus conversion loss; if `VDD_IN` peaks at 7–8 W,
a 5 V / 2 A (10 W) supply is already at its limit before the camera and WiFi
draw anything.

### What is NOT safe to run without approval

`AGENTS.md` forbids changing power mode, swap, JetPack/L4T, or system packages
without explicit approval. Changing `nvpmodel` is a decision about whether the
aircraft can meet its frame rate, so it is the pilot's call, not a tidy-up:

```sh
# 5 W mode: two CPU cores, GPU capped. Halves the rail's worst case.
sudo nvpmodel -m 1
sudo nvpmodel -q            # confirm

# back to MAXN when you need the frame rate for a benchmark
sudo nvpmodel -m 0
```

`nvpmodel -m 1` is a real trade: it makes brownout much less likely on a marginal
supply, and it makes the detector slower. If the choice is between a mode that
survives the flight and one that does not, the mode that survives wins — but
record which mode a flight was flown in, because a frame-rate claim from a 5 W
run is not a claim about a MAXN run.

### Order of fixes, cheapest first

1. **Barrel jack, ≥ 4 A supply.** This is the actual fix and it costs nothing in
   performance. `docs/RUNBOOK.md` says the same thing: *"Use the barrel jack, or
   a supply rated above 4A. Do not chase this in software."*
2. **Shorten/thicken the DC lead.** Voltage drop is `I × R`; a 1 m 22 AWG lead at
   2 A loses ~0.1 V before the board sees any of it.
3. **`nvpmodel -m 1`** — only if (1) and (2) are done and it still browns out.
4. **Remove USB loads.** The WiFi dongle draws from the 5 V bus. A powered hub
   moves that off the Nano's regulator.

Do not do (3) as a substitute for (1). A 5 W mode on a sagging rail still sags
during the GPU burst.

---

## 3. WiFi

Two separate questions, and they fail differently:

* **Can this laptop reach the aircraft?** — SSH, and the reverse tunnel.
* **Can the aircraft reach the backend?** — the drone's `--backend-url`.

Both are gated by `make doctor`, which checks the second one *from the aircraft*,
because that is the direction that actually matters for telemetry.

```sh
# the aircraft's addresses, one per line
ssh jetson 'hostname -I'

# is the interface up, and where is it associated?
ssh jetson 'ip -4 -o addr show | grep -v " lo "'
ssh jetson 'iwgetid -r'                     # SSID, empty when not associated
ssh jetson 'nmcli -t -f DEVICE,STATE,CONNECTION dev status'

# is anything blocking the radio?
ssh jetson 'rfkill list'
```

`rfkill list` showing `blocked: yes` is a hard block — the radio is off and no
amount of retrying will associate. `make status` step 6 catches this and prints
the exact fix:

```sh
ssh -t jetson 'sudo rfkill unblock all'
```

### The dongle specifically

The Zebronics USB dongle enumerates as a second `wlan` interface. JetPack 4.6
ships `rtl8xxxu` and `rtl8192cu` in-tree, so it normally appears without any
driver work; if it does not, that is a kernel module question, not a `wlan0`
configuration one:

```sh
ssh jetson 'lsusb | grep -i -E "wireless|wlan|802.11|realtek|ralink"'
ssh jetson 'lsmod | grep -E "rtl|8821|8188"'
ssh jetson 'dmesg | grep -i -E "usb .*wlan|rtl8|cfg80211" | tail -n 20'
```

**Two interfaces at once is a routing problem, not a WiFi problem.** If `wlan0`
(onboard) and `wlan1` (dongle) are both up, the kernel picks a default route and
`hostname -I` lists both. The drone then posts to a `--backend-url` that may be
routed out of the wrong interface:

```sh
ssh jetson 'ip route get 10.11.101.1'       # which interface would carry it?
ssh jetson 'ip route show default'
```

If the default route is on the interface that is *not* on the laptop's network,
the payload will spool silently. `docs/RUNBOOK.md` and the `BACKEND_URL` comment
in the `Makefile` both describe this failure — TLS and the reverse tunnel are the
two supported ways around it.

### The reverse tunnel

On this laptop `make api` binds `0.0.0.0:8000`, but if LAN inbound is filtered
(the Makefile documents exactly that on macOS) the drone gets a reset, spools
every detection, and the dashboard stays empty while `/health` is green.

```sh
make tunnel          # drone:8000 -> laptop:127.0.0.1:8000, over the SSH you already have
make doctor          # this is the gate; do not skip it
```

Leave `make tunnel` running in its own terminal. It is the one thing that must be
up before `make stream` for telemetry to arrive.

---

## 4. The live feed

The MJPEG server is started by the detector, not by anything else:

```sh
# start detector WITH the stream (port 8080 by default)
make stream

# 'make run' does NOT pass --stream-port, so :8080 will not answer
```

`jetson/stream.py` serves two paths:

| Path | Content |
|---|---|
| `/` | a minimal HTML page with `<img src="/stream">` |
| `/stream` | `multipart/x-mixed-replace; boundary=frame`, latest JPEG only |

Verify from the laptop, in this order — each step rules out one layer:

```sh
# 1. is the port open at all?
ssh jetson 'ss -ltnp | grep 8080'

# 2. does it answer headers (do NOT let this hang; --max-time is required,
#    /stream never finishes on its own)
curl -sI --max-time 5 http://10.11.101.241:8080/ | head -n 5

# 3. one frame, actually decoded
curl -s --max-time 5 http://10.11.101.241:8080/stream -o /tmp/f.jpg
file /tmp/f.jpg          # must say "JPEG image data"
```

`make livecheck` runs 1–3 and reports each.

A JPEG of a few hundred bytes is a black or truncated frame; a real CSI frame at
`--stream-port 8080` is tens of kilobytes.

The dashboard reaches the stream through the Vite proxy (`/jetson/stream` →
`AEROSHIELD_JETSON_ORIGIN`, default `http://10.11.101.241:8080`). Both sides
must agree on the port:

```sh
# frontend/.env.local — leave VITE_JETSON_STREAM_URL empty to use the proxy,
# or set it to an absolute URL if you have a tunnel
VITE_JETSON_STREAM_URL=

# and the proxy target, if the aircraft's IP has moved
AEROSHIELD_JETSON_ORIGIN=http://10.11.101.241:8080
```

An empty `VITE_JETSON_STREAM_URL` is the normal configuration. It resolves to
`/jetson/stream`, the dev server proxies it, and the browser never needs to know
the aircraft's address — which is why a DHCP lease change only requires editing
the Vite env, not the frontend build.

---

## 5. Telemetry accuracy — what the link can and cannot fix

Recorded flight data from the archived spool, 13 Nov:

```json
{"latitude": 12.9720585, "longitude": 77.5946652, "altitude_m": 30.0,
 "heading_deg": 90.0, "gps_fix_type": 3, "satellites_visible": 14,
 "horizontal_error_m": 2.74}
```

`gps_fix_type: 3` is a 3D fix, 14 satellites, and the receiver's own estimated
horizontal error is **2.5–3 m**. That is normal for an M8N-class module and it
is the number that bounds the accuracy of every position on the map.

**Improving the radio does not improve this.** A better dongle, a closer laptop,
or a 5 GHz link changes latency and packet loss. It changes the *timestamp* of a
position, not its accuracy. Two independent limits:

| Limit | Bounds | Fix |
|---|---|---|
| GPS receiver | absolute position, ~2.5–3 m CEP | A better receiver, or RTK (see below) |
| Radio link | how *current* the position is | Better dongle / closer / tunnel |

The `horizontal_error_m` field in the payload is the receiver's own estimate.
Spool files from 10 Nov carry `latitude: null, gps_fix_type: null` — no fix at
all. Those rows are not "inaccurate", they are *unknown*, and the dashboard
correctly refuses to plot them (`toDetection` returns null for a null
coordinate rather than inventing `(0, 0)`).

### Can it ever be centimetre-accurate?

Only with **RTK**. Precision at that level comes from a fixed ground base
station plus a rover, and it needs hardware this aircraft does not have — an
RTK-capable module and a correction link (the onboard radio is not one). Nothing
in the software stack can recover centimetres from a 3 m fix; treating a 3 m
position as a 10 cm one would be the single most dangerous thing this dashboard
could do, which is why `positionErrorM` is carried through to the UI instead of
being hidden.

If a demo needs tighter than ~3 m, the honest options are: state the error bar,
or add RTK hardware. Re-broadcasting the same fix over a faster link is neither.

---

## 6. Order of operations for a flight

```sh
make status                 # 7 read-only checks; stop at the first FAIL
make power                  # nvpmodel mode + a 5 s tegrastats sample
make tunnel                 # in its own terminal — leave running
make api                    # in its own terminal — 0.0.0.0:8000
make doctor                 # gate: can the DRONE reach /health?
make stream GPS=mavlink     # detector + MJPEG on :8080
make livecheck              # port open, headers, one real JPEG
make watchdog-log           # after the flight: ran= vs uptime=
```

`make watchdog-log` is the post-flight check that matters most. From
`docs/RUNBOOK.md`:

```
2026-11-04 18:20:31 restart=3 exit=0 ran=812s uptime=815s (clean exit)
2026-11-04 18:35:02 restart=4 exit=1 ran=7s   uptime=9s   (crash)
```

`ran=7s` + `uptime=9s` means **the board rebooted** — the 5 V problem, not a
code bug. `ran=7s` + `uptime=90000s` means the process died and the system
stayed up, which is a real bug and `last:` has the reason.