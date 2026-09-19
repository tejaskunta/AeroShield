#!/usr/bin/env python3
"""
AeroShield - backend uplink with offline spooling (Week 4/5 boundary).

Ships geotagged detections from the drone to the FastAPI backend. This is PRD
section 8's "Jetson -> REST POST -> FastAPI" hop, and the "secure communication
between drone and server" line in the Week 5 brief.

Two design decisions worth stating, both driven by the radio link being unreliable:

1. METADATA AND IMAGE ARE SENT SEPARATELY.
       POST /api/detections            small JSON  - must never be lost
       PUT  /api/detections/{id}/image large JPEG  - nice to have, retried apart
   A detection whose photo never arrived is still a usable safety record. A photo
   with no detection row is useless. So they get different durability guarantees
   instead of being welded into one all-or-nothing multipart request.

2. NOTHING IS SENT ON THE INFERENCE THREAD.
   A background worker drains a bounded queue. If the queue is full or the POST
   fails, the record is spooled to disk and retried later. Inference never blocks
   on the network - a drone flying a grid cannot pause mid-frame waiting for a
   TCP timeout, and detections found while the link is down are the ones you most
   need to keep.

Idempotency: every record carries a client_detection_id (UUID) generated on the
drone. The backend treats a repeat as the same detection, so replaying a spool
after a dropped link cannot create duplicates.

Usage:
    from uplink import BackendUplink
    up = BackendUplink("http://127.0.0.1:8000", api_key="aero_...")
    up.start()
    mission_id = up.ensure_mission("field-test-1")
    up.submit(record_dict, image_bytes)      # returns immediately
    up.close()                               # drains, then spools what is left

PYTHON 3.6 ONLY - see the note at the top of infer_trt.py.
"""

import json
import os
import shutil
import sys
import threading
import time
import uuid
from typing import Dict, Optional, Tuple

try:
    import queue
except ImportError:                      # pragma: no cover - py2 safety net
    import Queue as queue                # type: ignore[no-redef]

DEFAULT_SPOOL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "spool")

# HTTP statuses that will never succeed on retry - spooling them forever just
# fills the disk. 401/403 = bad key, 422 = malformed record: both need a human.
FATAL_STATUSES = (400, 401, 403, 404, 422)


def new_client_id() -> str:
    """A fresh idempotency key for one detection."""
    return str(uuid.uuid4())


class UplinkStats(object):
    """Plain counters, read by the HUD and the end-of-run summary."""

    def __init__(self) -> None:
        self.sent = 0
        self.images_sent = 0
        self.failed = 0
        self.spooled = 0
        self.replayed = 0
        self.dropped_fatal = 0

    def __str__(self) -> str:
        return ("sent={0} images={1} spooled={2} replayed={3} failed={4} rejected={5}"
                .format(self.sent, self.images_sent, self.spooled,
                        self.replayed, self.failed, self.dropped_fatal))


