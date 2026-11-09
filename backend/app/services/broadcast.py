"""AeroShield - in-process fan-out of live mission updates.

ONE WRITER, MANY READERS, AND THE WRITER NEVER WAITS. The drone posts a telemetry
frame; every dashboard with an open socket wants it. The drone is on a radio link
over a mine site - if publishing a frame could block, a single browser tab that
stopped reading would stall the aircraft's ingest, and the aircraft would spool
and look offline. So `publish` is synchronous, never awaits, and drops frames
rather than backpressure the flight. A dropped position at 1 Hz is one missing
dot; a stalled ingest is a lost mission.

WHY NO REDIS, NO RABBITMQ, NO EXTERNAL BROKER. This runs as one uvicorn process.
An external broker would add a daemon to install on the laptop, a connection to
lose before a class demo, and an operational failure mode whose symptom is
"dashboard is silently stale". The moment this needs more than one worker, the
broker argument changes - but that is a deployment-size decision, not a reason to
carry the complexity now. The seam is `publish`/`subscribe`: a Redis-backed
implementation has the same two functions, and no caller changes.

WHAT IS AND IS NOT IN A FRAME. Subscribers receive already-serialised dicts, not
ORM rows. A row is bound to the session that loaded it, and handing one to another
task is a legible way to raise DetachedInstanceError inside a websocket loop.
Serialising in the writer's transaction also means a frame on the wire is exactly
what a GET would have returned.

IS THIS THE WRITE PATH OR A CACHE? Neither. The database remains the record; this
carries only the notification that a new row exists, already shaped like the read
endpoint's response. Losing every frame here loses latency, never data - a
reconnecting client pulls `GET /telemetry/latest` and is immediately correct.
"""

import asyncio
import logging
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set

from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Per-subscriber depth. At 1 Hz this is half a minute of backlog, which is far
# more than a briefly-stalled browser needs, and small enough that a socket which
# has genuinely stopped reading cannot pin unbounded memory. A frame of telemetry
# is a few hundred bytes, so the worst case here is kilobytes per tab.
SUBSCRIBER_QUEUE_DEPTH = 32

# Frame types. The envelope - not a bare payload - so one socket can carry more
# than one kind of update without the client guessing from the shape of the JSON.
FRAME_TELEMETRY = "telemetry"
FRAME_DETECTION = "detection"
FRAME_PING = "ping"


def telemetry_frame(payload: BaseModel) -> Dict[str, Any]:
    """Envelope one `TelemetryLatest`, serialised exactly as the HTTP route would.

    `mode="json"` rather than `model_dump()`: it converts datetimes to the same
    ISO-8601 strings FastAPI puts on the wire, so a client cannot tell whether a
    snapshot arrived over the socket or over a GET, and needs only one parser.
    """
    return {"type": FRAME_TELEMETRY, "data": payload.model_dump(mode="json")}


def detection_frame(payload: BaseModel) -> Dict[str, Any]:
    """Envelope one `DetectionRead`. Same JSON-shape rule as `telemetry_frame`."""
    return {"type": FRAME_DETECTION, "data": payload.model_dump(mode="json")}


