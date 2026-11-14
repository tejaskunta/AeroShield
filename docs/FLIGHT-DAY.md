# Flight day

One page. Print it. Work top to bottom and do not skip to the exciting part.

The software is proven: 102 frontend tests, 90 backend, a full local rehearsal at
24/24, and a clean production build. What is **not** proven by any of that is
anything involving the aircraft — the model's accuracy, TensorRT, the CSI camera,
MAVLink, the radio link, power and thermals. Prove those on the bench in the order
below, or discover them in front of your audience.

---

## 0. The night before

- [ ] **Batteries on charge.** Flight pack *and* the Jetson supply. A Jetson Nano
      that browning out mid-demo reboots and takes ~60 s to come back, and the
      detector will have exited.
- [ ] **Engine file copied to the aircraft.** `weights/best_512x288.engine` is
      gitignored, so no code sync has ever sent it. Step 6 of the check will tell
      you if it is missing, but finding out now costs you a bench run instead of a
      demo:
      ```
      scp weights/best_512x288.engine jetson:~/aeroshield/weights/
      ```
- [ ] **Free the laptop.** Close everything that syncs or indexes. A Vite rebuild
      competing with a file watcher on a 4 GB laptop is a stutter during the one
      run that matters.
- [ ] **Do a full dress rehearsal.** Battery power, not mains:

      ```
      .\scripts\flightcheck.ps1 -Go
      ```

      Then open the dashboard and confirm you see detections land. If this fails,
      everything below is a smaller problem than the one you already have.

---

## 1. Power the aircraft

- [ ] Jetson on a supply rated **>4 A at 5 V**, via the **barrel jack**. USB power
      is the single most common cause of the failures the check reports as
      `under-voltage`, and it presents as flaky software rather than as a power
      fault.
- [ ] Watch the Jetson's LEDs. A reset loop means brownout — fix the supply before
      touching any code.
- [ ] Pixhawk on `/dev/ttyACM0` if you want MAVLink. CSI camera ribbon seated at
      **both** ends — the camera end is the one that works loose.

## 2. Network

The laptop and the drone must be able to see each other. This machine is on
`192.168.0.x`; the aircraft's static address is `10.11.101.241`. Those are
different subnets, so the link is broken until you do one of:

- [ ] Put both on the **same access point** (simplest, and what the demo should
      use), **or**
- [ ] Join the drone's own WiFi and drop the laptop onto its subnet, **or**
- [ ] Put both on Tailscale and update the `jetson-ts` block in `~/.ssh/config` —
      it currently points at the `100.64.0.0` placeholder and will not connect.

Confirm before moving on:

```powershell
ssh jetson 'hostname; ip -4 addr show | grep inet'
```

- [ ] **Note the aircraft's IP.** You will need it if mDNS is flaky on the venue
      network — which it usually is. `.\scripts\find_jetson.ps1` prints candidates.

## 3. The tunnel — do not skip this

The drone's `.env` points at `http://127.0.0.1:8000`, which is **the drone's own
loopback**, reached through an SSH reverse tunnel. That is deliberate: the drone
posts to itself and the tunnel carries it to the backend here. It is not the
laptop's LAN address and changing it to one is the classic mistake.

- [ ] Start the backend, bound to all interfaces:

      ```
      cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir . --host 0.0.0.0 --port 8000
      ```

      `--host 0.0.0.0` matters. uvicorn's default binds `127.0.0.1` only, which
      the tunnel cannot reach.

- [ ] Open the tunnel in its **own window and leave it open**:

      ```
      ssh -N -R 8000:127.0.0.1:8000 jetson
      ```

      The `Host jetson` block in `~/.ssh/config` already declares this
      `RemoteForward`, so a plain `ssh jetson` also establishes it — but `-N`
      gives you a window you will not accidentally close mid-flight.

- [ ] Confirm from the aircraft's side, not yours:

      ```
      ssh jetson 'curl -fsS --max-time 5 http://127.0.0.1:8000/health'
      ```

      You want `"database":"ok"`. A timeout here means **every detection will
      spool to the aircraft's offline queue** and the dashboard will stay empty
      while the drone reports success in its own log. This is the failure mode
      most likely to embarrass you, because nothing visibly errors.

## 4. Run the check

