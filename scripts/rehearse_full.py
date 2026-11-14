#!/usr/bin/env python3
"""End-to-end rehearsal: run the REAL detector, then audit everything it produced.

WHY THIS EXISTS, AND HOW IT DIFFERS FROM rehearse_local.py
`rehearse_local.py` is the plumbing gate. It starts at the HTTP boundary: it
POSTs records the aircraft already produced and reads them back. That catches a
broken route, a schema drift, a storage regression - and it tells you nothing
about `jetson/live_detect.py`, because that code never runs. The upload worked;
the code that decides *what* to upload was not involved.

This gate runs the real thing. `jetson/live_detect.py` is launched as a
subprocess exactly as `make go` would, with `--detector mock` (no weights exist
here), reading real captures assembled into a clip by `rehearse_convert.py`,
against the real backend. Then it audits the artefacts the run left behind:

    detections.jsonl   every row well-formed, geotagged, and uploaded: yes
    frames saved       each one decodes and is not a blank frame
    the spool          empty afterwards - nothing quietly left unsent
    the API            the detections the run reported are actually retrievable

WHAT A PASS MEANS
The capture loop, the detector interface, the box-hold dedupe, the geotag
maths, the JSONL flight record, the uplink (including its retry and spool
behaviour), and the telemetry beacon all ran together and agreed with each other.
That is the largest unit of this system a laptop can exercise without the
aircraft, and it is a genuinely different claim from `rehearse_local.py`.

WHAT A PASS STILL DOES NOT MEAN
`--detector mock` invents boxes on a schedule. So: nothing here is evidence about
the model, accuracy, TensorRT, the CSI camera, MAVLink GPS, radio range, power or
thermals. Those need the aircraft. The rehearsal proves the ship is wired; it
cannot tell you whether the lookout can see.

WHY THE UPLINK HAS TO BE ASSERTED AND NOT ASSUMED
`--log-dir` and the spool live on different paths. A run can log 20 rows locally,
spool or fail every upload, and still print a tidy summary - the rows exist, they
just never left. So every row is checked for `uploaded: "yes"` and the spool
directory is checked to be empty. `spooled` in the summary would otherwise be a
number nobody reads.

USAGE
    .venv-rehearsal/Scripts/python scripts/rehearse_full.py

Exits 0 on all-pass, 1 on any failed check, 2 on a usage/environment problem.
Creates its mission-suffixed rows under `rehearsal-local` and deletes them unless
`--keep`, using the admin key, exactly like the plumbing gate.
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# Reuse the plumbing gate's HTTP client and report rather than growing a second,
# subtly different copy of either. The report's PASS/FAIL/SKIP vocabulary is the
# contract both scripts print, and the client already handles the "connection
# refused" case as a result instead of an exception.
from rehearse_local import Client, Report, repo_root  # noqa: E402

DEFAULT_MISSION = "rehearsal-local"
DEFAULT_BACKEND = "http://127.0.0.1:8000"

# The interpreter that has OpenCV, numpy and requests. Deliberately not
# `backend/.venv`: the API's environment must not grow a video stack, and mixing
# the two would make an API dependency problem look like a detector problem.
DEFAULT_PY = os.path.join(REPO, ".venv-rehearsal", "Scripts", "python.exe")


def which_python(explicit):
    """Pick the interpreter to run the detector with, and say why if not."""
    for candidate in [explicit, DEFAULT_PY, sys.executable]:
        if candidate and os.path.isfile(candidate):
            return candidate
    return sys.executable


def require_module(python, module, report, remedy):
    """Check a module is importable by `python`; record a FAIL with the fix."""
    try:
        proc = subprocess.run(
            [python, "-c", "import " + module],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        report.check("{0} importable".format(module), False, str(exc)[:80])
        report.note(remedy)
        return False
    ok = proc.returncode == 0
    report.check("{0} importable".format(module), ok,
                 "" if ok else proc.stderr.decode("utf-8", "replace").strip().splitlines()[-1][:90])
    if not ok:
        report.note(remedy)
    return ok


def build_clip(python, spool, out_path, limit, fps, report):
    """Assemble the AVI from real captures. Returns frame count, or 0 on failure."""
    cmd = [
        python, os.path.join(HERE, "rehearse_convert.py"),
        "--spool", spool, "--out", out_path,
        "--limit", str(limit), "--fps", str(fps), "--quiet",
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    except (OSError, subprocess.SubprocessError) as exc:
        report.check("build clip", False, str(exc)[:90])
        return 0
    if proc.returncode != 0:
        detail = (proc.stderr.decode("utf-8", "replace").strip().splitlines() or [""])[-1]
        report.check("build clip", False, detail[:90])
        return 0

    # Count what actually landed in the container rather than trusting the echo:
    # a writer that silently truncated would otherwise be reported as success.
    try:
        import cv2
        cap = cv2.VideoCapture(out_path)
        count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
    except Exception:            # noqa: BLE001 - driver/compiled-library noise
        count = -1
    if count <= 0:
        report.check("build clip", False, "clip has no decodable frames")
        return 0
    report.check("build clip", True, "{0} frame(s) of real captures".format(count))
    return count


def run_detector(python, args, clip, log_dir, frames_dir, spool_dir, report):
    """Launch jetson/live_detect.py exactly as the Makefile would. Returns (rc, out)."""
    cmd = [
        python, os.path.join(REPO, "jetson", "live_detect.py"),
        "--detector", "mock",
        "--source", clip,
        "--headless",
        "--realtime",
        "--gps", "sim",
        "--max-frames", str(args.max_frames),
        "--log-dir", log_dir,
        "--save-frames", frames_dir,
        # Redirect the offline queue into the scratch dir. Without this the run
        # writes into the aircraft's real spool, and anything left there is
        # replayed later as though it had been measured in flight.
        "--spool-dir", spool_dir,
        "--backend-url", args.backend_url,
        "--mission-name", args.mission_name,
        "--mock-every-n", str(args.mock_every_n),
        "--telemetry-hz", "2",
        "--quiet",
    ]
    if args.api_key:
        cmd.extend(["--api-key", args.api_key])

    started = time.time()
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=args.timeout)
    except subprocess.TimeoutExpired:
        report.check("detector run", False,
                     "timed out after {0}s - is --realtime pacing too slow?".format(args.timeout))
        return 1, ""
    except (OSError, subprocess.SubprocessError) as exc:
        report.check("detector run", False, str(exc)[:90])
        return 1, ""

    took = time.time() - started
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")
    ok = proc.returncode == 0
    report.check("detector run", ok,
                 "exit {0} in {1:.1f}s".format(proc.returncode, took))
    if not ok:
        tail = (err.strip() or out.strip()).splitlines()[-6:]
        for line in tail:
            report.note("  " + line[:110])
    return proc.returncode, out + err


def read_log(log_dir, report):
    """Parse detections.jsonl. Returns list of dicts; reports a FAIL if unusable."""
    path = os.path.join(log_dir, "detections.jsonl")
    if not os.path.isfile(path):
        report.check("detections.jsonl written", False, "no file at " + path)
        return []
    rows = []
    bad = 0
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                bad += 1
    report.check("detections.jsonl parses", bad == 0 and bool(rows),
                 "{0} row(s), {1} malformed".format(len(rows), bad))
    return rows


def audit_rows(rows, report):
    """Every claim the flight record makes, checked one row at a time."""

    # The single most important field. `uploaded` is written after the uplink
    # reports what happened to the record, so a row present locally with
    # `spooled` means the detection exists on the aircraft and nowhere else -
    # which is exactly the failure that looks like success in a summary.
    uploaded = [r for r in rows if str(r.get("uploaded", "")).lower() == "yes"]
    spooled = [r for r in rows if str(r.get("uploaded", "")).lower() == "spooled"]
    report.check("every row uploaded", len(uploaded) == len(rows) and not spooled,
                 "{0}/{1} uploaded, {2} spooled".format(len(uploaded), len(rows), len(spooled)))

    # A detection without a position cannot be put on a map, and the geotag is
    # derived rather than received, so it is the part most likely to be broken
    # by an unrelated change to the camera intrinsics or the fix plumbing.
    geotagged = [r for r in rows
                 if isinstance(r.get("latitude"), (int, float))
                 and isinstance(r.get("longitude"), (int, float))]
    report.check("every row geotagged", len(geotagged) == len(rows),
                 "{0}/{1} carry a position".format(len(geotagged), len(rows)))

    in_bounds = [
        r for r in geotagged
        if -90.0 <= r["latitude"] <= 90.0 and -180.0 <= r["longitude"] <= 180.0
        and not (abs(r["latitude"]) < 1e-9 and abs(r["longitude"]) < 1e-9)
    ]
    report.check("positions are plausible", len(in_bounds) == len(geotagged),
                 "{0}/{1} inside bounds and not at null island".format(
                     len(in_bounds), len(geotagged)))

    # The error budget is what turns a pin into an honest pin. A run where it is
    # null everywhere still looks fine on the map.
    with_error = [r for r in geotagged
                  if isinstance(r.get("horizontal_error_m"), (int, float))
                  and r["horizontal_error_m"] > 0]
    report.check("error budget present", len(with_error) == len(geotagged),
                 "{0}/{1} carry horizontal_error_m".format(len(with_error), len(geotagged)))

    # Confidence and class are what the ingest schema requires; a null here would
    # have been a 422 in flight. The box is four flat columns, not a nested list -
    # checked in that shape because that is what the flight record and the API
    # both actually emit, and asserting the shape I expected rather than the shape
    # that exists is how a gate starts failing for the wrong reason.
    def has_box(row):
        return all(isinstance(row.get(key), (int, float))
                   for key in ("bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2"))

    complete = [r for r in rows
                if r.get("class_name") and isinstance(r.get("confidence"), (int, float))
                and has_box(r)]
    report.check("rows are schema-complete", len(complete) == len(rows),
                 "{0}/{1} have class, confidence and a numeric box".format(
                     len(complete), len(rows)))

    # Timestamps must be ordered, because the flight record is read in order and a
    # clock that jumps backwards makes a spool replay unreadable.
    stamps = [r.get("captured_at") for r in rows if r.get("captured_at")]
    ordered = all(stamps[i] <= stamps[i + 1] for i in range(len(stamps) - 1))
    report.check("captured_at ordered", ordered and len(stamps) == len(rows),
                 "{0}/{1} stamped, monotonic={2}".format(len(stamps), len(rows), ordered))

    return len(uploaded)


def audit_frames(frames_dir, report):
    """Each saved frame must decode and must not be a blank rectangle."""
    paths = sorted(glob.glob(os.path.join(frames_dir, "*.jpg")))
    if not paths:
        report.check("annotated frames saved", False, "none in " + frames_dir)
        return 0
    report.check("annotated frames saved", True, "{0} file(s)".format(len(paths)))

    try:
        import cv2  # noqa: F401
        import numpy as np
    except ImportError as exc:
        report.skip("annotated frames decode", str(exc))
        return len(paths)

    decoded = 0
    uniform = 0
    for path in paths:
        img = cv2.imread(path)
        if img is None:
            continue
        decoded += 1
        # A frame that is one flat colour means capture or rendering failed while
        # still writing a file, so "a jpg exists" would be a false pass. Compare
        # against the standard deviation, not against a hash: two different real
        # frames legitimately differ, and a blank one is the thing to catch.
        if float(np.std(img)) < 1.0:
            uniform += 1
    report.check("annotated frames decode", decoded == len(paths),
                 "{0}/{1} decoded".format(decoded, len(paths)))
    report.check("frames are not blank", uniform == 0,
                 "{0} flat frame(s) of {1}".format(uniform, decoded))
    return decoded


def audit_spool(spool_dir, report):
    """The spool must be empty afterwards: an unsent row is a lost detection."""
    # The spool is a directory of one file per queued record, not a single
    # newline-delimited file, so count *.json - and count them by walking, so a
    # record left in `rejected/` is not silently skipped.
    if not os.path.isdir(spool_dir):
        report.skip("spool drained", "no spool dir at " + spool_dir)
        return
    pending = 0
    for root, _dirs, names in os.walk(spool_dir):
        pending += len([n for n in names if n.endswith(".json")])
    report.check("spool drained", pending == 0,
                 "{0} record(s) still waiting to be sent".format(pending))


def audit_api(reader, rows, args, report):
    """The rows the run says it uploaded must be retrievable through the API."""
    resp = reader.get("/api/missions", query={"name": args.mission_name})
    page = resp.json() or {}
    items = page.get("items") if isinstance(page, dict) else None
    if not isinstance(items, list) or not items:
        report.check("mission visible to a reader", False,
                     "GET /api/missions?name={0} -> HTTP {1}".format(
                         args.mission_name, resp.status))
        return
    mission = items[0]
    mission_id = mission.get("id")
    report.check("mission visible to a reader", mission_id is not None,
                 "'{0}' -> id={1}".format(args.mission_name, mission_id))
    if mission_id is None:
        return

    resp = reader.get("/api/detections", query={"mission_id": mission_id, "limit": 2000})
    listing = resp.json() or {}
    returned = listing.get("items") if isinstance(listing, dict) else None
    returned = returned if isinstance(returned, list) else []
    report.check("uploaded rows are retrievable", resp.status == 200 and len(returned) > 0,
                 "HTTP {0}, {1} row(s) on the mission".format(resp.status, len(returned)))
    if not returned:
        return

    # The mission is reused between runs, so its total is not this run's total.
    # Match on client_detection_id - the id the aircraft generated - which is the
    # only field that identifies the specific records this run produced. Comparing
    # raw counts would fail on the second run of the day for a reason that has
    # nothing to do with the code being tested.
    wanted = set(r.get("client_detection_id") for r in rows if r.get("client_detection_id"))
    found = set(r.get("client_detection_id") for r in returned)
    missing = wanted - found
    report.check("every uploaded row is on the backend", not missing,
                 "{0}/{1} matched by client_detection_id{2}".format(
                     len(wanted) - len(missing), len(wanted),
                     "" if not missing else "; missing " + ", ".join(
                         sorted(missing)[:3])))

    # Duplicates matter as much as losses: a double upload would double the pins
    # on the map, and the client id is what makes the ingest idempotent.
    mine = [r for r in returned if r.get("client_detection_id") in wanted]
    distinct = set(r.get("client_detection_id") for r in mine)
    report.check("no rows duplicated", len(mine) == len(distinct),
                 "{0} row(s) for {1} distinct id(s)".format(len(mine), len(distinct)))

    # A row that survived the round trip must still carry its position, or the pin
    # has no home. Compared against the sample from this run, not the newest row
    # on the mission, which could be from an earlier run.
    sample = mine[0] if mine else returned[0]
    has_position = isinstance(sample.get("latitude"), (int, float))
    report.check("API rows keep their position", has_position,
                 "lat={0} lon={1}".format(sample.get("latitude"),
                                          sample.get("longitude")))


def cleanup(admin_client, args, report):
    """Delete this run's detections. Missions have no DELETE route by design."""
    if not args.admin_key:
        report.skip("cleanup", "no admin key - rows left behind")
        return
    resp = admin_client.get("/api/missions", query={"name": args.mission_name})
    page = resp.json() or {}
    items = page.get("items") if isinstance(page, dict) else None
    if not isinstance(items, list) or not items:
        report.skip("cleanup", "mission not found")
        return
    mission_id = items[0].get("id")
    resp = admin_client.get("/api/detections",
                            query={"mission_id": mission_id, "limit": 500})
    listing = resp.json() or {}
    rows = listing.get("items") if isinstance(listing, dict) else None
    rows = rows if isinstance(rows, list) else []
    deleted = 0
    for row in rows:
        if admin_client.delete("/api/detections/{0}".format(row.get("id"))).status in (200, 204):
            deleted += 1
    report.check("cleanup", deleted == len(rows),
                 "deleted {0}/{1} row(s)".format(deleted, len(rows)))


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Run the real detector and audit what it produced.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--backend-url", default=os.environ.get("AEROSHIELD_BACKEND_URL") or DEFAULT_BACKEND)
    p.add_argument("--mission-name", default=DEFAULT_MISSION,
                   help="must not be the flight mission")
    p.add_argument("--api-key", default=os.environ.get("AEROSHIELD_API_KEY"),
                   help="drone:ingest key, for the run's uplink")
    p.add_argument("--read-key", default=os.environ.get("AEROSHIELD_READ_KEY"),
                   help="detections:read key, to verify what landed")
    p.add_argument("--admin-key", default=os.environ.get("AEROSHIELD_ADMIN_KEY"),
                   help="admin key, only to delete this run's rows")
    p.add_argument("--spool", default=os.path.join(REPO, "drone-data", "aeroshield",
                                                   "jetson", "spool"),
                   help="source of real captures")
    p.add_argument("--python", default=None,
                   help="interpreter with cv2/numpy/requests (default: .venv-rehearsal)")
    p.add_argument("--max-frames", type=int, default=120,
                   help="frames to run; at 30 fps this is 4 s of wall clock")
    p.add_argument("--clip-fps", type=float, default=30.0,
                   help="clip rate; with --realtime this sets the run's duration")
    p.add_argument("--mock-every-n", type=int, default=12,
                   help="mock detections every N frames")
    p.add_argument("--timeout", type=float, default=300.0)
    p.add_argument("--keep", action="store_true", help="leave the rows for the dashboard")
    args = p.parse_args(argv)

    python = which_python(args.python)
    report = Report()

    print("")
    print("  AeroShield full rehearsal")
    print("  backend  : {0}".format(args.backend_url))
    print("  mission  : {0}".format(args.mission_name))
    print("  python   : {0}".format(python))
    print("  frames   : {0} at {1:g} fps".format(args.max_frames, args.clip_fps))
    print("")

    # --- preconditions -----------------------------------------------------
    if args.mission_name == "kmit-01":
        print("  REFUSING: --mission-name is the flight mission. Bench rows must")
        print("  never be filed as measured data. Pick another name.")
        return 2
    if not os.path.isdir(args.spool):
        print("  REFUSING: no spool at {0}".format(args.spool))
        print("  The corpus is gitignored; this gate needs a machine that has flown.")
        return 2
    if not args.api_key or not args.read_key:
        print("  REFUSING: need AEROSHIELD_API_KEY (drone:ingest) and")
        print("  AEROSHIELD_READ_KEY (detections:read). See docs/RUNBOOK.md.")
        return 2

    client = Client(args.backend_url, args.api_key)
    reader = Client(args.backend_url, args.read_key)
    admin = Client(args.backend_url, args.admin_key) if args.admin_key else None

    # A failure here means nothing below can work, so stop before spawning a
    # subprocess that would fail in a more confusing way.
    health = client.get("/health")
    body = health.json() or {}
    if not report.check("health /health", health.status == 200,
                        "HTTP {0} status={1}".format(health.status, body.get("status"))):
        report.render()
        print("  FAILED before the detector ran - fix the backend first.")
        return 1

    if not require_module(python, "cv2", report,
                          "  remedy: py -3.11 -m venv .venv-rehearsal && "
                          ".venv-rehearsal/Scripts/python -m pip install "
                          "opencv-python-headless numpy requests"):
        report.render()
        return 1
    # `requests` is what the uplink and the beacon use; without it the run comes
    # back with every record spooled and the log still looks healthy.
    require_module(python, "requests", report, "  remedy: add requests to .venv-rehearsal")

    workdir = tempfile.mkdtemp(prefix="aeroshield-full-rehearsal-")
    log_dir = os.path.join(workdir, "logs")
    frames_dir = os.path.join(workdir, "frames")
    bench_spool = os.path.join(workdir, "spool")
    clip_path = os.path.join(workdir, "clip.avi")
    os.makedirs(log_dir)
    os.makedirs(frames_dir)
    os.makedirs(bench_spool)

    # If the run ever writes into the aircraft's real queue, the rehearsal has
    # contaminated flight data. Take a count before and after and fail loudly
    # rather than trusting that --spool-dir was honoured.
    aircraft_spool = os.path.join(REPO, "jetson", "spool")

    def count_files(path, suffix):
        if not os.path.isdir(path):
            return 0
        total = 0
        for _root, _dirs, names in os.walk(path):
            total += len([n for n in names if n.endswith(suffix)])
        return total

    spool_before = count_files(aircraft_spool, ".json")
    corpus_before = count_files(args.spool, ".jpg")

    try:
        if not build_clip(python, args.spool, clip_path, args.max_frames,
                          args.clip_fps, report):
            report.render()
            print("  could not build the clip; nothing was run.")
            return 1

        rc, _ = run_detector(python, args, clip_path, log_dir, frames_dir,
                             bench_spool, report)
        # The audit runs even on a non-zero exit: a run that crashed still has a
        # partial log, and what it managed to do before dying is the most useful
        # evidence available.
        rows = read_log(log_dir, report)
        if rows:
            audit_rows(rows, report)
            audit_api(reader, rows, args, report)
        else:
            report.skip("row audit", "no rows to audit")
            report.note("  if the run reported 0 detections, lower --mock-every-n")
        audit_frames(frames_dir, report)
        audit_spool(bench_spool, report)

        # The corpus and the flight record must be exactly as we found them.
        # `drone-data/aeroshield/jetson/spool` is the captured corpus this gate
        # reads from, and it must not be written to by a run.
        report.check("aircraft spool untouched",
                     count_files(aircraft_spool, ".json") == spool_before,
                     "{0} record(s) before, {1} after".format(
                         spool_before, count_files(aircraft_spool, ".json")))
        report.check("source corpus untouched",
                     count_files(args.spool, ".jpg") == corpus_before,
                     "{0} capture(s) before, {1} after".format(
                         corpus_before, count_files(args.spool, ".jpg")))

        if not args.keep and admin is not None:
            cleanup(admin, args, report)
        elif not args.keep:
            report.skip("cleanup", "no admin key - rows left behind")

        report.render()

        # The claim, stated once, so a reader does not over-read the result.
        print("  This ran the real capture -> detect -> geotag -> uplink -> log path.")
        print("  The detector was MOCK: no weights, no engine, no accuracy claim.")
        print("  Not proven: the model, the CSI camera, MAVLink GPS, the radio link,")
        print("  power or thermals. Those need the aircraft.")
        print("")
        if not report.ok:
            print("  FULL REHEARSAL FAILED")
            return 1
        print("  FULL REHEARSAL PASSED - the pipeline agrees with itself end to end.")
        return 0
    finally:
        if args.keep:
            print("  kept: {0}".format(workdir))
        else:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())