#!/usr/bin/env python3
"""Local rehearsal of the drone -> backend path, with nothing to install.

WHY THIS EXISTS. "Does it actually work, and are we ready for the drone?" is two
questions, and only the first one can be answered on a laptop. This answers it by
driving the REAL backend over HTTP with REAL captured payload, then reading every
artefact back and asserting on it.

WHAT IT PROVES
    * the API is up, the database is behind it, and the drone's key is accepted
      with the scopes an ingest actually needs;
    * every spooled record in the batch validates against the live Pydantic schema
      and is accepted (201), and the same record re-sent is a no-op (200 duplicate);
    * the frame upload lands on disk: the bytes the server serves back are
      BYTE-IDENTICAL to the bytes the drone sent, for two different detections;
    * mission resolution by name works, so a record that carries a stale mission_id
      from a previous flight still files itself correctly;
    * position telemetry round-trips and /latest reports it as live.

WHAT IT DOES NOT PROVE - say this out loud rather than implying otherwise
    * no TensorRT engine is loaded. `best_512x288.engine` is on the aircraft, not
      here, and this script never touches the detector at all.
    * no CSI/GStreamer capture, no MAVLink GPS, no aircraft link, no power or
      thermal behaviour. Inference quality is entirely unexamined.
    * it is the PLUMBING gate, not the model gate.

WHY IT DOES NOT CALL jetson/uplink.py --replay
    Three reasons, any one sufficient:
      1. `replay_spool()` DELETES each spool file it successfully sends. Pointing
         it at `drone-data/aeroshield/jetson/spool/` would destroy the committed
         flight corpus. This script instead copies into a temp dir and asserts the
         source directory is unchanged afterwards.
      2. it needs `requests`, which is not installed in this repo's interpreters.
      3. it does not verify what landed. A 2xx from a stub is not evidence.

STDLIB ONLY, ON PURPOSE: urllib + json + uuid. Nothing here needs numpy, OpenCV or
a venv, so this runs on any Python 3 in the repo and in CI.

TWO KEYS, NOT ONE. Writing and reading are separate scopes and the drone key only
has the write half - `detections:read` is denied to it deliberately, so a
compromised aircraft cannot enumerate or download the evidence. This script
therefore takes an ingest key AND a read key, and asserts that the ingest key is
still refused a read. Trying to do the whole thing with one key produces a wall of
403s that look like broken endpoints but are the authorization model working.

    export AEROSHIELD_API_KEY=aero_...        # drone:ingest, missions:write
    export AEROSHIELD_READ_KEY=aero_...       # detections:read
    export AEROSHIELD_ADMIN_KEY=aero_...      # admin, for the cleanup step
    python scripts/rehearse_local.py
    python scripts/rehearse_local.py --dry-run          # offline schema check only

Exits 0 on all-pass, 1 on any failure, 2 on a usage problem. Rows are deleted from
the backend at the end unless --keep, so repeated runs do not accumulate.
"""

import argparse
import json
import os
import shutil
import ssl
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Fixed choices, deliberately not configurable per run
# ---------------------------------------------------------------------------

# A rehearsal mission must never be confusable with the committed flight corpus,
# whose records say `kmit-01`. Bench rows filed under the flight's name would
# pollute the mission picker on demo day and, worse, would look like measured
# data in a report.
DEFAULT_MISSION = "rehearsal-local"

# The mission and provenance stamp for everything this script writes. `source`
# is what a human reads on the dashboard when wondering where a row came from.
REHEARSAL_SOURCE = "rehearsal"

# What an ingest key has to be able to do. Checked via /api/auth/me before the
# first write: a key missing `drone:ingest` produces a 403 that the drone's own
# uplink classifies as FATAL and quarantines, which looks like a data problem
# from the aircraft side. Fail here instead, with the reason.
DRONE_SCOPES = ("drone:ingest", "missions:write")

# Reading the results back is a separate job with a separate scope. The drone key
# cannot do it, on purpose: a compromised aircraft should not be able to enumerate
# or download the evidence it and its peers submitted.
READ_SCOPE = "detections:read"

# uuid5 namespace so a given spool record maps to the same client_detection_id on
# every run. That is what makes a second run report zero new rows instead of
# doubling the table - the idempotency claim is then actually tested rather than
# assumed. --fresh-ids opts out.
REHEARSAL_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "aeroshield.rehearsal")

# Fields copied from a spool record into the ingest body. An explicit allow-list
# rather than "send the file as-is", because the file carries two things that must
# NOT be forwarded verbatim:
#   * `mission_id` - it WINS over mission_name in the resolver and 404s if that id
#     belongs to a different database, which is exactly the case here.
#   * `source`     - rewritten so bench rows are identifiable.
INGEST_FIELDS = (
    "class_name",
    "class_id",
    "confidence",
    "bbox_x1",
    "bbox_y1",
    "bbox_x2",
    "bbox_y2",
    "latitude",
    "longitude",
    "altitude_m",
    "relative_altitude_m",
    "heading_deg",
    "gps_fix_type",
    "satellites_visible",
    "horizontal_error_m",
    "frame_width",
    "frame_height",
    "inference_ms",
    "model_version",
)

