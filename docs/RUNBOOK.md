# Aircraft Runbook

One command, one screen, one reason. If you are debugging a Jetson connection
at 2 a.m., read only the `FAIL` line, then the `fix` line under it.

```sh
make status     # read-only. Is everything up? Nothing is started or deployed.
make go         # start what is missing, deploy, then launch the detector
```

Both exit `0` if every step passed and `1` if anything failed. Neither will
ever leave you wondering whether it retried: there is exactly **one** SSH
attempt per run.

---

## Why this exists

Every past debugging session started with a dozen hand-typed `ssh` commands,
which is both slow and expensive in tokens. `make status` replaces the whole
sweep. It stops at the first thing that cannot work and names the fix.

The rule the tool enforces: **fail fast.** Four of the last five outages were
not software (powered off, hardware team on the board, brownout, out of range).
Sweeping for 5 minutes confirms nothing; one SSH attempt already knows.

---

## The seven steps

| # | Step | What a failure means |
|---|---|---|
| 1 | Postgres (:5432) | `make go` starts it; or `docker compose up -d db` |
| 2 | Backend `/health` + database | a 200 is not enough - it must say `"database":"ok"` |
| 3 | SSH to the aircraft | the drone is off, crashed, occupied, or out of range |
| 4 | Reverse tunnel drone→backend | `make tunnel`; the drone must reach `127.0.0.1:8000` |
| 5 | Deploy code | skipped with `--no-deploy`; `make deploy` otherwise |
| 6 | Pre-flight: camera, engine, thermals, brownout | a *fact* about the hardware |
| 7 | Inference probe (40 frames) | `inferred` must be ≥ 1, not 0 |

Steps 6 and 7 are the interesting ones. Everything before them is plumbing.

### Step 6 catches hardware that looks like a bug

- **Engine missing** - `weights/*.engine` is gitignored, so `make deploy` never
  sends it. `scp` it once per aircraft.
- **`/dev/video0` missing** - the CSI ribbon. Reseat it at **both** ends. This
  has been the cause twice; the camera does not need to be "broken" to vanish.
- **Under-voltage / USB bus disables** - read below.
- **rfkill-blocked WiFi** - `ssh -t jetson 'sudo rfkill unblock all'`.

If pre-flight fails, step 7 is **skipped** on purpose. A probe on a board with
no camera burns 90 s and prints a second, more confusing failure directly under
the real one.

### Step 7 catches the CUDA-context hang

The failure this whole tool was built for. A worker thread with no CUDA context
does not raise: `execute_async_v2` simply never returns. The detector exits
cleanly with no traceback and reports `inferred 0`, which reads exactly like a
working detector that found nothing.

Three outcomes, three meanings:

| Output | Meaning | Fix |
|---|---|---|
| `TIMED OUT after 90s` | the inference thread is wedged | `make go --serial` |
| `inferred 0` with frames captured | same bug, exited before the timeout | `make go --serial` |
| `inferred ≥ 1` | the pipeline works | ship it |

`make go --serial` runs inference on the thread that created the CUDA context
instead of a worker. It is slower (no capture/inference overlap) but it isolates
the bug. If serial works and decoupled does not, the problem is the handoff, not
the engine.

---

## The 5V power problem

The Nano browns out under TensorRT load on a weak supply. The symptoms, in the
order you will notice them:

1. The board drops off the network the moment inference starts.
2. `ssh` works again after a power cycle and `make status` passes.
3. **`uptime` resets to a small number.** This is the tell: the process did not
   crash, the *system* rebooted. Step 6 prints `up Ns` for exactly this reason,
   and `logs/watchdog.log` records an `uptime` per restart.

A crash under load is not a code bug. Use the barrel jack, or a supply rated
above 4A. Do not chase this in software.

---

## Command reference

```sh
make status              # check, change nothing
make go                  # start missing services, deploy, launch
make go --serial         # DECOUPLED=0 - workaround for the CUDA hang
make go --no-deploy      # skip the rsync (code already on the aircraft)
make go --no-stream      # no MJPEG stream
make probe-cuda          # which CUDA context strategy works on this board
make logs                # tail logs/detections.jsonl on the aircraft
make watchdog-log        # restart accounting
make stop-drone          # stop the watchdog, then the detector
```

Variables (all overridable on the command line): `MISSION`, `CONF`, `IMGSZ`,
`ENGINE`, `GPS=sim|mavlink`, `STREAM_PORT`, `DEDUPE_M`, `BOX_HOLD`,
`MAX_FRAMES`, `BACKEND_URL`.

---

## Where the logs are

| Path | What |
|---|---|
| `logs/go/<stamp>/` | one directory per run of `make status`/`make go` (laptop) |
| `logs/go/<stamp>/3-ssh.log` | the verbatim `ssh` error |
| `logs/go/<stamp>/6-preflight.log` | the key-value block from the aircraft |
| `logs/go/<stamp>/7-probe.log` | the inference probe, whole |
| `~/aeroshield/logs/detector.out` | detector stdout+stderr (aircraft) |
| `~/aeroshield/logs/watchdog.log` | one line per restart (aircraft) |
| `~/aeroshield/logs/detections.jsonl` | the flight record - append-only |

The terminal shows only the failing step's last 25 lines. Full output is always
on disk. `logs/` is gitignored.

### Reading `watchdog.log`

```
2026-11-04 18:20:31 restart=3 exit=0 ran=812s uptime=815s (clean exit) last: ...
2026-11-04 18:35:02 restart=4 exit=1 ran=7s   uptime=9s   (crash) last: Segmentation fault
```

- `ran=` is how long the detector lived; `uptime=` is the system's.
- `ran=812s` + clean exit = it ran fine and was stopped on purpose.
- `ran=7s` + `uptime=9s` = **the board rebooted.** 5V problem.
- `ran=7s` + `uptime=90000s` = the process died, the system stayed up. A real
  code bug, and `last:` has the reason.

---

## Things that are traps

- **`--max-frames` counts captured frames, not inferred ones.** In decoupled
  mode capture runs ~30 FPS and inference ~5 Hz, so a 5-frame probe stops before
  inference finishes once and reports `inferred 0` on a healthy board. The probe
  uses 40 for this reason.
- **`/tmp` is tmpfs on the Jetson** and is wiped on reboot. Anything that must
  survive lives in `~/aeroshield/bin/`. The watchdog is installed there.
- **`pip` for Python 3.6 is broken on this image.** Use `make deps-drone`.
- **The interpreter that matters is `/usr/bin/python3.6`.** `/usr/bin/python3`
  is 3.10 and has cv2 *without* GStreamer and no TensorRT. `import cv2` also
  needs `PYTHONPATH` set to the dist-packages path - both the Makefile and the
  watchdog do this, because without it the watchdog restarts in a tight loop
  that looks exactly like a broken detector.
- **`nohup` alone does not detach from the process group**, and sshd kills the
  group when the session ends. The launcher uses `setsid`.
- **`make stop-drone` before editing code**, or the watchdog relaunches the old
  version the moment you kill it.

---

## If `make status` fails at step 3

In order of how often it has actually happened:

1. **The drone is powered off** or its battery is flat.
2. **The hardware team is running their own code** on it.
3. **The board crashed** - see the 5V section. `uptime` will be small.
4. **Out of WiFi range**, or a new DHCP lease. `~/.ssh/config` uses
   `kmit-desktop.local` (mDNS) rather than a fixed IP for this reason; the lease
   has moved from `.241` to `.102.1` and back.

Check the physical LED before anything else. No amount of software will fix an
unplugged board.