class BroadcastBus:
    """A per-mission set of subscriber queues. One instance per process.

    Deliberately not thread-safe: uvicorn runs the app on a single event loop, so
    `put_nowait` from a request handler and `get()` from a websocket handler are
    already serialised by the loop. Adding a lock would imply a concurrency model
    this does not have.
    """

    def __init__(self) -> None:
        self._channels: Dict[int, Set["asyncio.Queue[Dict[str, Any]]"]] = defaultdict(set)
        self._dropped = 0

    # --- subscriber side ---------------------------------------------------

    def subscribe(self, mission_id: int) -> "asyncio.Queue[Dict[str, Any]]":
        """Register a listener and return the queue it will be fed through.

        The queue must be created in the subscriber's loop - it is, because this is
        called from the websocket handler. A queue created in another loop raises
        "attached to a different loop" on first use, which is the failure this
        comment exists to stop someone reintroducing.
        """
        queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(
            maxsize=SUBSCRIBER_QUEUE_DEPTH
        )
        self._channels[mission_id].add(queue)
        logger.debug(
            "live: subscriber added for mission %s (%s now listening)",
            mission_id, len(self._channels[mission_id]),
        )
        return queue

    def unsubscribe(self, mission_id: int, queue: "asyncio.Queue[Dict[str, Any]]") -> None:
        """Stop feeding a queue. Safe to call twice, and safe on an unknown mission.

        The `finally` in every consumer calls this unconditionally, because a
        half-closed socket that is never removed from the channel would leak a
        queue - and keep "publishing" to a browser that has gone away - for the
        life of the process.
        """
        listeners = self._channels.get(mission_id)
        if not listeners:
            return
        listeners.discard(queue)
        if not listeners:
            # Drop the empty set so a mission that has had a hundred viewers does
            # not leave a hundred empty keys behind.
            del self._channels[mission_id]
        logger.debug("live: subscriber removed for mission %s", mission_id)

    # --- publisher side ----------------------------------------------------

    def publish(self, mission_id: Optional[int], frame: Dict[str, Any]) -> int:
        """Fan a frame out to every listener. Returns how many queues accepted it.

        NEVER AWAITS, NEVER RAISES. Both properties are load-bearing: this is
        called from the telemetry ingest route, which is the drone's hot path.
        `mission_id=None` is a valid, deliberate no-op - a detection stored
        without mission context has no channel to belong to, and inventing one
        would put it on a mission's dashboard that it did not come from.
        """
        if mission_id is None:
            return 0

        listeners = self._channels.get(mission_id)
        if not listeners:
            return 0

        delivered = 0
        for queue in list(listeners):     # copy: a queue may vanish mid-loop
            if self._offer(queue, frame):
                delivered += 1
        return delivered

    def _offer(self, queue: "asyncio.Queue[Dict[str, Any]]", frame: Dict[str, Any]) -> bool:
        """Put one frame, evicting the oldest if this listener is behind.

        Drop-OLDEST, not drop-newest. A dashboard that has fallen behind wants the
        newest position, not a backlog it will spend the next minute replaying -
        and for a live aircraft, an old position arriving late is worse than not
        arriving at all, because it looks current.
        """
        try:
            queue.put_nowait(frame)
            return True
        except asyncio.QueueFull:
            pass

        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:      # pragma: no cover - requires a race to hit
            pass

        try:
            queue.put_nowait(frame)
        except asyncio.QueueFull:       # pragma: no cover - requires a race to hit
            return False

        self._dropped += 1
        if self._dropped == 1 or self._dropped % 100 == 0:
            # Logged at intervals rather than per frame: a wedged tab would
            # otherwise fill the log with one line per second and bury the
            # messages that matter. The count is exposed on `stats()`.
            logger.warning(
                "live: dropped %s frame(s) to slow subscribers (queue depth %s)",
                self._dropped, SUBSCRIBER_QUEUE_DEPTH,
            )
        return True

    # --- introspection -----------------------------------------------------

    def missions(self) -> List[int]:
        """Mission ids that currently have at least one listener."""
        return sorted(self._channels)

    def stats(self) -> Dict[str, Any]:
        """Counters for `/health` and for tests. No timing, no history."""
        return {
            "missions": len(self._channels),
            "subscribers": sum(len(q) for q in self._channels.values()),
            "dropped_total": self._dropped,
        }

    def reset(self) -> None:
        """Forget every subscriber. For tests, and for a shutdown that is abrupt.

        Not called on the normal path: each websocket removes its own queue in its
        own `finally`, so the bus empties itself as clients disconnect.
        """
        self._channels.clear()
        self._dropped = 0


# The process-wide bus. An import-time singleton is the right shape here: it must
# be the SAME object for the ingest route and the websocket route, and there is
# exactly one of each per process.
bus = BroadcastBus()