# Flight day

One page. Print it. Work top to bottom and do not skip to the exciting part.

The software is proven: 102 frontend tests, 90 backend, a full local rehearsal at
24/24, and a clean production build. What is **not** proven by any of that is
anything involving the aircraft — the model's accuracy, TensorRT, the CSI camera,
MAVLink, the radio link, power and thermals. Prove those on the bench in the order
below, or discover them in front of your audience.

---

## Fast path

Once the one-time setup in §2 is done, this is the whole flight:

| # | Where | Command |
|---|---|---|
| 1 | phone | Hotspot on. Laptop joins it. Drone on the barrel jack; its dongle joins by itself. |
| 2 | terminal A | `docker compose up -d db` then `cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir . --host 0.0.0.0 --port 8000` |
| 3 | terminal B | `.\scripts\tunnel.ps1` — **leave it open** |
| 4 | terminal C | `cd frontend; npm.cmd run dev` → <http://localhost:5173/mission> |
| 5 | terminal D | `.\scripts\flightcheck.ps1 -Go` |
| 6 | browser | Rail flips **Simulated → Live**, the camera paints, detections land on the map. |

Fallbacks for step 5: `-Gps sim` if the GPS step fails, `-Serial` if the probe
reports `inferred 0`. Stop the detector with `.\scripts\flightcheck.ps1 -Stop`.

---

## 0. The night before

- [ ] **Batteries on charge.** Flight pack *and* the Jetson supply. A Jetson Nano
      that browns out mid-demo reboots and takes ~60 s to come back, and the
      detector will have exited.
- [ ] **Engine on the aircraft.** `weights/best_512x288.engine` is built *on the
      Nano* (an engine is not portable) and is gitignored, so no code sync sends it.
      Step 6 of the check fails if it is missing.
- [ ] **Free the laptop.** Close everything that syncs or indexes. A Vite rebuild
      competing with a file watcher on a 4 GB laptop is a stutter during the one
      run that matters.
- [ ] **Rehearse the feed path without the drone** (2 minutes):

      ```
      python scripts/dev_mjpeg.py          # stand-in camera on :8080
      cd frontend; npm.cmd run dev         # open /mission - the feed must paint
      ```

      The tunnel delivers the real feed to the same `127.0.0.1:8080`, so this is
      the browser half of flight day for real. Stop `dev_mjpeg.py` afterwards:
      the tunnel needs that port.
- [ ] **Prove a detection reaches the dashboard, without the drone** (1 minute).
      Mission → the flask button (right-hand controls) → choose any landmine photo →
      click the map where it should be → *Send through the pipeline*. It goes through
      the real backend path (row, stored photo, live socket), so a pin appearing proves
      backend, database, socket and map. From a terminal instead:

      ```
      python scripts\inject_detection.py --image mine.jpg --lat 17.39699 --lon 78.49076
      ```

      These are labelled **Test injection** everywhere and never counted as flown.
      Use a rehearsal mission name (`--mission rehearsal-local`) if you do not want
      them in the flight mission's record. The backend refuses this route unless
      `AEROSHIELD_ENV=development`.
- [ ] **Full dress rehearsal on battery power:** the fast path above, end to end.

---

## 1. Power the aircraft

- [ ] Jetson on a supply rated **>4 A at 5 V**, via the **barrel jack**. USB power
      is the single most common cause of the failures the check reports as
      `under-voltage`, and it presents as flaky software rather than as a power
      fault. The WiFi dongle sits on the same USB bus — a brownout takes the link
      down with it.
- [ ] Watch the Jetson's LEDs. A reset loop means brownout — fix the supply before
      touching any code.
- [ ] Pixhawk USB into the Jetson (`/dev/ttyACM0`). CSI camera ribbon seated at
      **both** ends — the camera end is the one that works loose.

## 2. Network — phone hotspot

The laptop and the drone's USB WiFi dongle both join **one phone hotspot**. It
works in an open field, needs no venue network, and nothing has to know the
drone's address: the scripts find it.

### One-time: join the drone's dongle to the hotspot

Do this once per hotspot, on the bench. You need a working link to the drone
first: the micro-USB cable (J28, the board appears at `192.168.55.1`), or the
campus network it is already on.

```powershell
ssh -o HostName=192.168.55.1 jetson      # over the micro-USB cable
```

Then, on the drone:

```sh
nmcli dev status                         # find the dongle's interface, e.g. wlan1
sudo nmcli dev wifi connect "<HOTSPOT-SSID>" password "<password>" ifname wlan1
sudo nmcli con mod "<HOTSPOT-SSID>" connection.autoconnect yes connection.autoconnect-priority 100
```

Type the password yourself; do not paste it into a script or a chat. This adds a
WiFi profile, nothing else — no package, power-mode or system change.