```powershell
.\scripts\flightcheck.ps1
```

- [ ] All seven steps pass. Read the `fix` line on anything that does not; it is
      written for the specific failure rather than as a generic error.

## 5. Start the dashboard

- [ ] `cd frontend; npm run dev` → <http://localhost:5173>
- [ ] `/missions` shows **`kmit-01`** as an active mission.

      It is pre-created (id 97). If it is missing, the dashboard silently shows
      the simulator instead of your flight — the trap `AGENTS.md` warns about.
      `VITE_MISSION_NAME` in `frontend/.env.local` must stay exactly `kmit-01`,
      matching the `--mission-name` you launch the drone with.

- [ ] The console says **Simulated**. It should — there is no live telemetry yet.
      It flips to **Live** on the drone's first post. That transition *is* your
      green light.

## 6. Launch

```powershell
.\scripts\flightcheck.ps1 -Go
```

Add `-Serial` if the inference probe reports `inferred 0`. A wedged CUDA context
does not raise — the detector exits cleanly having inferred nothing, which reads
exactly like a working detector that found no mines. `-Serial` runs inference on
the thread that owns the context and isolates it.

- [ ] Dashboard flips **Simulated → Live**.
- [ ] The map draws a track and the detection count rises above zero.
- [ ] Leave `scripts/drone_watchdog.sh` running if you want auto-restart on crash.

## 7. During the demo

- [ ] **Say "simulated" only if you are showing simulated data.** The console
      already labels itself; do not contradict it.
- [ ] The map's own copy is careful for a reason: *"Surveyed means imaged from the
      air, not cleared."* Do not upgrade that in speech. Cells imaged are not cells
      cleared, and an audience that knows the domain will notice.
- [ ] If the camera drops to **No signal**, that is the aircraft, not the
      dashboard — the panel degrades honestly and **Retry** reconnects. Do not
      debug React.
- [ ] If detections stop but the drone is flying, check the tunnel first. `ssh
      jetson 'tail -5 ~/aeroshield/logs/detections.jsonl'` — if rows are appearing
      there but not on the map, the tunnel is down, and the aircraft is queueing
      them for you to replay later.

## 8. After

- [ ] Do **not** sync `logs/` or `spool/` back from the aircraft and do not push
      either to it. `logs/detections.jsonl` is the append-only flight record and
      `spool/` is the offline queue. Overwriting either destroys the only honest
      account of what the aircraft actually saw.
- [ ] Pull the log somewhere safe before the laptop sleeps:

      ```
      scp jetson:~/aeroshield/logs/detections.jsonl .\logs\flown-$(Get-Date -Format yyyyMMdd-HHmm).jsonl
      ```

---

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| Step 3 fails, all hosts | Drone off, on another subnet, or rfkill | Power; then `.\scripts\find_jetson.ps1`; `sudo rfkill unblock all` |
| Step 4 fails | Reverse tunnel not open | `ssh -N -R 8000:127.0.0.1:8000 jetson` |
| Engine missing | Never `scp`'d; weight files are gitignored | `scp weights/best_512x288.engine jetson:~/aeroshield/weights/` |
| `/dev/video0` missing | CSI ribbon | Reseat at **both** ends, reboot |
| `under-voltage`, USB disabled | 5 V supply | Barrel jack, >4 A. This is not a software fault |
| `inferred 0` | Wedged CUDA context | `-Serial` (`DECOUPLED=0`) |
| Drone logs rows, map empty | Tunnel down | Restart the tunnel; the aircraft spools and you can replay |
| Dashboard shows Simulator | `VITE_MISSION_NAME` ≠ drone's `--mission-name`, or mission absent | Make them identical; check `/missions` |

## What is still unproven

Being explicit, because a checklist that implies more confidence than you have is
worse than no checklist:

- Model accuracy on real ground, real light, real soil colour. The test suite
  proves the pipeline moves data; it proves nothing about whether the model is
  right.
- TensorRT on the actual engine file, under sustained load.
- Thermal behaviour past a few minutes of continuous inference.
- Radio range and dropouts.
- MAVLink GPS, unless you already ran `make deps-drone` once on this airframe.

Those are hardware facts. Only the hardware can supply them — which is why
section 0 exists and why the dress rehearsal is not optional.