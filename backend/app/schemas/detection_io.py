"""AeroShield - detection ingest and read schemas.

Two distinct shapes, deliberately not one:

    DetectionIngest   what the drone sends. Trusts nothing, validates everything.
    DetectionRead     what the API returns. Includes server-assigned fields.

Reusing a single model for both is the usual shortcut and it goes wrong in two
ways: the client can then set server-owned fields like `id` and `created_at`, and
the OpenAPI schema (a Week 5 deliverable) stops describing either direction
accurately.

The existing schemas/detection.py is untouched - it belongs to the dev-only
POST /api/detect route and its response shape is documented in the README.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class DetectionIngest(BaseModel):
    """One detection, as posted by the Jetson to POST /api/detections.

    Mission resolution, in order:
        1. mission_id  - explicit, 404 if it does not exist
        2. mission_name - get-or-create by name
        3. neither      - stored unassigned

    The drone sends mission_name rather than relying on a pre-flight round trip, so
    a detection spooled during a link outage can still be filed against the right
    mission when it is replayed hours later.
    """

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "client_detection_id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
                "mission_name": "field-test-1",
                "class_name": "landmine_metal",
                "class_id": 0,
                "confidence": 0.87,
                "bbox_x1": 640, "bbox_y1": 360, "bbox_x2": 730, "bbox_y2": 450,
                "latitude": 12.9716214, "longitude": 77.5946101,
                "altitude_m": 942.5, "relative_altitude_m": 30.0,
                "heading_deg": 90.0, "gps_fix_type": 3, "satellites_visible": 14,
                "horizontal_error_m": 3.4,
                "frame_width": 1280, "frame_height": 720,
                "inference_ms": 71.2,
                "model_version": "best.engine",
                "source": "jetson-trt",
                "captured_at": "2026-08-23T09:14:22.481Z",
            }
        }
    )

    # --- idempotency ------------------------------------------------------
    client_detection_id: UUID = Field(
        description="Client-generated UUID. Re-posting the same value is a no-op, "
                    "which is what makes spool replay safe after a dropped link."
    )

    # --- mission ----------------------------------------------------------
    mission_id: Optional[int] = Field(default=None, ge=1)
    mission_name: Optional[str] = Field(default=None, min_length=1, max_length=200)

    # --- classification ---------------------------------------------------
    class_name: str = Field(min_length=1, max_length=100)
    class_id: int = Field(ge=0)
    confidence: float = Field(ge=0.0, le=1.0)

    # --- geometry in pixels ------------------------------------------------
    bbox_x1: int = Field(ge=0)
    bbox_y1: int = Field(ge=0)
    bbox_x2: int = Field(ge=0)
    bbox_y2: int = Field(ge=0)

    # --- position (all optional: no fix is a valid, recorded state) --------
    latitude: Optional[float] = Field(default=None, ge=-90.0, le=90.0)
    longitude: Optional[float] = Field(default=None, ge=-180.0, le=180.0)
    altitude_m: Optional[float] = None
    relative_altitude_m: Optional[float] = None
    heading_deg: Optional[float] = Field(default=None, ge=0.0, lt=360.0)
    gps_fix_type: Optional[int] = Field(default=None, ge=0, le=8)
    satellites_visible: Optional[int] = Field(default=None, ge=0, le=64)
    horizontal_error_m: Optional[float] = Field(
        default=None, ge=0.0,
        description="1-sigma horizontal error from jetson/geo.py. Drives the "
                    "uncertainty circle on the map instead of a false-precision pin.",
    )

    # --- frame / provenance ------------------------------------------------
    frame_width: Optional[int] = Field(default=None, ge=1)
    frame_height: Optional[int] = Field(default=None, ge=1)
    inference_ms: Optional[float] = Field(default=None, ge=0.0)
    model_version: Optional[str] = Field(default=None, max_length=200)
    source: Optional[str] = Field(default=None, max_length=100)

    captured_at: datetime = Field(
        description="When the FRAME was taken, from the drone's clock. Mission "
                    "timelines order by this, never by server insert time."
    )

    @model_validator(mode="after")
    def _check_bbox(self) -> "DetectionIngest":
        """A zero-area or inverted box means the client's coordinate maths is wrong.

        Rejecting it here produces a 422 naming the field, rather than a 500 from
        the database CHECK constraint further down.
        """
        if self.bbox_x2 <= self.bbox_x1 or self.bbox_y2 <= self.bbox_y1:
            raise ValueError(
                "bbox must satisfy x2 > x1 and y2 > y1 (got "
                "x1={0}, y1={1}, x2={2}, y2={3})".format(
                    self.bbox_x1, self.bbox_y1, self.bbox_x2, self.bbox_y2)
            )
        return self

    @model_validator(mode="after")
    def _check_latlon_pair(self) -> "DetectionIngest":
        """Both coordinates or neither.

        A latitude with no longitude silently becomes a point on the prime meridian
        in most consumers. In a system whose output is "go dig here", that is the
        dangerous direction to be wrong in.
        """
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError(
                "latitude and longitude must be provided together or both omitted"
            )
        return self

    @field_validator("captured_at")
    @classmethod
    def _require_timezone(cls, value: datetime) -> datetime:
        """Reject naive timestamps.

        The drone, the server and the operator's browser are routinely in different
        zones. A naive timestamp gets interpreted as whatever the reader assumes,
        and the mission timeline quietly shifts by hours.
        """
        if value.tzinfo is None:
            raise ValueError(
                "captured_at must include a timezone offset "
                "(e.g. 2026-08-23T09:14:22.481Z)"
            )
        return value


class MissionSummary(BaseModel):
    """Mission identity embedded in a detection, so the map needs no second call."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    status: str