_OMIT = object()
"""Sentinel for "do not send a key at all", distinct from None = "use the default"."""


# ---------------------------------------------------------------------------
# Minimal HTTP client
# ---------------------------------------------------------------------------


class Response(object):
    """A completed request, including failed ones.

    HTTPError is a response, not an exception, everywhere below: a 401 from a
    missing key is the single most likely outcome of running this script, and it
    should print a diagnosis, not a traceback.
    """

    def __init__(self, method, url, status, headers, body):
        self.method = method
        self.url = url
        self.status = status
        self.headers = headers
        self.body = body

    @property
    def ok(self):
        return 200 <= self.status < 300

    @property
    def content_type(self):
        for name, value in self.headers.items():
            if name.lower() == "content-type":
                return value or ""
        return ""

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except Exception:            # noqa: BLE001 - a non-JSON body is a finding
            return None

    def text(self, limit=300):
        try:
            return self.body.decode("utf-8", "replace")[:limit]
        except Exception:            # noqa: BLE001
            return "<undecodable>"

    def __str__(self):
        return "{0} {1} -> {2}".format(self.method, self.url, self.status)


class Client(object):
    """Just enough of a client to speak to this API, with no third-party code."""

    def __init__(self, base_url, api_key=None, timeout_s=30.0, insecure=False):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_s = timeout_s
        self._ssl_context = None
        if insecure:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            self._ssl_context = ctx

    def request(self, method, path, json_body=None, data=None, content_type=None,
                api_key=_OMIT, query=None):
        url = self.base_url + path
        if query:
            url = url + "?" + urllib.parse.urlencode(query)

        headers = {
            "Accept": "application/json",
            "User-Agent": "AeroShield-Rehearsal/1.0",
        }
        key = self.api_key if api_key is _OMIT else api_key
        if key:
            headers["X-API-Key"] = key

        body = None
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif data is not None:
            body = data
            headers["Content-Type"] = content_type or "application/octet-stream"

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s,
                                        context=self._ssl_context) as resp:
                return Response(method, url, resp.status, dict(resp.headers), resp.read())
        except urllib.error.HTTPError as exc:
            return Response(method, url, exc.code, dict(exc.headers or {}),
                            exc.read() or b"")
        except Exception as exc:     # noqa: BLE001 - connection refused, DNS, timeout
            reason = getattr(exc, "reason", exc)
            return Response(method, url, 0, {}, str(reason).encode("utf-8", "replace"))

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, **kwargs):
        return self.request("POST", path, **kwargs)

    def put(self, path, **kwargs):
        return self.request("PUT", path, **kwargs)

    def delete(self, path, **kwargs):
        return self.request("DELETE", path, **kwargs)


def build_multipart(field_name, filename, content_type, payload):
    """A one-part multipart/form-data body.

    FastAPI's `UploadFile = File(...)` only reads multipart, so this has to be
    hand-rolled to keep the script dependency-free. The boundary is random per
    call because a fixed one is a body-corruption bug waiting for the day a JPEG
    happens to contain it.
    """
    boundary = "----AeroShieldRehearsal{0}".format(uuid.uuid4().hex)
    head = (
        "--{b}\r\n"
        'Content-Disposition: form-data; name="{f}"; filename="{n}"\r\n'
        "Content-Type: {c}\r\n"
        "\r\n"
    ).format(b=boundary, f=field_name, n=filename, c=content_type)
    tail = "\r\n--{0}--\r\n".format(boundary)
    body = head.encode("utf-8") + payload + tail.encode("utf-8")
    return boundary, body


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


class Report(object):
    """PASS/FAIL/SKIP rows plus a final verdict. ASCII only: this has to render in
    a Windows console on cp1252 without turning into question marks."""

    def __init__(self):
        self.rows = []
        self.notes = []

    def check(self, name, ok, detail=""):
        self.rows.append(("PASS" if ok else "FAIL", name, detail))
        return ok

    def skip(self, name, detail=""):
        self.rows.append(("SKIP", name, detail))

    def note(self, text):
        self.notes.append(text)

    def counted(self, status):
        return len([r for r in self.rows if r[0] == status])

    @property
    def ok(self):
        return self.counted("FAIL") == 0

    def render(self):
        width = max([len(r[1]) for r in self.rows] + [10]) + 2
        for status, name, detail in self.rows:
            print("  [{0}] {1}{2}".format(status, name.ljust(width), detail))
        if self.notes:
            print("")
            for text in self.notes:
                print("  " + text)
        print("")
        print("  {0} passed, {1} failed, {2} skipped".format(
            self.counted("PASS"), self.counted("FAIL"), self.counted("SKIP")))


# ---------------------------------------------------------------------------
# The replay corpus
# ---------------------------------------------------------------------------


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def default_spool_dir():
    """The committed corpus of real captures, read-only.

    ~660 records, 647 of them with a matching JPEG. These were produced by the
    actual engine on the aircraft, which is why replaying them is meaningful: the
    field names, ranges and quirks are the ones the drone really emits.
    """
    return os.path.join(repo_root(), "drone-data", "aeroshield", "jetson", "spool")


