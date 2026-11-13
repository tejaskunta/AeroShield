#!/usr/bin/env python3
# Python 3.6-compatible JSON uploader for AeroShield FastAPI.
import json
import os
import threading
import time
import uuid
from collections import deque

try:
    import requests
except ImportError:
    requests = None


def new_client_id():
    return str(uuid.uuid4())


class BackendUplink(object):
    def __init__(self, backend_url, api_key=None, send_images=False,
                 detections_path="/api/v1/detections",
                 missions_path="/api/v1/missions",
                 timeout_s=8.0, spool_path=None):
        if requests is None:
            raise RuntimeError("requests is required: pip install requests")
        self.base = backend_url.rstrip("/")
        self.api_key = api_key
        self.send_images = bool(send_images)
        self.detections_url = self.base + detections_path
        self.missions_url = self.base + missions_path
        self.timeout_s = float(timeout_s)
        self.spool_path = spool_path or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "logs", "uplink_spool.jsonl")
        parent = os.path.dirname(self.spool_path)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent)
        self._queue = deque()
        self._condition = threading.Condition()
        self._stop = False
        self._thread = None
        self._session = requests.Session()
        self._sent = 0
        self._failed = 0
        self._queued = 0
        self._last_error = None

    @property
    def stats(self):
        return "sent={0}, failed={1}, queued={2}".format(
            self._sent, self._failed, len(self._queue))

    def _headers(self):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            # Change header name here if your FastAPI dependency expects another.
            h["X-API-Key"] = self.api_key
        return h

    def _post_json(self, url, payload):
        response = self._session.post(
            url, json=payload, headers=self._headers(), timeout=self.timeout_s)
        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError("HTTP {0}: {1}".format(
                response.status_code, response.text[:500]))
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError:
            return {}

    def ensure_mission(self, mission_name):
        # Roadmap contract: POST /api/v1/missions with mission_name.
        try:
            data = self._post_json(self.missions_url, {
                "mission_name": mission_name,
                "status": "active"
            })
            mission_id = data.get("mission_id") or data.get("id")
            if mission_id is None and isinstance(data.get("mission"), dict):
                mission_id = data["mission"].get("mission_id") or data["mission"].get("id")
            if mission_id is None:
                self._last_error = "Mission API response did not contain mission_id/id: {0}".format(data)
                print("[uplink] WARNING: {0}".format(self._last_error))
                return None
            return mission_id
        except Exception as exc:
            self._last_error = str(exc)
            print("[uplink] Mission creation failed: {0}".format(exc))
            return None

    def start(self):
        self._stop = False
        self._thread = threading.Thread(target=self._worker, name="aeroshield-uplink")
        self._thread.daemon = True
        self._thread.start()

    def submit(self, record, image_bytes=None, gradcam_bytes=None):
        # Image multipart contract is not specified in the supplied backend
        # roadmap. Metadata JSON is uploaded; images are intentionally omitted.
        item = dict(record)
        with self._condition:
            self._queue.append(item)
            self._queued += 1
            self._condition.notify()

    def _spool(self, record):
        wrapper = {"record": record, "spooled_at": time.time()}
        with open(self.spool_path, "a") as fh:
            fh.write(json.dumps(wrapper, separators=(",", ":")) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def _send(self, record):
        self._post_json(self.detections_url, record)
        self._sent += 1
        self._last_error = None

    def _worker(self):
        while True:
            with self._condition:
                while not self._queue and not self._stop:
                    self._condition.wait(0.5)
                if self._stop and not self._queue:
                    return
                record = self._queue.popleft()
            try:
                self._send(record)
                print("[uplink] Detection uploaded: {0}".format(
                    record.get("client_detection_id", "unknown")))
            except Exception as exc:
                self._failed += 1
                self._last_error = str(exc)
                try:
                    self._spool(record)
                    print("[uplink] Upload failed; spooled locally: {0}".format(exc))
                except Exception as spool_exc:
                    print("[uplink] CRITICAL: upload and spool both failed: {0}".format(spool_exc))

    def pending_spool_count(self):
        if not os.path.exists(self.spool_path):
            return 0
        try:
            with open(self.spool_path, "r") as fh:
                return sum(1 for line in fh if line.strip())
        except IOError:
            return 0

    def replay_spool(self):
        if not os.path.exists(self.spool_path):
            return
        pending = []
        with open(self.spool_path, "r") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                    pending.append(obj.get("record", obj))
                except ValueError:
                    print("[uplink] Skipping malformed spool line")
        if not pending:
            return
        # Keep only records that fail replay; avoid deleting the spool until all
        # attempts have been made.
        failed = []
        for record in pending:
            try:
                self._send(record)
            except Exception as exc:
                failed.append({"record": record, "spooled_at": time.time()})
                self._last_error = str(exc)
        tmp = self.spool_path + ".tmp"
        with open(tmp, "w") as fh:
            for item in failed:
                fh.write(json.dumps(item, separators=(",", ":")) + "\n")
        os.rename(tmp, self.spool_path)
        print("[uplink] Spool replay: {0} sent, {1} still pending".format(
            len(pending) - len(failed), len(failed)))

    def close(self):
        if self._thread is not None:
            with self._condition:
                self._stop = True
                self._condition.notify_all()
            self._thread.join(timeout=10.0)
        try:
            self._session.close()
        except Exception:
            pass
