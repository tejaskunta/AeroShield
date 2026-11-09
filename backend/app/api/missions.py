"""AeroShield - mission endpoints."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import Principal, require_scope
from app.core.security import SCOPE_DETECTIONS_READ, SCOPE_MISSIONS_WRITE
from app.db.models.mission import MissionStatus
from app.db.session import get_db
from app.schemas.common import Page
from app.schemas.mission import (
    MissionCreate,
    MissionListSummary,
    MissionRead,
    MissionStats,
    MissionUpdate,
)
from app.services import mission_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/missions", tags=["Missions"])


@router.post("", response_model=MissionRead, summary="Create or join a mission")
async def create_mission(
    body: MissionCreate,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_MISSIONS_WRITE)),
) -> MissionRead:
    """Get-or-create by name.

    Returns 201 when the mission was created and 200 when it already existed, so a
    client can tell the difference - but neither is an error. The drone calls this on
    every startup, and a reboot mid-flight must rejoin the existing mission rather
    than fail or fork it.
    """
    mission, created = await mission_service.get_or_create(db, body.name, body.description)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return MissionRead.model_validate(mission)


@router.get("", response_model=Page[MissionListSummary], summary="List missions")
async def list_missions(
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
    status_filter: Optional[MissionStatus] = Query(
        default=None, alias="status", description="Filter by lifecycle status"
    ),
    limit: int = Query(default=None, ge=1),
    offset: int = Query(default=0, ge=0),
) -> Page[MissionListSummary]:
    """Newest first, each row carrying its detection count."""
    limit = min(limit or settings.default_page_size, settings.max_page_size)
    items, total = await mission_service.list_missions(
        db, limit=limit, offset=offset,
        status=status_filter.value if status_filter else None,
    )
    return Page[MissionListSummary](
        items=[MissionListSummary(**item) for item in items],
        total=total, limit=limit, offset=offset,
    )


@router.get("/{mission_id}", response_model=MissionRead, summary="Get one mission")
async def get_mission(
    mission_id: int,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> MissionRead:
    mission = await mission_service.get_by_id(db, mission_id)
    if mission is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No mission with id {0}".format(mission_id),
        )
    return MissionRead.model_validate(mission)


@router.patch("/{mission_id}", response_model=MissionRead, summary="Update a mission")
async def update_mission(
    mission_id: int,
    body: MissionUpdate,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_MISSIONS_WRITE)),
) -> MissionRead:
    """Partial update - typically closing a mission when the flight ends.

    Setting status to completed/aborted stamps ended_at automatically if it is still
    empty, so the report agent always has a duration to work with.
    """
    mission = await mission_service.get_by_id(db, mission_id)
    if mission is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No mission with id {0}".format(mission_id),
        )

    updated = await mission_service.update_mission(
        db, mission,
        description=body.description,
        status=body.status.value if body.status else None,
        ended_at=body.ended_at,
    )
    return MissionRead.model_validate(updated)


@router.get("/{mission_id}/stats", response_model=MissionStats, summary="Mission statistics")
async def get_mission_stats(
    mission_id: int,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> MissionStats:
    """Aggregates for the dashboard and the Week 11 report agent.

    Note `total_detections` vs `geotagged_detections`: the gap is how much of the
    flight produced detections with no usable GPS lock. Reporting only the total
    would overstate what is actually mappable.
    """
    mission = await mission_service.get_by_id(db, mission_id)
    if mission is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No mission with id {0}".format(mission_id),
        )
    return await mission_service.compute_stats(db, mission)
