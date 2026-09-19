"""AeroShield - mission service: get-or-create, listing and statistics."""

import logging
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from sqlalchemy import Float, Integer, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.detection import Detection
from app.db.models.mission import Mission
from app.schemas.mission import MissionStats

logger = logging.getLogger(__name__)


async def get_or_create(db: AsyncSession, name: str,
                        description: Optional[str] = None) -> Tuple[Mission, bool]:
    """Fetch a mission by name, creating it if absent. Returns (mission, created).

    Uses INSERT ... ON CONFLICT DO NOTHING rather than a SELECT-then-INSERT. The
    drone and the dashboard can both register the same mission at the same moment,
    and check-then-act would raise a unique-violation for one of them. Pushing the
    race into the database makes it a non-event.
    """
    stmt = (
        pg_insert(Mission)
        .values(name=name, description=description)
        .on_conflict_do_nothing(index_elements=["name"])
        .returning(Mission.id)
    )
    result = await db.execute(stmt)
    new_id = result.scalar_one_or_none()

    if new_id is not None:
        await db.commit()
        mission = await db.get(Mission, new_id)
        logger.info("created mission %s (id=%s)", name, new_id)
        return mission, True

    # Conflict: it already existed. Roll back the no-op insert before reading, so
    # the session is not left in a half-open transaction.
    await db.rollback()
    existing = await db.execute(select(Mission).where(Mission.name == name))
    mission = existing.scalar_one()
    return mission, False


async def get_by_id(db: AsyncSession, mission_id: int) -> Optional[Mission]:
    return await db.get(Mission, mission_id)


async def list_missions(db: AsyncSession, limit: int, offset: int,
                        status: Optional[str] = None) -> Tuple[List[dict], int]:
    """Paginated missions, each with its detection count.

    The count comes from a LEFT JOIN aggregate in the same query - fetching it
    per-row would be the classic N+1, and a dashboard listing 50 missions would
    issue 51 queries.
    """
    count_subq = (
        select(Detection.mission_id, func.count(Detection.id).label("n"))
        .group_by(Detection.mission_id)
        .subquery()
    )

    query = (
        select(Mission, func.coalesce(count_subq.c.n, 0).label("detection_count"))
        .outerjoin(count_subq, count_subq.c.mission_id == Mission.id)
    )
    total_query = select(func.count(Mission.id))

    if status:
        query = query.where(Mission.status == status)
        total_query = total_query.where(Mission.status == status)

    query = query.order_by(Mission.started_at.desc()).limit(limit).offset(offset)

    rows = (await db.execute(query)).all()
    total = (await db.execute(total_query)).scalar_one()

    items = []
    for mission, detection_count in rows:
        items.append({
            "id": mission.id,
            "name": mission.name,
            "description": mission.description,
            "status": mission.status,
            "started_at": mission.started_at,
            "ended_at": mission.ended_at,
            "created_at": mission.created_at,
            "detection_count": detection_count,
        })
    return items, total


async def update_mission(db: AsyncSession, mission: Mission,
                         description: Optional[str] = None,
                         status: Optional[str] = None,
                         ended_at: Optional[datetime] = None) -> Mission:
    """Apply a partial update. Only non-None fields are touched."""
    if description is not None:
        mission.description = description
    if status is not None:
        mission.status = status
        # Closing a mission without an explicit end time: stamp it now, so the
        # report agent always has a duration to work with.
        if status in ("completed", "aborted") and mission.ended_at is None and ended_at is None:
            mission.ended_at = datetime.now(timezone.utc)
    if ended_at is not None:
        mission.ended_at = ended_at

    await db.commit()
    await db.refresh(mission)
    return mission


async def compute_stats(db: AsyncSession, mission: Mission) -> MissionStats:
    """Aggregate one mission's detections.

    Everything is computed in SQL. A long grid survey produces tens of thousands of
    detections, and pulling them all into Python to count would make this endpoint
    the slowest thing in the app - which matters because Week 11's report agent
    calls it on every report.
    """
    where = Detection.mission_id == mission.id

    totals = (
        await db.execute(
            select(
                func.count(Detection.id),
                # COUNT over a nullable column counts only non-NULLs, which is
                # exactly the geotagged subset.
                func.count(Detection.latitude),
                func.count(Detection.image_path),
                func.avg(Detection.confidence).cast(Float),
                func.max(Detection.confidence).cast(Float),
                func.avg(Detection.horizontal_error_m).cast(Float),
                func.min(Detection.captured_at),
                func.max(Detection.captured_at),
            ).where(where)
        )
    ).one()

    (total, geotagged, with_images, mean_conf, max_conf,
     mean_err, first_at, last_at) = totals

    by_class_rows = (
        await db.execute(
            select(Detection.class_name, func.count(Detection.id).cast(Integer))
            .where(where)
            .group_by(Detection.class_name)
            .order_by(func.count(Detection.id).desc())
        )
    ).all()

    bounds = None
    if geotagged:
        bounds_row = (
            await db.execute(
                select(
                    func.min(Detection.latitude),
                    func.min(Detection.longitude),
                    func.max(Detection.latitude),
                    func.max(Detection.longitude),
                ).where(where, Detection.latitude.isnot(None))
            )
        ).one()
        bounds = {
            "min_lat": bounds_row[0],
            "min_lon": bounds_row[1],
            "max_lat": bounds_row[2],
            "max_lon": bounds_row[3],
        }

    duration = None
    if first_at and last_at:
        duration = (last_at - first_at).total_seconds()

    return MissionStats(
        mission_id=mission.id,
        mission_name=mission.name,
        status=mission.status,
        total_detections=total or 0,
        geotagged_detections=geotagged or 0,
        detections_with_images=with_images or 0,
        by_class={name: count for name, count in by_class_rows},
        mean_confidence=round(mean_conf, 4) if mean_conf is not None else None,
        max_confidence=round(max_conf, 4) if max_conf is not None else None,
        mean_horizontal_error_m=round(mean_err, 2) if mean_err is not None else None,
        first_detection_at=first_at,
        last_detection_at=last_at,
        duration_seconds=duration,
        bounds=bounds,
    )