def parse_captured_at(value):
    """Parse the drone's ISO-8601 timestamp, tolerating a trailing Z.

    `datetime.fromisoformat` only learned to accept 'Z' in 3.11, and the spool
    files were written with it, so normalise here rather than assume a version.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.endswith("Z"):
        # Only the Z is replaced. Slicing more than one character here would
        # silently drop the fractional seconds, and detections ordered by a
        # second-truncated captured_at collapse into ties that sort arbitrarily.
        text = text[:-1] + "+00:00"
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp


def format_captured_at(stamp):
    """Millisecond-precision UTC with a Z, matching what the drone emits."""
    stamp = stamp.astimezone(timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + "{0:03d}Z".format(stamp.microsecond // 1000)


def validate_locally(record):
    """Check a spool record against the ingest schema's own constraints.

    This is a deliberate duplicate of rules that live in
    `backend/app/schemas/detection_io.py`, and it earns its keep: a 422 is a FATAL
    status on the drone side, so a record that trips a validator here would, in
    the air, be quarantined to `spool/rejected/` and lost. Catching it on the
    bench - and naming the field - is the whole point.

    Returns None if the record is replayable, else a short reason string.
    """
    for name in ("class_name", "class_id", "confidence"):
        if name not in record:
            return "missing required field '{0}'".format(name)
    if not isinstance(record.get("class_name"), str) or not record["class_name"]:
        return "class_name must be a non-empty string"
    confidence = record.get("confidence")
    if not isinstance(confidence, (int, float)) or not (0.0 <= confidence <= 1.0):
        return "confidence out of range: {0!r}".format(confidence)

    for lo, hi in (("bbox_x1", "bbox_x2"), ("bbox_y1", "bbox_y2")):
        first = record.get(lo)
        second = record.get(hi)
        if not isinstance(first, int) or not isinstance(second, int):
            return "{0}/{1} must be integers".format(lo, hi)
        if first < 0 or second < 0:
            return "{0}/{1} must be non-negative".format(lo, hi)
        if second <= first:
            return "zero-area or inverted box: {0}={1} {2}={3}".format(lo, first, hi, second)

    lat, lon = record.get("latitude"), record.get("longitude")
    if (lat is None) != (lon is None):
        return "latitude present without longitude (or the reverse)"
    if lat is not None and not (-90.0 <= lat <= 90.0):
        return "latitude out of range: {0!r}".format(lat)
    if lon is not None and not (-180.0 <= lon <= 180.0):
        return "longitude out of range: {0!r}".format(lon)

    heading = record.get("heading_deg")
    if heading is not None and not (0.0 <= heading < 360.0):
        return "heading_deg out of range: {0!r}".format(heading)
    fix_type = record.get("gps_fix_type")
    if fix_type is not None and not (0 <= fix_type <= 8):
        return "gps_fix_type out of range: {0!r}".format(fix_type)
    satellites = record.get("satellites_visible")
    if satellites is not None and not (0 <= satellites <= 64):
        return "satellites_visible out of range: {0!r}".format(satellites)
    error_m = record.get("horizontal_error_m")
    if error_m is not None and error_m < 0:
        return "horizontal_error_m negative: {0!r}".format(error_m)

    for name in ("frame_width", "frame_height"):
        value = record.get(name)
        if value is not None and value < 1:
            return "{0} must be >= 1, got {1!r}".format(name, value)

    if parse_captured_at(record.get("captured_at")) is None:
        return "captured_at missing or unparsable: {0!r}".format(record.get("captured_at"))
    return None


class Pair(object):
    """One spool record with its frame, held in memory."""

    def __init__(self, stem, record, image, image_name):
        self.stem = stem
        self.record = record
        self.image = image
        self.image_name = image_name

    @property
    def has_position(self):
        return self.record.get("latitude") is not None


def sniff_image(payload):
    """Return (extension, mime) from magic bytes, mirroring the server's check.

    The server sniffs rather than trusting the header, so sending every frame as
    `image/jpeg` would fail for any PNG in the corpus with a message about the
    body not being a JPEG. Derive it from the bytes.
    """
    if payload.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    return "bin", "application/octet-stream"


def load_pairs(spool_dir, wanted, report):
    """Read up to `wanted` replayable (record, frame) pairs.

    Only files with a sibling JPEG are usable - a metadata row with no frame would
    pass ingest and then fail the image assertion, which would be reported as a
    backend bug when it is really a gap in the corpus. Records that fail local
    validation are skipped by name, not silently dropped.
    """
    if not os.path.isdir(spool_dir):
        report.check("source spool", False,
                     "no such directory: {0}".format(spool_dir))
        return []

    names = sorted(n for n in os.listdir(spool_dir) if n.endswith(".json"))
    pairs = []
    skipped_missing_image = 0
    skipped_invalid = []

    for name in names:
        if len(pairs) >= wanted:
            break
        stem = name[:-5]
        json_path = os.path.join(spool_dir, name)
        image_path = None
        for extension in ("jpg", "jpeg", "png"):
            candidate = os.path.join(spool_dir, stem + "." + extension)
            if os.path.isfile(candidate):
                image_path = candidate
                break
        if image_path is None:
            skipped_missing_image += 1
            continue

        try:
            with open(json_path, "r") as handle:
                record = json.load(handle)
        except Exception as exc:     # noqa: BLE001
            skipped_invalid.append((name, "unreadable: {0}".format(exc)))
            continue
        if not isinstance(record, dict):
            skipped_invalid.append((name, "not a JSON object"))
            continue

        reason = validate_locally(record)
        if reason is not None:
            skipped_invalid.append((name, reason))
            continue

        with open(image_path, "rb") as handle:
            image = handle.read()

        pairs.append(Pair(stem, record, image, os.path.basename(image_path)))

    detail = "{0} pair(s) from {1}".format(len(pairs), spool_dir)
    if skipped_missing_image:
        detail += ", {0} json(s) had no frame".format(skipped_missing_image)
    if skipped_invalid:
        detail += ", {0} rejected by local schema check".format(len(skipped_invalid))
    report.check("source spool", bool(pairs), detail)
    for name, reason in skipped_invalid[:5]:
        report.note("skipped {0}: {1}".format(name, reason))
    if len(skipped_invalid) > 5:
        report.note("... and {0} more invalid record(s)".format(len(skipped_invalid) - 5))
    return pairs


def build_ingest_body(pair, mission_name, client_id, captured_at):
    """The POST body, shaped exactly as `jetson/uplink.py` sends it.

    Allow-listed fields, mission_id deliberately absent (see INGEST_FIELDS), and
    the provenance stamp rewritten so these rows are identifiable as bench data.
    """
    body = {}
    for field in INGEST_FIELDS:
        if field in pair.record and pair.record[field] is not None:
            body[field] = pair.record[field]
    body["client_detection_id"] = str(client_id)
    body["mission_name"] = mission_name
    body["source"] = REHEARSAL_SOURCE
    body["captured_at"] = format_captured_at(captured_at)
    return body


# ---------------------------------------------------------------------------
# The rehearsal
# ---------------------------------------------------------------------------


def rehearse(client, reader, admin_client, args, report):
    # --- 1. liveness and readiness -----------------------------------------
    resp = client.get("/health", api_key=None)
    payload = resp.json() or {}
    ready = (resp.status == 200
             and payload.get("database") == "ok")
    report.check("health /health", ready,
                 "HTTP {0} status={1} database={2}".format(
                     resp.status, payload.get("status"), payload.get("database")))
    if not ready:
        report.note("health is not ok - is the API up and is the database behind it?")
        report.note("  docker compose up -d db ; cd backend && alembic upgrade head")
        report.note("  python -m uvicorn app.main:app --host 0.0.0.0 --port 8000")
        return

    # --- 2. the credential actually carries the ingest scopes --------------
    resp = client.get("/api/auth/me")
    principal = resp.json() or {}
    scopes = principal.get("scopes") or []
    missing = [s for s in DRONE_SCOPES if s not in scopes]
    report.check("auth drone key", resp.status == 200 and not missing,
                 "HTTP {0} name={1} scopes={2}{3}".format(
                     resp.status, principal.get("name"), ",".join(scopes) or "<none>",
                     "  missing: " + ",".join(missing) if missing else ""))
    if missing:
        report.note("mint an ingest key with:")
        report.note("  python backend/scripts/create_api_key.py --name rehearsal-drone "
                    "--preset drone")
        return

    # The drone key must NOT be able to read detections back - that separation is
    # enforced by the API and is the reason every read below uses a different
    # credential. Checking it explicitly turns "why is everything 403" into a
    # statement about the API working as designed.
    resp = client.get("/api/detections", query={"limit": 1})
    report.check("drone key cannot read detections", resp.status == 403,
                 "ingest key -> HTTP {0} (403 expected by design)".format(resp.status))

    # --- 3. a separate read credential --------------------------------------
    resp = reader.get("/api/auth/me")
    reader_principal = resp.json() or {}
    reader_scopes = reader_principal.get("scopes") or []
    report.check("auth read key", resp.status == 200
                 and READ_SCOPE in reader_scopes,
                 "HTTP {0} name={1} scopes={2}".format(
                     resp.status, reader_principal.get("name"),
                     ",".join(reader_scopes) or "<none>"))
    if resp.status != 200 or READ_SCOPE not in reader_scopes:
        report.note("the read-back half of this rehearsal needs a key with "
                    "'detections:read', which the drone key does not have (by design).")
        report.note("  mint one: python backend/scripts/create_api_key.py "
                    "--name rehearsal-read --preset dashboard")
        report.note("  then:     $env:AEROSHIELD_READ_KEY = '<that key>'")
        return

    # --- 4. mission get-or-create ------------------------------------------
    resp = client.post("/api/missions", json_body={"name": args.mission_name})
    mission = resp.json() or {}
    mission_id = mission.get("id")
    report.check("mission get-or-create", resp.status in (200, 201)
                 and isinstance(mission_id, int),
                 "HTTP {0} id={1} created={2}".format(
                     resp.status, mission_id, resp.status == 201))
    if not isinstance(mission_id, int):
        return

    # --- 4. ingest every record --------------------------------------------
    now = datetime.now(timezone.utc)
    newest = max(
        (parse_captured_at(p.record.get("captured_at")) for p in args.pairs),
        default=now,
    )
    # Shift the whole batch so its newest frame is ~now and the relative spacing is
    # preserved. Two reasons: the dashboard orders by captured_at descending, so
    # unshifted 2026 captures would sort above real flight data; and a batch whose
    # ages differ by seconds exercises the ordering rather than testing a constant.
    shift = now - newest

    accepted = []          # list of (pair, detection_id, was_duplicate)
    created = 0
    duplicates = 0
    first_failure = None
    for pair in args.pairs:
        captured_at = parse_captured_at(pair.record.get("captured_at")) + shift
        if args.fresh_ids:
            client_id = uuid.uuid4()
        else:
            client_id = uuid.uuid5(REHEARSAL_NAMESPACE, pair.stem)
        body = build_ingest_body(pair, args.mission_name, client_id, captured_at)

        resp = client.post("/api/detections", json_body=body)
        result = resp.json() or {}
        detection_id = result.get("id")
        if resp.status not in (200, 201) or not isinstance(detection_id, int):
            if first_failure is None:
                first_failure = (pair.stem, resp, body)
            continue
        if result.get("duplicate"):
            duplicates += 1
        else:
            created += 1
        accepted.append((pair, detection_id, bool(result.get("duplicate"))))

    total_attempted = len(args.pairs)
    accepted_ok = len(accepted) == total_attempted
    detail = "{0}/{1} accepted ({2} new, {3} duplicate)".format(
        len(accepted), total_attempted, created, duplicates)
    report.check("ingest detections", accepted_ok, detail)
    if not accepted_ok and first_failure is not None:
        stem, resp, body = first_failure
        report.note("first rejected record {0}: HTTP {1}".format(stem, resp.status))
        report.note("  sent: {0}".format(json.dumps(body, sort_keys=True)[:400]))
        report.note("  got : {0}".format(resp.text()))
        report.note("  a 422 here is the drone's own FATAL path - in the air this "
                    "record would be quarantined and lost.")
    if not accepted:
        return

    # --- 5. a replayed record must be a no-op, not a second row ------------
    first_pair, first_id, _ = accepted[0]
    replay_body = build_ingest_body(
        first_pair, args.mission_name,
        uuid.uuid5(REHEARSAL_NAMESPACE, first_pair.stem),
        parse_captured_at(first_pair.record.get("captured_at")) + shift,
    )
    resp = client.post("/api/detections", json_body=replay_body)
    replay = resp.json() or {}
    report.check("ingest idempotency", resp.status == 200
                 and replay.get("duplicate") is True
                 and replay.get("id") == first_id,
                 "re-sent one record -> HTTP {0} duplicate={1} id={2} (was {3})".format(
                     resp.status, replay.get("duplicate"), replay.get("id"), first_id))
    if replay.get("id") != first_id:
        report.note("a replay produced a SECOND row - the drone draining its spool "
                    "after a link outage would inflate the mine count.")

    # --- 6. upload each frame, using the URL the server itself advertised --
    uploaded = {}
    uploaded_ok = 0
    first_upload_failure = None
    for pair, detection_id, _ in accepted:
        extension, mime = sniff_image(pair.image)
        boundary, body = build_multipart("image", "frame." + extension, mime, pair.image)
        # The path comes from the ingest response, not from string-formatting it
        # here: that checks the contract the drone's uplink actually follows.
        path = "/api/detections/{0}/image".format(detection_id)
        resp = client.put(path, data=body,
                          content_type="multipart/form-data; boundary=" + boundary)
        payload = resp.json() or {}
        if resp.ok and payload.get("image_path"):
            uploaded[detection_id] = pair
            uploaded_ok += 1
        elif first_upload_failure is None:
            first_upload_failure = (detection_id, resp)
    report.check("upload frames", uploaded_ok == len(accepted),
                 "{0}/{1} stored".format(uploaded_ok, len(accepted)))
    if first_upload_failure is not None:
        detection_id, resp = first_upload_failure
        report.note("upload for detection {0}: HTTP {1} {2}".format(
            detection_id, resp.status, resp.text()))
    if not uploaded:
        return

    # --- 7. telemetry, so /latest has something to be live about -----------
    telemetry_ok = 0
    positioned = [a for a in accepted if a[0].has_position] or accepted
    for index in range(3):
        source_pair = positioned[min(index, len(positioned) - 1)][0]
        frame = {
            "latitude": source_pair.record["latitude"],
            "longitude": source_pair.record["longitude"],
            "altitude_m": source_pair.record.get("altitude_m"),
            "relative_altitude_m": source_pair.record.get("relative_altitude_m"),
            "heading_deg": source_pair.record.get("heading_deg"),
            "ground_speed_ms": 3.2,
            "gps_fix_type": source_pair.record.get("gps_fix_type"),
            "satellites_visible": source_pair.record.get("satellites_visible"),
            "battery_pct": 87,
            "battery_volts": 22.4,
            "link_pct": 94,
            "flight_mode": "MANUAL",
            "armed": True,
            "captured_at": format_captured_at(now + timedelta(seconds=index)),
        }
        resp = client.post("/api/missions/{0}/telemetry".format(mission_id),
                           json_body=frame)
        if resp.status == 201:
            telemetry_ok += 1
    report.check("ingest telemetry", telemetry_ok == 3,
                 "{0}/3 position frames stored".format(telemetry_ok))

    # Reads use `reader`, never `client`. The ingest key is scoped to write only,
    # so a read through it is a 403 by design and would be read as a failure of
    # the very endpoint this rehearsal exists to test.
    resp = reader.get("/api/missions/{0}/telemetry/latest".format(mission_id))
    latest = resp.json() or {}
    frame = latest.get("telemetry") or {}
    age = latest.get("age_s")
    report.check("telemetry /latest", resp.status == 200
                 and latest.get("found") is True
                 and latest.get("live") is True,
                 "HTTP {0} found={1} live={2} age_s={3}".format(
                     resp.status, latest.get("found"), latest.get("live"), age))
    report.check("telemetry position", isinstance(frame.get("latitude"), float)
                 and isinstance(frame.get("longitude"), float),
                 "lat={0} lon={1} fix={2} sats={3}".format(
                     frame.get("latitude"), frame.get("longitude"),
                     frame.get("gps_fix_type"), frame.get("satellites_visible")))

    resp = reader.get("/api/missions/{0}/telemetry".format(mission_id),
                      query={"limit": 50})
    track = resp.json() or {}
    frames = track.get("items") if isinstance(track, dict) else None
    count = len(frames) if isinstance(frames, list) else 0
    # `count` is the server's own tally of what it put in `items`, so a mismatch
    # means the envelope and the list disagree - worth catching, not just reading
    # the length.
    agrees = isinstance(track, dict) and track.get("count") == count
    report.check("telemetry track", resp.status == 200 and count >= 3 and agrees,
                 "HTTP {0} {1} frame(s), server count={2}, oldest first".format(
                     resp.status, count, track.get("count") if isinstance(track, dict) else None))

    # --- 8. read the detections back ---------------------------------------
    resp = reader.get("/api/detections",
                      query={"mission_id": mission_id, "limit": 100})
    page = resp.json() or {}
    items = page.get("items") or []
    by_client_id = {}
    for item in items:
        by_client_id[str(item.get("client_detection_id"))] = item

    expected_ids = set(str(uuid.uuid5(REHEARSAL_NAMESPACE, p.stem))
                       for p, _, _ in accepted) if not args.fresh_ids else None
    if expected_ids is not None:
        missing = expected_ids - set(by_client_id.keys())
        found_all = not missing
    else:
        found_all = len(items) >= len(accepted)
    report.check("read-back list", resp.status == 200 and found_all,
                 "HTTP {0} total={1} returned={2}{3}".format(
                     resp.status, page.get("total"), len(items),
                     "" if found_all else "  MISSING {0}".format(
                         len(expected_ids or []) - len(by_client_id))))

    # Mission resolution: the source records carry mission_id 1 from a different
    # database entry, and it is stripped before sending. If the resolver ignored
    # mission_name the rows would be unassigned or mis-filed, and the dashboard
    # would silently show nothing for this mission.
    filed = [i for i in items
             if (i.get("mission") or {}).get("name") == args.mission_name]
    report.check("mission resolution", len(filed) >= len(accepted),
                 "{0}/{1} rows filed under '{2}'".format(
                     len(filed), len(accepted), args.mission_name))

    # Position survived the round trip and stayed inside a sane band.
    geotagged = [i for i in items if i.get("latitude") is not None]
    in_band = [i for i in geotagged
               if -90.0 <= i["latitude"] <= 90.0 and -180.0 <= i["longitude"] <= 180.0]
    report.check("position round-trip", len(geotagged) == len(items) == len(accepted),
                 "{0}/{1} rows geotagged, {2} within bounds".format(
                     len(geotagged), len(items), len(in_band)))

    # horizontal_error_m is what drives the uncertainty circle instead of a
    # false-precision pin, so losing it silently is a correctness problem for the
    # map, not a cosmetic one. Only asserted for records that actually carried it.
    carried = [p for p, _, _ in accepted if p.record.get("horizontal_error_m") is not None]
    if carried:
        preserved = [i for i in items if i.get("horizontal_error_m") is not None]
        report.check("horizontal_error_m", len(preserved) >= len(carried),
                     "{0}/{1} rows kept their 1-sigma error".format(
                         len(preserved), len(carried)))
    else:
        report.skip("horizontal_error_m", "no source record carried the field")

    image_paths = [i for i in items if i.get("image_path")]
    report.check("image_path recorded", len(image_paths) >= len(uploaded),
                 "{0} row(s) reference a stored frame".format(len(image_paths)))

    # --- 9. the frames on disk are the frames that were sent ---------------
    checks = list(uploaded.items())[:2]
    fetched = []
    for detection_id, pair in checks:
        resp = reader.get("/api/detections/{0}/image".format(detection_id))
        fetched.append((detection_id, pair, resp))

    first = fetched[0]
    _, pair, resp = first
    report.check("image read-back", resp.ok
                 and resp.content_type.startswith("image/")
                 and len(resp.body) > 1024,
                 "HTTP {0} type={1} bytes={2}".format(
                     resp.status, resp.content_type.split(";")[0], len(resp.body)))

    # Byte-identical to what was sent. A size check alone would pass for a stub
    # that returns any file of the right size.
    report.check("image bytes intact", resp.body == pair.image,
                 "served {0} bytes, sent {1} bytes, identical={2}".format(
                     len(resp.body), len(pair.image), resp.body == pair.image))

    if len(fetched) > 1:
        _, other_pair, other_resp = fetched[1]
        distinct = (other_resp.ok and other_resp.body != resp.body)
        report.check("images are distinct", distinct,
                     "two detections returned different bytes={0}".format(distinct))
        report.check("second image intact", other_resp.body == other_pair.image,
                     "served {0} bytes, sent {1}".format(
                         len(other_resp.body), len(other_pair.image)))

    # --- 10. cleanup ------------------------------------------------------
    if args.keep:
        report.skip("cleanup", "--keep: {0} row(s) left under '{1}'".format(
            len(accepted), args.mission_name))
        report.note("remove them later with: DELETE /api/detections/{id} (admin scope)")
        return

    if not admin_client or not admin_client.api_key:
        report.skip("cleanup", "no admin key (set $AEROSHIELD_ADMIN_KEY or --admin-key)")
        report.note("delete needs 'admin': the drone's ingest key deliberately cannot "
                    "remove evidence.")
        report.note("rows left under mission '{0}': {1}".format(
            args.mission_name, len(accepted)))
        return

    deleted = 0
    failed = 0
    for _, detection_id, _ in accepted:
        resp = admin_client.delete("/api/detections/{0}".format(detection_id))
        if resp.ok:
            deleted += 1
        else:
            failed += 1
    report.check("cleanup", failed == 0,
                 "deleted {0}/{1} rehearsal row(s)".format(deleted, len(accepted)))
    if failed:
        report.note("the admin key may be missing the 'admin' scope, or those rows "
                    "were already gone.")

    resp = reader.get("/api/detections",
                      query={"mission_id": mission_id, "limit": 1})
    page = resp.json() or {}
    remaining = page.get("total")
    report.check("cleanup verified", remaining == 0,
                 "mission '{0}' now holds {1} detection(s)".format(
                     args.mission_name, remaining))

    # Telemetry has no delete endpoint: it is append-only by design, because a
    # track is evidence of where the aircraft was and an operator should not be
    # able to quietly erase the part of the record that disagrees with them.
    # So the rehearsal leaves its own telemetry behind by construction. Report the
    # count instead of implying a clean slate, and confine it to a mission name
    # that no real flight uses.
    #
    # The limit must be at least what the mission holds, because `count` reports
    # the frames RETURNED, not the frames stored. Asking with limit=1 and printing
    # `count` said "1 frame left" while the track in the same run reported 23 -
    # a number that is wrong in the reassuring direction, which is the worst kind
    # for a residual-data report. Ask for the maximum and let `count` be the
    # answer, and fall back to the returned length if the field is missing.
    resp = reader.get("/api/missions/{0}/telemetry".format(mission_id),
                      query={"limit": 5000})
    track = resp.json() or {}
    leftover = None
    if isinstance(track, dict):
        leftover = track.get("count")
        if leftover is None:
            items = track.get("items") or []
            leftover = len(items) if isinstance(items, list) else None
    if leftover:
        report.note("{0} telemetry frame(s) left under '{1}' - append-only, no "
                    "delete endpoint by design.".format(leftover, args.mission_name))
        report.note("  harmless: they belong to the rehearsal mission, not a flight.")
        report.note("  to clear them, drop the mission in psql: "
                    "DELETE FROM telemetry WHERE mission_id = {0};".format(mission_id))


def snapshot(directory):
    """Names and sizes in a directory, for a before/after comparison.

    Used to prove the committed flight corpus is untouched. `replay_spool()`
    unlinks its input on success, so this is the assertion standing between a
    rehearsal and a destroyed dataset.
    """
    entries = {}
    try:
        for name in sorted(os.listdir(directory)):
            path = os.path.join(directory, name)
            if os.path.isfile(path):
                entries[name] = os.path.getsize(path)
            elif os.path.isdir(path):
                entries[name + "/"] = -1
    except OSError:
        return None
    return entries


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Rehearse the drone -> backend path locally and assert on it.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--backend-url", default="http://127.0.0.1:8000",
                        help="Where the API is. Must be reachable from this machine.")
    parser.add_argument("--api-key", default=os.environ.get("AEROSHIELD_API_KEY"),
                        help="Ingest key. Needs drone:ingest and missions:write. "
                             "Defaults to $AEROSHIELD_API_KEY.")
    parser.add_argument("--read-key",
                        default=os.environ.get("AEROSHIELD_READ_KEY")
                        or os.environ.get("VITE_DASHBOARD_KEY"),
                        help="Read key. Needs detections:read; the drone key cannot "
                             "read back by design. Defaults to $AEROSHIELD_READ_KEY, "
                             "then $VITE_DASHBOARD_KEY.")
    parser.add_argument("--admin-key", default=os.environ.get("AEROSHIELD_ADMIN_KEY"),
                        help="Admin key, used only to delete the rehearsal rows at the "
                             "end. Defaults to $AEROSHIELD_ADMIN_KEY. Without it the "
                             "rows are left in place and reported.")
    parser.add_argument("--source-spool", default=default_spool_dir(),
                        help="Corpus of <uuid>.json + <uuid>.jpg pairs. Read-only; "
                             "everything is copied into a temp dir first.")
    parser.add_argument("--count", type=int, default=8,
                        help="How many records to replay.")
    parser.add_argument("--mission-name", default=DEFAULT_MISSION,
                        help="Rehearsal mission. Never point this at a real flight.")
    parser.add_argument("--keep", action="store_true",
                        help="Leave the detections in place instead of deleting them.")
    parser.add_argument("--fresh-ids", action="store_true",
                        help="Random client_detection_id per run, so a rerun creates "
                             "new rows. Default is deterministic ids, which is what "
                             "makes a rerun a no-op and proves the idempotency claim.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Load and validate the corpus, print what would be sent, "
                             "and touch no network.")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification. Only for a self-signed bench host.")
    args = parser.parse_args(argv)

    if args.count < 1:
        print("ERROR: --count must be at least 1", file=sys.stderr)
        return 2

    report = Report()
    print("")
    print("  AeroShield local rehearsal")
    print("  backend  : {0}".format(args.backend_url))
    print("  mission  : {0}".format(args.mission_name))
    print("  corpus   : {0}".format(args.source_spool))
    print("  records  : {0}".format(args.count))
    print("")

    # Snapshot before touching anything. This is the guard against replay_spool's
    # delete-on-success behaviour reaching the committed corpus.
    before = snapshot(args.source_spool)

    pairs = load_pairs(args.source_spool, args.count, report)
    if not pairs:
        report.render()
        print("")
        print("  REHEARSAL ABORTED - no replayable records")
        return 1
    args.pairs = pairs
    report.note("loaded {0} record(s); {1} geotagged".format(
        len(pairs), len([p for p in pairs if p.has_position])))

    if args.dry_run:
        print("  --dry-run: validating the corpus only, no network")
        print("")
        sample = pairs[0]
        body = build_ingest_body(
            sample, args.mission_name,
            uuid.uuid5(REHEARSAL_NAMESPACE, sample.stem),
            parse_captured_at(sample.record.get("captured_at")),
        )
        print("  sample ingest body ({0}):".format(sample.image_name))
        print("    " + json.dumps(body, indent=2, sort_keys=True).replace("\n", "\n    "))
        print("")
        report.render()
        after = snapshot(args.source_spool)
        intact = before == after
        print("  [PASS] source corpus untouched" if intact
              else "  [FAIL] source corpus CHANGED during a dry run")
        print("")
        print("  DRY RUN OK" if report.ok and intact else "  DRY RUN FOUND PROBLEMS")
        return 0 if (report.ok and intact) else 1

    if not args.api_key:
        print("  FAIL: no --api-key and no $AEROSHIELD_API_KEY", file=sys.stderr)
        print("", file=sys.stderr)
        print("  mint one with:", file=sys.stderr)
        print("    python backend/scripts/create_api_key.py --name rehearsal-drone "
              "--preset drone", file=sys.stderr)
        return 2

    if not args.read_key:
        print("  FAIL: no read key and no $AEROSHIELD_READ_KEY", file=sys.stderr)
        print("", file=sys.stderr)
        print("  The drone key cannot read detections back - that separation is",
              file=sys.stderr)
        print("  enforced by the API and is not a bug. Mint a reader:", file=sys.stderr)
        print("    python backend/scripts/create_api_key.py --name rehearsal-read "
              "--preset dashboard", file=sys.stderr)
        print("    $env:AEROSHIELD_READ_KEY = '<that key>'", file=sys.stderr)
        return 2

    client = Client(args.backend_url, api_key=args.api_key, insecure=args.insecure)
    reader = Client(args.backend_url, api_key=args.read_key, insecure=args.insecure)
    admin_client = None
    if args.admin_key:
        admin_client = Client(args.backend_url, api_key=args.admin_key,
                              insecure=args.insecure)

    # A temp dir exists so that anything this script does to "spool files" happens
    # to copies. Nothing is written to the source corpus at any point.
    workdir = tempfile.mkdtemp(prefix="aeroshield-rehearsal-")
    try:
        for pair in pairs:
            json_path = os.path.join(workdir, pair.stem + ".json")
            image_path = os.path.join(workdir, pair.image_name)
            with open(json_path, "w") as handle:
                json.dump(pair.record, handle)
            with open(image_path, "wb") as handle:
                handle.write(pair.image)
        report.note("working copy in {0} (deleted on exit)".format(workdir))

        rehearse(client, reader, admin_client, args, report)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    # The assertion that matters most if this script is ever "simplified" into
    # calling replay_spool(): the flight corpus must still be exactly as it was.
    after = snapshot(args.source_spool)
    report.check("source corpus untouched", before == after,
                 "{0} entries before, {1} after".format(
                     len(before or {}), len(after or {})))
    if before != after:
        report.note("THE COMMITTED FLIGHT CORPUS CHANGED. Restore it from git:")
        report.note("  git checkout -- drone-data/aeroshield/jetson/spool")

    report.render()
    print("")
    if report.ok:
        print("  REHEARSAL PASSED - the ingest, storage and telemetry path works.")
        print("  Not proven here: the model, the camera, the GPS or the aircraft link.")
        return 0
    print("  REHEARSAL FAILED - see the FAIL row(s) above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())