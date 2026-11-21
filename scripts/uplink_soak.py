#!/usr/bin/env python3
"""Fault-injection soak test for jetson/uplink.py (no hardware, no backend, no network).

The real BackendUplink runs against an in-process fake detections API that mimics the
backend's idempotency (one row per client_detection_id; a repeat returns 200). The fake
link injects:
  * dropped requests            (ConnectionError before the server sees the record)
  * 503 responses               (server overloaded)
  * lost acknowledgements       (server stores the record, the response never arrives)
  * hung requests               (the send blocks for seconds, like a dead TCP link)
  * link outages                (bursts where every request fails)
  * a credentials window        (HTTP 401 for a stretch of the flight, e.g. a rotated key)
  * process restarts            (close() then a new uplink on the same spool; a send still
                                 in progress when the process "dies" never returns)

Outcome per detection, after the flight:
  delivered  - stored on the server by shutdown (link restored at landing, GRACE_S grace)
  retained   - not on the server, but on the drone's disk (spool or spool/rejected)
  lost       - neither: the detection is gone
then a 'next power-on' replays the spool: delivered_after_next_power_on, and records the
server refused (HTTP 401 window) kept in spool/rejected/ for an operator.
and the re-sends the idempotent server absorbed (rows a non-idempotent server would duplicate).

    python scripts/uplink_soak.py --n 5000 --seed 0 --out results/uplink_soak_after.json
"""
import argparse
import json
import os
import random
import shutil
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# UPLINK_DIR lets the same soak run against another copy of uplink.py (e.g. the
# version before the fixes, extracted with `git show f697e57:jetson/uplink.py`).
sys.path.insert(0, os.environ.get("UPLINK_DIR") or os.path.join(HERE, "..", "jetson"))
import uplink as U  # noqa: E402

GRACE_S = 30.0