class DetectionRead(BaseModel):
    """A stored detection, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    client_detection_id: UUID
    mission_id: Optional[int]
    mission: Optional[MissionSummary] = None

    class_name: str
    class_id: int
    confidence: float

    bbox_x1: int
    bbox_y1: int
    bbox_x2: int
    bbox_y2: int

    latitude: Optional[float]
    longitude: Optional[float]
    altitude_m: Optional[float]
    relative_altitude_m: Optional[float]
    heading_deg: Optional[float]
    gps_fix_type: Optional[int]
    satellites_visible: Optional[int]
    horizontal_error_m: Optional[float]

    image_path: Optional[str]
    frame_width: Optional[int]
    frame_height: Optional[int]

    inference_ms: Optional[float]
    model_version: Optional[str]
    source: Optional[str]

    captured_at: datetime
    created_at: datetime

    @property
    def is_geotagged(self) -> bool:
        return self.latitude is not None and self.longitude is not None


class DetectionIngestResult(BaseModel):
    """Ingest response.

    `duplicate` tells the client this exact detection was already stored, so a
    replayed spool can be distinguished from newly accepted work in the logs
    without diffing counts.
    """

    id: int
    client_detection_id: UUID
    mission_id: Optional[int]
    duplicate: bool = Field(
        default=False,
        description="True when client_detection_id already existed. The row was "
                    "not modified and no second detection was created.",
    )
    image_upload_url: str = Field(
        description="PUT the frame here. Separate request so a large image can "
                    "fail or retry without risking the metadata row."
    )


# --- GeoJSON -----------------------------------------------------------------
# Leaflet consumes GeoJSON natively (PRD section 7 locks React + Leaflet), so
# serving this shape means the Week 6 map needs no transform layer.

class GeoJSONGeometry(BaseModel):
    type: str = "Point"
    coordinates: List[float] = Field(
        description="[longitude, latitude] - GeoJSON is lon/lat order, the "
                    "reverse of how humans and most APIs write it (RFC 7946)."
    )


class GeoJSONFeature(BaseModel):
    type: str = "Feature"
    geometry: GeoJSONGeometry
    properties: Dict[str, Any]


class GeoJSONFeatureCollection(BaseModel):
    type: str = "FeatureCollection"
    features: List[GeoJSONFeature]