Keep the phone's hotspot on **2.4 GHz** if it offers the choice: most USB dongles
of this class are 2.4 GHz only and simply will not see a 5 GHz hotspot.

### Every flight: confirm

```powershell
.\scripts\flightcheck.ps1                # step 3 finds the drone and prints its SSID
```

Step 3 tries the ssh aliases, then the address that worked last time
(`logs/last_jetson_ip.txt`), then sweeps the hotspot's subnet for the drone's
SSH (~3 s). If the phone lists the drone among connected devices but the sweep
misses it, pass the address: `-JetsonIp <address>`.

## 3. The tunnel — do not skip this

One SSH connection carries everything:

| Forward | Carries |
|---|---|
| `-R 8000` drone loopback → laptop backend | detections and telemetry |
| `-L 8080` laptop loopback → drone stream | the live camera feed |

The drone's `.env` and `--backend-url` point at `http://127.0.0.1:8000`, **the
drone's own loopback**. That is deliberate: the drone posts to itself and the
tunnel carries it here. It is not the laptop's LAN address, and changing it to
one is the classic mistake. The dashboard reads the feed from `127.0.0.1:8080`
for the same reason — neither side ever needs the other's hotspot address.

- [ ] Start the backend bound to all interfaces (fast path step 2).
- [ ] Open the tunnel in its **own window and leave it open**:

      ```
      .\scripts\tunnel.ps1
      ```

      It finds the drone, holds the connection, and reconnects by itself if the
      hotspot drops (one timestamped line per drop). While it is down the drone
      spools detections and replays them when it is back.

- [ ] `flightcheck.ps1` step 4 confirms it **from the aircraft's side**. A failure
      there means every detection will spool and the dashboard will stay empty while
      the drone reports success in its own log. This is the failure mode most likely
      to embarrass you, because nothing visibly errors.

## 4. Run the check

```powershell
.\scripts\flightcheck.ps1
```

- [ ] Steps 1–7 pass (8 and 9 are skipped without `-Go`). Read the `fix` line on
      anything that does not; it is written for the specific failure.
- [ ] Step 7 is a **real 3D GPS fix** read off the Pixhawk. Outdoors with a clear
      sky a cold start can take a few minutes; indoors it will not lock. Without a
      fix every detection is logged with no position and the map, correctly,
      refuses to plot it.

## 5. Start the dashboard

- [ ] `cd frontend; npm.cmd run dev` → <http://localhost:5173/mission>
- [ ] `VITE_MISSION_NAME` in `frontend/.env.local` is exactly **`kmit-01`**,
      matching the `-Mission` flightcheck launches with (its default). If they
      disagree the dashboard silently shows the simulator instead of your flight.
- [ ] The console says **Simulated**. It should — there is no live telemetry yet.
      It flips to **Live** on the drone's first post. That transition *is* your
      green light.

## 6. Launch

```powershell
.\scripts\flightcheck.ps1 -Go
```

`-Go` re-runs the checks, deploys the code, stops any earlier detector, runs a
40-frame inference probe that **uploads nothing** (`--no-uplink`, its own log
dir — so bench frames can never replay as flown data), then launches the
detector under the watchdog with real GPS and the stream on, and waits until
camera frames arrive through the tunnel.

- [ ] Step 9 reports the feed live through the tunnel.
- [ ] Dashboard flips **Simulated → Live**, the camera paints.
- [ ] The map draws a track and the detection count rises above zero.

Variations:

| Flag | When |
|---|---|
| `-Gps sim` | No Pixhawk, no fix, or indoors. Real camera and detections, positions from the simulated survey track over the KMIT block. Say so out loud. |
| `-Serial` | The probe reports `inferred 0`. A wedged CUDA context does not raise; `-Serial` keeps inference on the thread that owns it. |
| `-NoDeploy` | Code on the drone is already current and you want a faster launch. |
| `-Stop` | End the flight: stops the detector and its watchdog. |

## 6b. One photo for the map (sharp z21–23)

No satellite service has real imagery past zoom 20 over the block. Esri, its
archive and Bing stop at z19 and Google at z20 (measured), so z22–23 over
satellite alone is a blurry stretch. The sharp view is a photo the drone takes
itself. Do this once per site, or whenever the ground changes:

- [ ] **Before take-off:** put a visible marker on each of the block's four
      corners (cone, tape cross, paper plate). SW is where the pilot stands
      (`VITE_SURVEY_ORIGIN`). For a measured check, put a fifth marker at the block
      **centre** (5 m, 5 m).
- [ ] Hover over the block centre at **15–20 m**, camera straight down, all four
      markers in frame.