class FakeResponse(object):
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body or {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class FakeLink(object):
    """Stands in for requests.Session. Shared by every uplink instance (one 'server')."""

    def __init__(self, rng, p_drop, p_503, p_lost_ack, p_hang, hang_s):
        self.rng = rng
        self.p_drop, self.p_503, self.p_lost_ack, self.p_hang = p_drop, p_503, p_lost_ack, p_hang
        self.hang_s = hang_s
        self.rows = {}                 # client_detection_id -> row id
        self.posts = 0
        self.resent = 0
        self.outage = threading.Event()   # set = link down
        self.unauthorised = threading.Event()
        self.lock = threading.Lock()
        self.dead_sessions = set()     # sessions whose process has "died"

    def session(self):
        return FakeSession(self)


class FakeSession(object):
    def __init__(self, link):
        self.link = link
        self.headers = {}
        self.killed = threading.Event()

    def close(self):
        pass

    def _hang_forever_if_killed(self):
        if self.killed.is_set():
            threading.Event().wait()   # the process is gone: this call never returns

    def post(self, url, json=None, timeout=None, verify=None):
        L = self.link
        with L.lock:
            L.posts += 1
            r = L.rng.random()
        self._hang_forever_if_killed()
        if L.outage.is_set() or r < L.p_drop:
            raise ConnectionError("link down")
        r -= L.p_drop
        if r < L.p_hang:
            self.killed.wait(L.hang_s)
            self._hang_forever_if_killed()
            raise ConnectionError("timed out")
        r -= L.p_hang
        if L.unauthorised.is_set():
            return FakeResponse(401, {"detail": "invalid API key"})
        if r < L.p_503:
            return FakeResponse(503, {"detail": "busy"})
        r -= L.p_503
        cid = json["client_detection_id"]
        with L.lock:
            if cid in L.rows:
                L.resent += 1
            else:
                L.rows[cid] = len(L.rows) + 1
            row = L.rows[cid]
        if r < L.p_lost_ack:
            raise ConnectionError("response lost")
        return FakeResponse(200, {"id": row})

    def put(self, url, files=None, timeout=None, verify=None):
        self._hang_forever_if_killed()
        return FakeResponse(200, {})


def make_uplink(link, spool):
    up = U.BackendUplink("http://fake", api_key="k", spool_dir=spool, queue_size=64,
                         timeout_s=0.01, max_attempts=3, backoff_base_s=0.002)
    up.start()
    up._session = link.session()        # swap the transport; everything else is real
    if hasattr(up, "replay_interval_s"):
        up.replay_interval_s = 0.05
    return up


def on_disk(spool):
    ids = set()
    for root in (spool, os.path.join(spool, "rejected")):
        if os.path.isdir(root):
            ids.update(n[:-5] for n in os.listdir(root) if n.endswith(".json"))
    return ids


def run(n, seed, restarts, outages, auth_window, quiet):
    rng = random.Random(seed)
    link = FakeLink(rng, p_drop=0.15, p_503=0.05, p_lost_ack=0.05, p_hang=0.002, hang_s=3.0)
    spool = tempfile.mkdtemp(prefix="uplink_soak_")
    restart_at = set(rng.sample(range(n // 10, n - n // 10), restarts))
    outage_at = {i: rng.randint(50, 300) for i in rng.sample(range(n), outages)}
    auth_lo = rng.randint(n // 4, n // 2)
    auth_hi = auth_lo + auth_window
    devnull = open(os.devnull, "w")
    old_err, old_out = sys.stderr, sys.stdout
    if quiet:
        sys.stderr = sys.stdout = devnull
    t0 = time.time()
    try:
        up = make_uplink(link, spool)
        ids, outage_left = [], 0
        for i in range(n):
            if i in outage_at:
                outage_left = outage_at[i]
            if outage_left > 0:
                link.outage.set(); outage_left -= 1
            else:
                link.outage.clear()
            if auth_lo <= i < auth_hi:
                link.unauthorised.set()
            else:
                link.unauthorised.clear()
            rec = {"client_detection_id": U.new_client_id(), "label": "mine", "confidence": 0.9}
            ids.append(rec["client_detection_id"])
            up.submit(rec, b"jpeg")
            time.sleep(0.0005)
            if i in restart_at:
                up.close(drain_timeout_s=0.2)
                up._session.killed.set()      # the old process is gone
                up = make_uplink(link, spool)
        link.outage.clear(); link.unauthorised.clear()
        # landing: the link is back (random faults continue); the drone stays powered
        # for up to GRACE_S, then shuts down.
        t_land = time.time()
        deadline = t_land + GRACE_S
        while time.time() < deadline and (not up._queue.empty() or up.pending_spool_count()):
            time.sleep(0.05)
        up.close(drain_timeout_s=1.0)
        up._session.killed.set()              # power off: anything still running dies
        time.sleep(0.2)
        delivered_ids = set(link.rows)
        disk = on_disk(spool)
        # next power-on on the ground: replay the spool (random faults continue)
        up2 = make_uplink(link, spool)
        t_next = time.time()
        while up2.pending_spool_count() and time.time() - t_next < 300:
            up2.replay_spool()
        up2.close(drain_timeout_s=0.5)
        up2._session.killed.set()
        eventually = set(link.rows)
        rejected = on_disk(spool) - eventually
    finally:
        sys.stderr, sys.stdout = old_err, old_out
        devnull.close()
    delivered = sum(1 for c in ids if c in delivered_ids)
    retained = sum(1 for c in ids if c not in delivered_ids and c in disk)
    lost = n - delivered - retained
    eventually_delivered = sum(1 for c in ids if c in eventually)
    kept_for_operator = sum(1 for c in ids if c not in eventually and c in rejected)
    shutil.rmtree(spool, ignore_errors=True)
    return {"n": n, "seed": seed, "restarts": restarts, "outages": outages,
            "auth_window_records": auth_window, "grace_after_landing_s": GRACE_S,
            "delivered_by_shutdown": delivered, "retained_on_disk": retained, "lost": lost,
            "delivered_after_next_power_on": eventually_delivered,
            "kept_in_rejected_for_operator": kept_for_operator,
            "unaccounted_after_next_power_on": n - eventually_delivered - kept_for_operator,
            "resends_absorbed_by_idempotency": link.resent, "posts": link.posts,
            "seconds": round(time.time() - t0, 1),
            "fault_rates": {"drop": link.p_drop, "503": link.p_503, "lost_ack": link.p_lost_ack,
                            "hang": link.p_hang, "hang_s": link.hang_s}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5000)
    ap.add_argument("--seeds", default="0,1,2")
    ap.add_argument("--restarts", type=int, default=5)
    ap.add_argument("--outages", type=int, default=8)
    ap.add_argument("--auth-window", type=int, default=100)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    runs = [run(args.n, int(s), args.restarts, args.outages, args.auth_window, quiet=True)
            for s in args.seeds.split(",")]
    for r in runs:
        print(json.dumps(r))
    tot = {k: sum(r[k] for r in runs) for k in ("n", "delivered_by_shutdown", "retained_on_disk", "lost", "delivered_after_next_power_on",
                                                 "kept_in_rejected_for_operator", "unaccounted_after_next_power_on",
                                                 "resends_absorbed_by_idempotency")}
    print("TOTAL", json.dumps(tot))
    if args.out:
        with open(args.out, "w") as fh:
            json.dump({"script": "scripts/uplink_soak.py", "runs": runs, "total": tot}, fh, indent=1)


if __name__ == "__main__":
    main()