class BackendUplink(object):
    """Queued, retrying, spooling HTTP client for the detections API."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        spool_dir: str = DEFAULT_SPOOL_DIR,
        queue_size: int = 256,
        timeout_s: float = 5.0,
        max_attempts: int = 3,
        backoff_base_s: float = 0.5,
        send_images: bool = True,
        verify_tls: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.spool_dir = spool_dir
        self.timeout_s = timeout_s
        self.max_attempts = max_attempts
        self.backoff_base_s = backoff_base_s
        self.send_images = send_images
        self.verify_tls = verify_tls

        self.stats = UplinkStats()

        self._queue = queue.Queue(maxsize=queue_size)
        self._thread = None      # type: Optional[threading.Thread]
        self._stop = threading.Event()
        self._session = None

        if not os.path.isdir(self.spool_dir):
            os.makedirs(self.spool_dir)

    # -- lifecycle ---------------------------------------------------------
    def _requests(self):
        try:
            import requests
        except ImportError:
            raise RuntimeError(
                "requests is not installed.\n"
                "    Nano : pip3 install -r jetson/requirements-nano.txt\n"
                "    Dev   : pip install requests"
            )
        return requests

    def start(self) -> None:
        requests = self._requests()
        self._session = requests.Session()
        if self.api_key:
            self._session.headers.update({"X-API-Key": self.api_key})
        self._session.headers.update({"User-Agent": "AeroShield-Jetson/1.0"})

        self._stop.clear()
        self._thread = threading.Thread(target=self._worker, name="uplink")
        self._thread.daemon = True
        self._thread.start()

    def close(self, drain_timeout_s: float = 5.0) -> None:
        """Stop the worker, then spool anything still queued rather than lose it."""
        deadline = time.time() + drain_timeout_s
        while not self._queue.empty() and time.time() < deadline:
            time.sleep(0.05)

        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

        # Whatever is left never reached the server - put it on disk.
        while True:
            try:
                record, image = self._queue.get_nowait()
            except queue.Empty:
                break
            self._spool(record, image)

        if self._session is not None:
            try:
                self._session.close()
            except Exception:       # noqa: BLE001
                pass

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False

    # -- public API --------------------------------------------------------
    def ensure_mission(self, name: str, description: Optional[str] = None) -> Optional[int]:
        """Get-or-create a mission by name, synchronously.

        Called once at startup, before the flight loop, so blocking here is fine -
        and we genuinely need the id before any detection can be filed. Returns
        None if the backend is unreachable; live_detect.py then runs in
        spool-only mode instead of refusing to fly.
        """
        if self._session is None:
            self.start()

        url = "{0}/api/missions".format(self.base_url)
        body = {"name": name}
        if description:
            body["description"] = description

        try:
            resp = self._session.post(url, json=body, timeout=self.timeout_s,
                                      verify=self.verify_tls)
        except Exception as exc:            # noqa: BLE001
            print("[uplink] mission registration failed ({0}); running in spool-only mode"
                  .format(exc), file=sys.stderr)
            return None

        if resp.status_code in FATAL_STATUSES:
            print("[uplink] mission registration rejected: HTTP {0} {1}"
                  .format(resp.status_code, resp.text[:200]), file=sys.stderr)
            return None
        if not (200 <= resp.status_code < 300):
            print("[uplink] mission registration returned HTTP {0}".format(resp.status_code),
                  file=sys.stderr)
            return None

        try:
            return int(resp.json()["id"])
        except Exception as exc:            # noqa: BLE001
            print("[uplink] could not read mission id: {0}".format(exc), file=sys.stderr)
            return None

    def submit(self, record: Dict, image: Optional[bytes] = None) -> None:
        """Enqueue one detection. Never blocks, never raises.

        On a full queue the record goes straight to the spool. Dropping it would
        mean losing a detection because the network was slow, which is the one
        outcome this whole module exists to prevent.
        """
        record.setdefault("client_detection_id", new_client_id())
        try:
            self._queue.put_nowait((record, image))
        except queue.Full:
            self._spool(record, image)

    def replay_spool(self, limit: int = 0) -> int:
        """Re-send everything on disk. Returns the number of records accepted.

        Run this at startup (link may have been down last flight) and after a
        reconnect. Safe to run repeatedly: the backend deduplicates on
        client_detection_id, so a half-finished replay does not create doubles.
        """
        if self._session is None:
            self.start()

        names = sorted(n for n in os.listdir(self.spool_dir) if n.endswith(".json"))
        if limit > 0:
            names = names[:limit]
        if not names:
            return 0

        print("[uplink] replaying {0} spooled record(s)".format(len(names)))
        ok = 0
        for name in names:
            json_path = os.path.join(self.spool_dir, name)
            image_path = json_path[:-5] + ".jpg"

            try:
                with open(json_path, "r") as fh:
                    record = json.load(fh)
            except Exception as exc:        # noqa: BLE001
                print("[uplink] unreadable spool file {0} ({1}); quarantining"
                      .format(name, exc), file=sys.stderr)
                self._quarantine(json_path)
                continue

            image = None
            if os.path.exists(image_path):
                try:
                    with open(image_path, "rb") as fh:
                        image = fh.read()
                except Exception:           # noqa: BLE001
                    image = None

            sent, fatal = self._send(record, image)
            if sent:
                ok += 1
                self.stats.replayed += 1
                self._unlink(json_path)
                self._unlink(image_path)
            elif fatal:
                # The server will never accept this. Keep it for inspection, but
                # get it out of the retry path.
                self._quarantine(json_path)
                self._quarantine(image_path)
            else:
                # Transient - leave it spooled and stop; the link is still down.
                break

        return ok

    def pending_spool_count(self) -> int:
        try:
            return len([n for n in os.listdir(self.spool_dir) if n.endswith(".json")])
        except OSError:
            return 0

    # -- internals ---------------------------------------------------------
    def _worker(self) -> None:
        while not self._stop.is_set():
            try:
                record, image = self._queue.get(timeout=0.25)
            except queue.Empty:
                continue

            sent, fatal = self._send(record, image)
            if not sent and not fatal:
                self._spool(record, image)

    def _send(self, record: Dict, image: Optional[bytes]) -> Tuple[bool, bool]:
        """POST one record, then PUT its image. Returns (sent, fatal)."""
        url = "{0}/api/detections".format(self.base_url)

        for attempt in range(1, self.max_attempts + 1):
            try:
                resp = self._session.post(url, json=record, timeout=self.timeout_s,
                                          verify=self.verify_tls)
            except Exception as exc:        # noqa: BLE001 - link down, host unknown, TLS, ...
                if attempt == self.max_attempts:
                    self.stats.failed += 1
                    print("[uplink] send failed after {0} attempts: {1}"
                          .format(attempt, exc), file=sys.stderr)
                    return False, False
                time.sleep(self.backoff_base_s * (2 ** (attempt - 1)))
                continue

            if resp.status_code in FATAL_STATUSES:
                self.stats.dropped_fatal += 1
                print("[uplink] backend rejected record: HTTP {0} {1}"
                      .format(resp.status_code, resp.text[:200]), file=sys.stderr)
                return False, True

            if 200 <= resp.status_code < 300:
                self.stats.sent += 1
                if image and self.send_images:
                    self._send_image(resp, image)
                return True, False

            # 5xx or anything else: retry, then spool.
            if attempt == self.max_attempts:
                self.stats.failed += 1
                print("[uplink] backend returned HTTP {0}; spooling"
                      .format(resp.status_code), file=sys.stderr)
                return False, False
            time.sleep(self.backoff_base_s * (2 ** (attempt - 1)))

        return False, False

    def _send_image(self, detection_response, image: bytes) -> None:
        """Attach the frame. Best-effort by design: the row already landed.

        A failure here is logged and dropped rather than spooled. Re-spooling the
        record would re-send metadata that is already stored, and the photo alone
        is not worth carrying a retry queue for.
        """
        try:
            detection_id = detection_response.json()["id"]
        except Exception:                   # noqa: BLE001
            return

        url = "{0}/api/detections/{1}/image".format(self.base_url, detection_id)
        try:
            resp = self._session.put(
                url,
                files={"image": ("frame.jpg", image, "image/jpeg")},
                timeout=self.timeout_s * 3,      # images are bigger; give them room
                verify=self.verify_tls,
            )
            if 200 <= resp.status_code < 300:
                self.stats.images_sent += 1
            else:
                print("[uplink] image upload for detection {0} returned HTTP {1}"
                      .format(detection_id, resp.status_code), file=sys.stderr)
        except Exception as exc:            # noqa: BLE001
            print("[uplink] image upload for detection {0} failed: {1}"
                  .format(detection_id, exc), file=sys.stderr)

    def _spool(self, record: Dict, image: Optional[bytes]) -> None:
        """Persist a record we could not send. Named by its idempotency key."""
        cid = record.get("client_detection_id") or new_client_id()
        record["client_detection_id"] = cid
        base = os.path.join(self.spool_dir, cid)

        try:
            # Write to a temp name then rename: a power cut mid-write must not
            # leave a truncated JSON file that replay will quarantine.
            tmp = base + ".json.tmp"
            with open(tmp, "w") as fh:
                json.dump(record, fh)
            os.rename(tmp, base + ".json")

            if image:
                tmp_img = base + ".jpg.tmp"
                with open(tmp_img, "wb") as fh:
                    fh.write(image)
                os.rename(tmp_img, base + ".jpg")

            self.stats.spooled += 1
        except Exception as exc:            # noqa: BLE001
            print("[uplink] SPOOL FAILED for {0}: {1} - this detection is lost"
                  .format(cid, exc), file=sys.stderr)

    def _quarantine(self, path: str) -> None:
        if not os.path.exists(path):
            return
        bad_dir = os.path.join(self.spool_dir, "rejected")
        try:
            if not os.path.isdir(bad_dir):
                os.makedirs(bad_dir)
            shutil.move(path, os.path.join(bad_dir, os.path.basename(path)))
        except Exception:                   # noqa: BLE001
            self._unlink(path)

    @staticmethod
    def _unlink(path: str) -> None:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


def main() -> int:
    """Spool inspection and manual replay.

        python3 jetson/uplink.py --status
        python3 jetson/uplink.py --replay --backend-url http://127.0.0.1:8000 --api-key KEY
    """
    import argparse

    ap = argparse.ArgumentParser(
        description="AeroShield uplink spool tool.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--backend-url", default="http://127.0.0.1:8000")
    ap.add_argument("--api-key", default=os.environ.get("AEROSHIELD_API_KEY"))
    ap.add_argument("--spool-dir", default=DEFAULT_SPOOL_DIR)
    ap.add_argument("--status", action="store_true", help="Count spooled records and exit")
    ap.add_argument("--replay", action="store_true", help="Re-send everything spooled")
    args = ap.parse_args()

    up = BackendUplink(args.backend_url, api_key=args.api_key, spool_dir=args.spool_dir)

    if args.status or not args.replay:
        print("spool dir : {0}".format(args.spool_dir))
        print("pending   : {0} record(s)".format(up.pending_spool_count()))
        rejected = os.path.join(args.spool_dir, "rejected")
        if os.path.isdir(rejected):
            print("rejected  : {0} file(s) in {1}".format(len(os.listdir(rejected)), rejected))
        if not args.replay:
            return 0

    try:
        up.start()
        accepted = up.replay_spool()
        print("replayed {0} record(s); {1} still pending".format(
            accepted, up.pending_spool_count()))
        print("stats: {0}".format(up.stats))
    except RuntimeError as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1
    finally:
        up.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
