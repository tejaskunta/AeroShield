"""AeroShield - telemetry persistence.

The one place that writes `telemetry.geog`. Telemetry.latitude/longitude and
Telemetry.geog are two representations of the same fact, so exactly one function
sets them - if they can only be written together, they cannot drift apart. Same
rule, and the same reason, as detection_repository.

NO IDEMPOTENCY KEY HERE, on purpose. Detections carry a client-generated UUID
because a detection that arrives twice would inflate a mine count, which is a
safety-relevant lie. A telemetry frame that arrives twice is a duplicate dot at
1 Hz - harmless, and cheaper to accept than to defend against. The drone sends
a fresh frame every second and never replays the spool for these.
"""

import logging
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from geoalchemy2 import WKTElement
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.telemetry import Telemetry
from app.schemas.telemetry import TelemetryIngest

logger = logging.getLogger(__name__)

WGS84 = 4326


def _point(latitude: float, longitude: float) -> WKTElement:
    """Build the PostGIS point. WKT is "POINT(x y)" = "POINT(longitude latitude)".

    Writing that order the other way round is the classic PostGIS bug: the result
    is a valid, plausible coordinate in the wrong hemisphere.
    """
    return WKTElement("POINT({0} {1})".format(longitude, latitude), srid=WGS84)


async def create(db: AsyncSession, mission_id: int,
                 payload: TelemetryIngest) -> Telemetry:
    """Insert one telemetry frame. Never upserts - every frame is a data point."""
    row = Telemetry(
        mission_id=mission_id,
        latitude=payload.latitude,
        longitude=payload.longitude,
        geog=_point(payload.latitude, payload.longitude),
        altitude_m=payload.altitude_m,
        relative_altitude_m=payload.relative_altitude_m,
        heading_deg=payload.heading_deg,
        ground_speed_ms=payload.ground_speed_ms,
        gps_fix_type=payload.gps_fix_type,
        satellites_visible=payload.satellites_visible,
        battery_pct=payload.battery_pct,
        battery_volts=payload.battery_volts,
        link_pct=payload.link_pct,
        flight_mode=payload.flight_mode,
        armed=payload.armed,
        captured_at=payload.captured_at,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def latest(db: AsyncSession, mission_id: int) -> Optional[Telemetry]:
    """The newest frame for a mission, ordered by captured_at.

    Explicitly NOT by id or created_at. A frame spooled during a link outage is
    inserted late, so the highest id can easily be an old position - and a
    dashboard that shows the aircraft jumping backwards has a bug nobody will
    believe is a clock problem.

    Ordered by captured_at DESC with id DESC as the tiebreak: two frames inside
    the same millisecond are possible at 1 Hz only if the clock is coarse, and
    picking the later insert is right in that case.
    """
    stmt = (
        select(Telemetry)
        .where(Telemetry.mission_id == mission_id)
        .order_by(Telemetry.captured_at.desc(), Telemetry.id.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def track(db: AsyncSession, mission_id: int, limit: int = 600) -> Tuple[List[Telemetry], int]:
    """The most recent `limit` frames, returned OLDEST FIRST.

    Returns (rows, total). Reversed before returning rather than at the call site,
    because every consumer draws a polyline and a track that renders backwards
    from the aircraft is a bug that looks like a GPS fault.

    The total is a separate COUNT rather than len(rows): the dashboard wants to say
    "showing the last 600 of 2,431", and len(rows) silently equals the limit.
    """
    # COUNT in SQL, not len(rows). Counting in Python means loading every id of a
    # long flight into memory to produce a number the database already knows.
    total_stmt = select(func.count()).select_from(Telemetry).where(
        Telemetry.mission_id == mission_id
    )
    total = int((await db.execute(total_stmt)).scalar_one())

    stmt = (
        select(Telemetry)
        .where(Telemetry.mission_id == mission_id)
        .order_by(Telemetry.captured_at.desc(), Telemetry.id.desc())
        .limit(limit)
    )
    rows = list((await db.execute(stmt)).scalars().all())
    rows.reverse()
    return rows, total


async def prune(db: AsyncSession, mission_id: int, keep: int) -> int:
    """Delete all but the newest `keep` frames. Returns how many went.

    Unused by the API. It exists because the retention question in the model's
    docstring needs an answer that is not "write a migration later": a scheduled
    job or an ops command can call this once a flight is closed. Kept honest by
    being tested rather than by being aspirational.
    """
    keep_ids = (
        select(Telemetry.id)
        .where(Telemetry.mission_id == mission_id)
        .order_by(Telemetry.captured_at.desc(), Telemetry.id.desc())
        .limit(keep)
        .subquery()
    )
    stmt = delete(Telemetry).where(
        Telemetry.mission_id == mission_id,
        Telemetry.id.notin_(select(keep_ids.c.id)),
    )
    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount or 0


def age_seconds(row: Optional[Telemetry], now: Optional[datetime] = None) -> Optional[float]:
    """How old a frame is, in seconds, or None when there is no frame.

    `now` is injectable so the live-window decision is testable without sleeping.
    """
    if row is None:
        return None
    reference = now or datetime.now(timezone.utc)
    captured = row.captured_at
    # A naive datetime out of the driver is assumed UTC. Postgres hands back
    # tz-aware for timestamptz, but a row built in-process (tests) is naive, and
    # subtracting the two raises rather than returning a wrong number.
    if captured.tzinfo is None:
        captured = captured.replace(tzinfo=timezone.utc)
    return (reference - captured).total_seconds()