- [ ] `.\scripts\flightcheck.ps1 -Snapshot`. This takes a full-resolution
      3264×2464 frame (about 0.7 cm/px from 20 m), pausing detection for a few
      seconds and relaunching it exactly as it was, and copies the photo to
      `logs\snapshots\`. It prints the next command.
- [ ] On the laptop, run the printed `python scripts\georef_overlay.py --image ... --click`,
      then click the SW, SE, NE and NW markers and press Enter. Add
      `--extra 5,5:X,Y` with the centre marker's pixel position for a real error figure.
- [ ] Reload the dashboard. **Layers → Drone photo · <date time>** is on, and the
      grid sits on the markers.

The photo is labelled with when it was taken. It is not a live picture; the
camera panel is the live picture.

## 7. During the demo

- [ ] **Say "simulated" only if you are showing simulated data.** The console
      already labels itself; do not contradict it.
- [ ] The map's own copy is careful for a reason: *"Surveyed means imaged from the
      air, not cleared."* Do not upgrade that in speech. Cells imaged are not cells
      cleared, and an audience that knows the domain will notice.
- [ ] If the camera drops to **No signal**, look at the tunnel window first. If it
      shows `tunnel DOWN`, it is already reconnecting; press **Retry** on the
      panel once it says `UP`. Do not debug React.
- [ ] If detections stop but the drone is flying, same place: the tunnel window.
      `ssh jetson 'tail -5 ~/aeroshield/logs/detections.jsonl'` — rows there but
      not on the map means the tunnel is down and the aircraft is queueing them.
- [ ] Check the class labels on the first real detections. `class1`/`class2`
      instead of a name means the engine has more classes than the launch's
      `--names landmine`; tell the team rather than guessing a mapping mid-demo.

## 8. After

- [ ] `.\scripts\flightcheck.ps1 -Stop`
- [ ] Do **not** sync `logs/` or `spool/` back from the aircraft and do not push
      either to it. `logs/detections.jsonl` is the append-only flight record and
      `spool/` is the offline queue. Overwriting either destroys the only honest
      account of what the aircraft actually saw.
- [ ] Pull the log somewhere safe before the laptop sleeps:

      ```
      scp jetson:aeroshield/logs/detections.jsonl .\logs\flown-$(Get-Date -Format yyyyMMdd-HHmm).jsonl
      ```

      (If `jetson` does not resolve, add `-o HostName=<address from logs\last_jetson_ip.txt>`.)

---

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| Step 3 fails | Drone off, dongle not on the hotspot, or rfkill | Power; check the phone's connected-devices list; `-JetsonIp <address>`; `sudo rfkill unblock all` |
| Step 3: "has :22 open but is not the aircraft" | Another device on the hotspot | Ignore; or pass `-JetsonIp` |
| Step 4 fails | Tunnel not running | `.\scripts\tunnel.ps1` in its own window |
| Tunnel exits within 5 s, every time | Port taken: `dev_mjpeg.py` on :8080, a second tunnel window, or the drone still holding :8000 from a dropped session | Stop `dev_mjpeg.py` / the other window; a stale drone-side forward clears within ~45 s |
| Engine missing | Never built on this Nano | `jetson/build_engine.sh` on the drone |
| `/dev/video0` missing | CSI ribbon | Reseat at **both** ends, reboot |
| `under-voltage`, USB disabled | 5 V supply | Barrel jack, >4 A. This is not a software fault |
| No API key | Drone `.env` empty | Mint with `--preset drone`, put it in `~/aeroshield/.env` |
| Flight controller not on `/dev/ttyACM0` | Pixhawk USB | Plug it in, or `-Gps sim` |
| No 3D fix | Indoors / cold start | Wait outdoors, or `-Gps sim` |
| `inferred 0` | Wedged CUDA context | `-Serial` |
| Step 9: no camera frames after 60 s | Detector crashed on start | `ssh jetson tail -n 40 ~/aeroshield/logs/detector.out` |
| Drone logs rows, map empty | Tunnel down | Watch the tunnel window; the aircraft spools and replays |
| Dashboard shows Simulator | `VITE_MISSION_NAME` ≠ `-Mission`, or no telemetry yet | Make them identical; wait for the first post |

## What is still unproven

Being explicit, because a checklist that implies more confidence than you have is
worse than no checklist:

- Model accuracy on real ground, real light, real soil colour. The test suite
  proves the pipeline moves data; it proves nothing about whether the model is
  right.
- TensorRT on the actual engine file, under sustained load.
- Thermal behaviour past a few minutes of continuous inference.
- Hotspot range and dropouts with the dongle in the air.
- The Windows flight path (`tunnel.ps1`, the new `flightcheck.ps1` steps 3–9)
  against the real aircraft. It was verified on this laptop up to "no drone
  found", and the feed path was verified with the stand-in camera — the drone
  itself was off.
