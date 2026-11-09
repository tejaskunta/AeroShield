"""AeroShield - the live mission socket.

ONE SOCKET PER MISSION, ONE SOCKET PER DASHBOARD. A client opens
`/api/ws/missions/{id}?key=...` once and from then on is told when something
happens instead of asking. That is the whole change: the polling endpoint stays,
because a socket that never connects must not be the difference between a working
dashboard and a blank one, but the browser stops spending a round trip per second
per tab to learn that nothing has changed.

WHAT IT SENDS, AND WHY THE SHAPE IS BORROWED.

    {"type": "telemetry", "data": <TelemetryLatest>}   same JSON as GET .../latest
    {"type": "detection", "data": <DetectionRead>}     same JSON as GET /detections/{id}
    {"type": "ping",      "data": {"t": "..."}}        keep-alive only, no state

The `data` of a telemetry frame is byte-for-byte what the polling route returns,
so the browser has one parser and one mapping into its snapshot, and switching a
tab from polling to socket is not a code path that needs testing twice. The
envelope is not decoration: a bare `DetectionRead` and a bare `TelemetryLatest`
are both JSON objects, and a client that had to sniff which one arrived would
eventually guess wrong.

THE FIRST FRAME IS THE CURRENT POSITION, SENT ON CONNECT. Without it a dashboard
that opens a socket at second 0.5 of a 1 Hz feed shows nothing until second 1.5 -
and a socket that is silent looks exactly like a broken socket. So the connect
handler reads the newest row and sends it immediately, even when the answer is
`found=false`. That is the same answer the poll would have given, arriving sooner.

WHY THE KEY IS IN THE QUERY STRING. The browser `WebSocket` constructor takes a
URL and a subprotocol list and nothing else - there is no way to set an
`X-API-Key` header. So the credential is a query parameter, which has two
consequences worth stating plainly rather than discovering later: it appears in
uvicorn's access log, and it appears in browser history for a `ws://` retry. It is
read-scoped dashboard key, it is short-lived by policy, and the alternative (an
unauthenticated socket) is worse. An `X-API-Key` header is accepted too, for
non-browser clients that can set one.

AUTH IS DONE HERE, NOT BY `get_principal`. That dependency resolves from an
`APIKeyHeader`, which does not exist on a websocket scope, so reusing it would
401 every connection. The lookup below is the same one, against the same table,
with the same scope - it just reads the key from somewhere a browser can put it.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from starlette.websockets import WebSocketState

from app.api.telemetry import TELEMETRY_LIVE_WINDOW_S
from app.core.security import SCOPE_DETECTIONS_READ, has_scope, hash_api_key
from app.db.models.api_key import ApiKey
from app.db.session import SessionLocal
from app.schemas.telemetry import TelemetryLatest, TelemetryRead
from app.services import mission_service, telemetry_repository
from app.services.broadcast import FRAME_PING, bus, telemetry_frame

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Live"])

# Close codes. 1008 = policy violation, which is what an auth failure is on a
# socket: the connection was understood and refused. 1000 = normal closure, used
# when the server hangs up politely on a mission that is not there.
CLOSE_POLICY_VIOLATION = 1008
CLOSE_NORMAL = 1000

# How often to emit a keep-alive. A mine site's link and a laptop's wifi both sit
# behind NAT and proxies that drop a connection which has been idle for a minute
# or two; at 1 Hz during a flight the socket is never idle, but between flights
# and on the bench it is, and a socket killed by a proxy looks like a backend
# fault. Twenty seconds is comfortably inside every default idle timeout in play.
PING_INTERVAL_S = 20.0

# Non-browser clients (a test harness, a relay) can set this header instead of
# putting the key on the URL. Lower-case because starlette's Headers is
# case-insensitive but compares the literal we pass.
_AUTH_HEADER = "x-api-key"


async def _authenticate(key: Optional[str]) -> Optional[str]:
    """Resolve a plaintext key to the name of an active, read-scoped key - or None.

    Deliberately returns None for EVERY failure - missing, malformed, unknown,
    revoked, wrong scope. The client is told one thing ("not authorised") because
    distinguishing "that key exists but is revoked" from "that key never existed"
    is a way to enumerate valid credentials, and the operator already knows which
    of their own keys they used.

    Returns the NAME rather than the row: the row is detached the moment the
    session closes, and the only thing downstream needs it for is a log line.
    """
    if not key:
        return None

    key = key.strip()
    if not key:
        return None

    async with SessionLocal() as db:
        result = await db.execute(
            select(ApiKey).where(ApiKey.key_hash == hash_api_key(key))
        )
        row = result.scalar_one_or_none()

        if row is None or not row.is_active:
            return None
        if not has_scope(list(row.scopes or []), SCOPE_DETECTIONS_READ):
            return None

        return row.name


async def _reject(websocket: WebSocket, reason: str, code: int = CLOSE_POLICY_VIOLATION) -> None:
    """Refuse a socket without leaking why. `reason` goes to the log, not the wire.

    The client gets a close code and a short generic reason; the useful sentence
    is logged server-side where an operator can read it and a stranger cannot.
    """
    logger.info("live: refused socket - %s", reason)
    await websocket.close(code=code, reason="unauthorised")


async def _current_latest(mission_id: int, mission_name: Optional[str]) -> TelemetryLatest:
    """Build the same payload `GET .../telemetry/latest` builds, for the first frame.

    Reuses the repository and the schema so there are not two definitions of
    "where is the drone", and imports the live window from the HTTP route so the
    two can never disagree about what "live" means.
    """
    async with SessionLocal() as db:
        row = await telemetry_repository.latest(db, mission_id)

    age = telemetry_repository.age_seconds(row)
    return TelemetryLatest(
        found=row is not None,
        mission_id=mission_id,
        mission_name=mission_name,
        telemetry=TelemetryRead.model_validate(row) if row is not None else None,
        age_s=None if age is None else round(age, 2),
        live=age is not None and age <= TELEMETRY_LIVE_WINDOW_S,
    )


@router.websocket("/ws/missions/{mission_id}")
async def mission_socket(websocket: WebSocket, mission_id: int) -> None:
    """Push position and detection frames for one mission until the client leaves.

    Lifecycle, in order: authenticate, verify the mission exists, accept, send the
    current position, then stream. Every exit path removes the subscriber, because
    a subscription that outlives its socket is a memory leak that also logs a
    warning per dropped frame forever.
    """
    key = websocket.query_params.get("key") or websocket.headers.get(_AUTH_HEADER)

    key_name = await _authenticate(key)
    if key_name is None:
        # Accept before closing: starlette will refuse to send a close frame on a
        # socket that was never accepted, and the browser then sees a generic
        # handshake failure instead of the 1008 that means "your key is wrong".
        await websocket.accept()
        await _reject(websocket, "no valid read-scoped key on the query string")
        return

    async with SessionLocal() as db:
        mission = await mission_service.get_by_id(db, mission_id)

    if mission is None:
        await websocket.accept()
        logger.info("live: refused socket for unknown mission %s", mission_id)
        await websocket.close(code=CLOSE_NORMAL, reason="no such mission")
        return

    mission_name = mission.name
    await websocket.accept()

    queue = bus.subscribe(mission_id)
    logger.info(
        "live: mission %s (%s) socket open, key %s",
        mission_id, mission_name, key_name,
    )

    try:
        # First frame: where it is right now. `found=false` is a legitimate first
        # answer and is sent as such, so the client can render "no position yet"
        # without waiting for a beacon that may be minutes away.
        try:
            initial = await _current_latest(mission_id, mission_name)
            await websocket.send_json(telemetry_frame(initial))
        except Exception:                       # pragma: no cover - defensive
            # A failure to read the first frame must not kill the socket: the
            # live stream that follows is still the thing the client wants.
            logger.exception("live: could not send initial frame for mission %s", mission_id)

        # Two coroutines: one waits on the bus, one keeps the connection warm.
        # Gathered rather than 'get with timeout' so a ping during a quiet spell
        # cannot be mistaken for a dead subscriber.
        while True:
            try:
                frame = await asyncio.wait_for(queue.get(), timeout=PING_INTERVAL_S)
            except asyncio.TimeoutError:
                frame = {
                    "type": FRAME_PING,
                    "data": {"t": datetime.now(timezone.utc).isoformat()},
                }

            if websocket.client_state is not WebSocketState.CONNECTED:
                break

            try:
                await websocket.send_json(frame)
            except (WebSocketDisconnect, RuntimeError):
                # RuntimeError is what starlette raises if the socket closed
                # between the state check and the send. Both mean: client gone.
                break

    except WebSocketDisconnect:
        logger.debug("live: mission %s socket closed by client", mission_id)
    except asyncio.CancelledError:
        # uvicorn cancels the handler on reload or shutdown. Clean up, then
        # re-raise so the task actually ends cancelled rather than swallowed.
        logger.debug("live: mission %s socket cancelled by server", mission_id)
        raise
    except Exception:                           # pragma: no cover - defensive
        logger.exception("live: mission %s socket failed", mission_id)
    finally:
        bus.unsubscribe(mission_id, queue)
        logger.info("live: mission %s socket closed", mission_id)