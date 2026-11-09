"""AeroShield - aircraft position telemetry endpoints.

THREE ROUTES, EACH ANSWERING ONE QUESTION.

    POST /api/missions/{id}/telemetry          the drone: "here I am, now"
    GET  /api/missions/{id}/telemetry/latest   the dashboard: "where is it now?"
    GET  /api/missions/{id}/telemetry          the dashboard: "where has it been?"

They live under the mission because a position without a mission is not
meaningful - there is no flight to attribute it to. That also means the mission
row must exist first, and a 404 here is the honest answer rather than creating a
mission named by a typo.

LATEST IS A SEPARATE ROUTE FROM THE TRACK, and that is the whole point of it.
The dashboard polls position at about 1 Hz and needs one row; the track is
fetched once, or on demand, and needs hundreds. Making the poll return the
track would ship half a megabyte per second to every open browser to answer a
question whose answer is a single latitude. Two routes, two costs.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import Principal, require_scope
from app.core.security import SCOPE_DETECTIONS_READ, SCOPE_DRONE_INGEST
from app.db.session import get_db
from app.schemas.telemetry import (
    TelemetryIngest,
    TelemetryLatest,
    TelemetryRead,
    TelemetryTrack,
)
from app.services import mission_service, telemetry_repository
from app.services.broadcast import bus, telemetry_frame

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/missions", tags=["Telemetry"])

# How old the newest frame may be before it stops counting as live. Three beacon
# intervals plus slack: the drone sends at ~1 Hz, and a dashboard that flips to
# "offline" on one dropped packet is a dashboard nobody trusts. See
# `TelemetryLatest.live`.
TELEMETRY_LIVE_WINDOW_S = 5.0


async def _require_mission(db: AsyncSession, mission_id: int):
    """Resolve the mission or 404 with a message that names the problem."""
    mission = await mission_service.get_by_id(db, mission_id)
    if mission is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No mission with id {0}. Telemetry is filed against a flight, so "
                   "the mission must exist before the aircraft can report into it."
                   .format(mission_id),
        )
    return mission


@router.post(
    "/{mission_id}/telemetry",
    response_model=TelemetryRead,
    status_code=status.HTTP_201_CREATED,
    summary="Record one position frame",
)
async def ingest_telemetry(
    mission_id: int,
    body: TelemetryIngest,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DRONE_INGEST)),
) -> TelemetryRead:
    """Store one beaconed position frame from the aircraft.

    Append-only, with no idempotency key. A duplicate detection inflates a mine
    count, so those carry a client UUID and are deduplicated; a duplicate
    telemetry frame is one extra dot at 1 Hz, and defending against it would
    mean a unique constraint on a timestamp an unreliable drone clock produces.

    Scoped `drone:ingest`, same as the detection ingest path - this is the drone
    writing, and the dashboard key must not be able to forge a position.
    """
    mission = await _require_mission(db, mission_id)
    row = await telemetry_repository.create(db, mission_id, body)

    # Push to any open dashboard BEFORE returning. The write is already committed
    # by `create`, so a subscriber that reads this frame and then refreshes cannot
    # observe a position that is not yet in the database. Publishing is
    # non-blocking by construction (see `services/broadcast.py`): it cannot slow
    # the aircraft down, and it cannot fail this request.
    #
    # The frame is a whole `TelemetryLatest`, not the bare row, because that is the
    # payload the polling endpoint returns and the dashboard already knows how to
    # read it. The age is 0.0 by definition - this is the frame that just arrived -
    # and `live` is true for the same reason.
    bus.publish(
        mission_id,
        telemetry_frame(
            TelemetryLatest(
                found=True,
                mission_id=mission_id,
                mission_name=mission.name,
                telemetry=TelemetryRead.model_validate(row),
                age_s=0.0,
                live=True,
            )
        ),
    )

    return TelemetryRead.model_validate(row)


@router.get(
    "/{mission_id}/telemetry/latest",
    response_model=TelemetryLatest,
    summary="Newest position frame for a mission",
)
async def latest_telemetry(
    mission_id: int,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> TelemetryLatest:
    """Where the aircraft is now - the dashboard's polling endpoint.

    Returns 200 with `found=false` rather than 404 when nothing has arrived yet.
    That is deliberate: "this mission has no telemetry" is a normal state at the
    start of a flight and after one that never launched, and a 404 would force
    every client to treat a routine condition as an error - which is how the
    error handling that matters stops being written.

    A mission that does not exist at all is still a 404, because that IS a
    mistake worth surfacing.
    """
    mission = await _require_mission(db, mission_id)

    row = await telemetry_repository.latest(db, mission_id)
    age = telemetry_repository.age_seconds(row)

    return TelemetryLatest(
        found=row is not None,
        mission_id=mission_id,
        mission_name=mission.name,
        telemetry=TelemetryRead.model_validate(row) if row is not None else None,
        age_s=None if age is None else round(age, 2),
        # age is None only when row is None, and `found` already says so.
        live=age is not None and age <= TELEMETRY_LIVE_WINDOW_S,
    )


@router.get(
    "/{mission_id}/telemetry",
    response_model=TelemetryTrack,
    summary="Recent flight track for a mission",
)
async def mission_telemetry_track(
    mission_id: int,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
    limit: int = Query(
        default=600, ge=1,
        description="Most recent frames to return, returned oldest first.",
    ),
) -> TelemetryTrack:
    """The recent track, oldest first, for drawing the flown path.

    Default of 600 frames is ten minutes at 1 Hz: enough to fill the map's track
    without shipping a whole flight to a browser that only draws the recent part.
    The total is reported separately so the client can tell it is truncated.
    """
    limit = min(limit, settings.max_page_size * 10)
    mission = await _require_mission(db, mission_id)

    rows, total = await telemetry_repository.track(db, mission_id, limit=limit)
    return TelemetryTrack(
        mission_id=mission_id,
        mission_name=mission.name,
        count=len(rows),
        items=[TelemetryRead.model_validate(row) for row in rows],
    )
