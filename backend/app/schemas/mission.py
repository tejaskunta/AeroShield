"""AeroShield - mission schemas."""

from datetime import datetime
from typing import Dict, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.db.models.mission import MissionStatus


class MissionCreate(BaseModel):
    """POST /api/missions - get-or-create by name.

    Get-or-create rather than strict create: the drone calls this at every startup,
    including a reboot mid-flight. A 409 there would either abort the flight or push
    conflict-handling onto the Jetson, and neither is worth it when "same name means
    same mission" is exactly the intent.
    """

    model_config = ConfigDict(
        json_schema_extra={
            "example": {"name": "field-test-1", "description": "North paddock, 30m AGL grid"}
        }
    )

    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=5000)


class MissionUpdate(BaseModel):
    """PATCH /api/missions/{id} - every field optional; only what is sent is applied."""

    description: Optional[str] = Field(default=None, max_length=5000)
    status: Optional[MissionStatus] = None
    ended_at: Optional[datetime] = None


class MissionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: Optional[str]
    status: str
    started_at: datetime
    ended_at: Optional[datetime]
    created_at: datetime


class MissionStats(BaseModel):
    """GET /api/missions/{id}/stats.

    Built for the Week 11 report agent (PRD section 5.1: "pulls mission stats +
    detections from PostgreSQL"). Aggregated in SQL rather than by fetching every
    row and counting in Python - a long mission is tens of thousands of detections.
    """

    mission_id: int
    mission_name: str
    status: str

    total_detections: int
    geotagged_detections: int = Field(
        description="Detections with coordinates. The gap from total_detections is "
                    "how much of the flight had no usable GPS lock."
    )
    detections_with_images: int

    by_class: Dict[str, int] = Field(
        default_factory=dict, description="Detection count per class name"
    )
    mean_confidence: Optional[float] = None
    max_confidence: Optional[float] = None
    mean_horizontal_error_m: Optional[float] = Field(
        default=None,
        description="Average 1-sigma position error. Report this alongside any map, "
                    "per PRD section 10 - never imply pinpoint accuracy.",
    )

    first_detection_at: Optional[datetime] = None
    last_detection_at: Optional[datetime] = None
    duration_seconds: Optional[float] = Field(
        default=None, description="Span from first to last detection, not flight time"
    )

    bounds: Optional[Dict[str, float]] = Field(
        default=None,
        description="Bounding box of geotagged detections: min_lat/min_lon/max_lat/"
                    "max_lon. Use it to fit the map viewport on load.",
    )


class MissionListSummary(BaseModel):
    """GET /api/missions - list rows carrying a detection count.

    The count is included because a mission list with no counts is nearly useless on
    a dashboard, and fetching it per-row would be N+1 queries.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: Optional[str]
    status: str
    started_at: datetime
    ended_at: Optional[datetime]
    created_at: datetime
    detection_count: int = 0
