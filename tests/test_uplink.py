"""Unit tests for jetson/uplink.py: no network, no backend.

The HTTP session is replaced by a fake whose behaviour each test scripts. The three
loss paths found by scripts/uplink_soak.py each have a test here:
  * a record refused by the server during live sending is kept (spool/rejected/);
  * records spooled during an outage are re-sent automatically once the link is back;
  * a record still being sent when close() gives up on the worker is spooled.
"""
import json
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "jetson"))
import uplink as U  # noqa: E402


class Resp(object):
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body or {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class FakeSession(object):
    """mode: 'ok' | 'down' | 'fatal' | 'hang' | 'lost_ack'. Rows keyed by client id."""

    def __init__(self):
        self.mode = "ok"
        self.rows = {}
        self.resent = 0
        self.headers = {}
        self.release = threading.Event()

    def close(self):
        pass

    def post(self, url, json=None, timeout=None, verify=None):
        if self.mode == "down":
            raise ConnectionError("link down")
        if self.mode == "fatal":
            return Resp(401, {"detail": "bad key"})
        if self.mode == "hang":
            self.release.wait(10)
            raise ConnectionError("timed out")
        cid = json["client_detection_id"]
        if cid in self.rows:
            self.resent += 1
        self.rows.setdefault(cid, len(self.rows) + 1)
        if self.mode == "lost_ack":
            raise ConnectionError("response lost")
        return Resp(200, {"id": self.rows[cid]})

    def put(self, url, files=None, timeout=None, verify=None):
        return Resp(200, {})


def make(tmp_path, **kw):
    up = U.BackendUplink("http://fake", spool_dir=str(tmp_path / "spool"), timeout_s=0.01,
                         max_attempts=2, backoff_base_s=0.001, replay_interval_s=0.05, **kw)
    up.start()
    fake = FakeSession()
    up._session = fake
    return up, fake


def wait_for(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


def rec():
    return {"client_detection_id": U.new_client_id(), "label": "mine"}


def files_in(folder):
    return {n[:-5] for n in os.listdir(folder) if n.endswith(".json")} if os.path.isdir(folder) else set()


def test_happy_path_sends_once(tmp_path):
    up, fake = make(tmp_path)
    r = rec()
    up.submit(r, b"jpg")
    assert wait_for(lambda: r["client_detection_id"] in fake.rows)
    up.close(0.5)
    assert up.pending_spool_count() == 0


def test_outage_records_are_spooled_then_resent_automatically(tmp_path):
    up, fake = make(tmp_path)
    fake.mode = "down"
    recs = [rec() for _ in range(5)]
    for r in recs:
        up.submit(r)
    assert wait_for(lambda: up.pending_spool_count() == 5)
    fake.mode = "ok"                       # link back, no new detections arrive
    assert wait_for(lambda: up.pending_spool_count() == 0)
    assert {r["client_detection_id"] for r in recs} <= set(fake.rows)
    up.close(0.5)


def test_fatal_status_during_live_sending_is_kept_not_dropped(tmp_path):
    up, fake = make(tmp_path)
    fake.mode = "fatal"
    r = rec()
    up.submit(r)
    rejected = str(tmp_path / "spool" / "rejected")
    assert wait_for(lambda: r["client_detection_id"] in files_in(rejected))
    up.close(0.5)
    assert r["client_detection_id"] not in fake.rows


def test_close_spools_the_record_being_sent(tmp_path):
    up, fake = make(tmp_path)
    fake.mode = "hang"
    r = rec()
    up.submit(r)
    assert wait_for(lambda: up._inflight is not None)
    up.close(drain_timeout_s=0.1)          # worker is stuck in the send
    assert r["client_detection_id"] in files_in(str(tmp_path / "spool"))
    fake.release.set()


def test_lost_ack_resend_is_absorbed_by_idempotent_server(tmp_path):
    up, fake = make(tmp_path)
    fake.mode = "lost_ack"
    r = rec()
    up.submit(r)
    assert wait_for(lambda: up.pending_spool_count() == 1)   # client thinks it failed
    fake.mode = "ok"
    assert wait_for(lambda: up.pending_spool_count() == 0)
    assert fake.resent >= 1 and len(fake.rows) == 1
    up.close(0.5)


def test_full_queue_spools_instead_of_dropping(tmp_path):
    up = U.BackendUplink("http://fake", spool_dir=str(tmp_path / "spool"), queue_size=1)
    # worker not started: the queue fills at once
    recs = [rec() for _ in range(4)]
    for r in recs:
        up.submit(r)
    assert up.pending_spool_count() == 3


@pytest.mark.parametrize("n", [1, 3])
def test_spooling_the_same_id_twice_keeps_one_file(tmp_path, n):
    up = U.BackendUplink("http://fake", spool_dir=str(tmp_path / "spool"))
    r = rec()
    for _ in range(n + 1):
        up._spool(dict(r), b"jpg")
    assert up.pending_spool_count() == 1
