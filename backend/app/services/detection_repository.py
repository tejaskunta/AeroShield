"""AeroShield - detection persistence.

The one place that writes the `geog` column. Detection.latitude/longitude and
Detection.geog are two representations of the same fact, so exactly one function is
allowed to set them - if they can only be written together, they cannot drift apart.
"""

import logging
from datetime import datetime, timezone
from typing import List, Optional, Sequence, Tuple
from uuid import UUID

from geoalchemy2 import WKTElement
from geoalchemy2.functions import ST_DWithin
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.detection import Detection
from app.schemas.detection_io import (
    DetectionIngest,
    GeoJSONFeature,
    GeoJSONFeatureCollection,
    GeoJSONGeometry,
)

logger = logging.getLogger(__name__)

WGS84 = 4326


def _point(latitude: Optional[float], longitude: Optional[float]) -> Optional[WKTElement]:
    """Build the PostGIS point for a lat/lon pair, or None when ungeotagged.

    WKT is "POINT(x y)" = "POINT(longitude latitude)". Getting that order backwards
    is the classic PostGIS bug: it produces coordinates that are valid, plausible and
    in the wrong hemisphere.
    """
    if latitude is None or longitude is None:
        return None
    return WKTElement("POINT({0} {1})".format(longitude, latitude), srid=WGS84)


async def create(db: AsyncSession, payload: DetectionIngest,
                 mission_id: Optional[int]) -> Tuple[Detection, bool]:
    """Insert one detection. Returns (detection, was_duplicate).

    Idempotent on client_detection_id via INSERT ... ON CONFLICT DO NOTHING. The
    drone retries after a dropped link and replays its offline spool on reconnect,
    so the same detection legitimately arrives more than once; without this, a
    mission's detection count would be inflated by however flaky the radio was.

    ON CONFLICT rather than a SELECT-then-INSERT because two spool replays running
    concurrently would both pass the check and one would then hit the unique
    constraint as a 500.
    """
    values = {
        "client_detection_id": payload.client_detection_id,
        "mission_id": mission_id,
        "class_name": payload.class_name,
        "class_id": payload.class_id,
        "confidence": payload.confidence,
        "bbox_x1": payload.bbox_x1,
        "bbox_y1": payload.bbox_y1,
        "bbox_x2": payload.bbox_x2,
        "bbox_y2": payload.bbox_y2,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "altitude_m": payload.altitude_m,
        "relative_altitude_m": payload.relative_altitude_m,
        "heading_deg": payload.heading_deg,
        "gps_fix_type": payload.gps_fix_type,
        "satellites_visible": payload.satellites_visible,
        "horizontal_error_m": payload.horizontal_error_m,
        "frame_width": payload.frame_width,
        "frame_height": payload.frame_height,
        "inference_ms": payload.inference_ms,
        "model_version": payload.model_version,
        "source": payload.source,
        "captured_at": payload.captured_at,
        # Derived here and nowhere else.
        "geog": _point(payload.latitude, payload.longitude),
    }

    stmt = (
        pg_insert(Detection)
        .values(**values)
        .on_conflict_do_nothing(index_elements=["client_detection_id"])
        .returning(Detection.id)
    )
    result = await db.execute(stmt)
    new_id = result.scalar_one_or_none()

    if new_id is not None:
        await db.commit()
        detection = await get(db, new_id)
        return detection, False

    # Already stored. Return the original row untouched - re-posting must not
    # overwrite a detection whose image has since been attached.
    await db.rollback()
    existing = await get_by_client_id(db, payload.client_detection_id)
    logger.info("duplicate ingest for client_detection_id=%s (existing id=%s)",
                payload.client_detection_id, existing.id if existing else None)
    return existing, True


async def get(db: AsyncSession, detection_id: int) -> Optional[Detection]:
    result = await db.execute(select(Detection).where(Detection.id == detection_id))
    return result.unique().scalar_one_or_none()


async def get_by_client_id(db: AsyncSession, client_id: UUID) -> Optional[Detection]:
    result = await db.execute(
        select(Detection).where(Detection.client_detection_id == client_id)
    )
    return result.unique().scalar_one_or_none()


async def list_detections(
    db: AsyncSession,
    limit: int,
    offset: int,
    mission_id: Optional[int] = None,
    class_name: Optional[str] = None,
    min_confidence: Optional[float] = None,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    near: Optional[Tuple[float, float, float]] = None,
    geotagged_only: bool = False,
) -> Tuple[Sequence[Detection], int]:
    """Filtered, paginated detections, newest frame first.

    `near` is (latitude, longitude, radius_metres) and uses ST_DWithin against the
    GiST-indexed geography column. Because the column is geography and not
    geometry, the radius really is metres - with geometry(4326) the same number
    would be interpreted as degrees and quietly match half the planet.
    """
    query = select(Detection)
    count_query = select(func.count(Detection.id))

    conditions = []
    if mission_id is not None:
        conditions.append(Detection.mission_id == mission_id)
    if class_name:
        conditions.append(Detection.class_name == class_name)
    if min_confidence is not None:
        conditions.append(Detection.confidence >= min_confidence)
    if since is not None:
        conditions.append(Detection.captured_at >= since)
    if until is not None:
        conditions.append(Detection.captured_at <= until)
    if geotagged_only:
        conditions.append(Detection.latitude.isnot(None))

    if near is not None:
        latitude, longitude, radius_m = near
        conditions.append(
            ST_DWithin(Detection.geog, _point(latitude, longitude), radius_m)
        )

    if conditions:
        query = query.where(*conditions)
        count_query = count_query.where(*conditions)

    # captured_at, not created_at: a spooled detection is inserted long after it was
    # seen, so insert order does not reflect the flight.
    query = query.order_by(Detection.captured_at.desc(), Detection.id.desc())
    query = query.limit(limit).offset(offset)

    rows = (await db.execute(query)).unique().scalars().all()
    total = (await db.execute(count_query)).scalar_one()
    return rows, total


async def attach_image(db: AsyncSession, detection: Detection, relative_path: str) -> Detection:
    """Record the stored frame's path against a detection."""
    detection.image_path = relative_path
    await db.commit()
    await db.refresh(detection)
    return detection


async def attach_gradcam(db: AsyncSession, detection: Detection,
                         relative_path: str) -> Detection:
    """Record the Grad-CAM heatmap's path against a detection.

    Same idempotent overwrite semantics as attach_image: re-running the
    explainability pass for a frame replaces the previous heatmap rather than
    accumulating versions. The model_version on the row tells you which weights an
    overlay came from.
    """
    detection.gradcam_path = relative_path
    await db.commit()
    await db.refresh(detection)
    return detection


async def set_review(db: AsyncSession, detection: Detection, state: str,
                     reason: Optional[str], reviewed_by: str) -> Detection:
    """Apply a human adjudication to a detection (PRD 5.1 review workflow).

    The timestamp is taken here, server-side, at write time - not from the client.
    An audit trail whose times come from the party being audited is not a trail.
    `reviewed_by` is the caller's API-key name, injected by the endpoint from the
    authenticated Principal for the same reason.
    """
    detection.review_state = state
    detection.review_reason = reason
    detection.reviewed_by = reviewed_by
    detection.reviewed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(detection)
    return detection


async def review_tallies(db: AsyncSession,
                         mission_id: Optional[int]) -> "dict[str, int]":
    """Count a mission's detections by review state, for the report's headline row.

    COALESCE maps NULL (never reviewed) to 'unreviewed' so the four states the report
    and dashboard understand are all present, and the caller never has to know that
    the database stores the default as NULL. A mission with no detections returns all
    zeros rather than an empty dict, so the report template can index every key.
    """
    state = func.coalesce(Detection.review_state, "unreviewed")
    query = (
        select(state.label("state"), func.count(Detection.id))
        .group_by("state")
    )
    if mission_id is not None:
        query = query.where(Detection.mission_id == mission_id)

    rows = (await db.execute(query)).all()
    tallies = {"total": 0, "confirmed": 0, "dismissed": 0, "flagged": 0, "unreviewed": 0}
    for name, count in rows:
        tallies["total"] += count
        if name in tallies:
            tallies[name] = count
    return tallies


async def delete(db: AsyncSession, detection: Detection) -> None:
    """Remove a detection row. The caller deletes the image file."""
    await db.delete(detection)
    await db.commit()


async def to_geojson(detections: Sequence[Detection]) -> GeoJSONFeatureCollection:
    """Build a FeatureCollection for the Week 6 Leaflet map.

    Ungeotagged detections are omitted: GeoJSON has no way to express "this exists
    but has no location", and emitting them at [0, 0] would put a phantom cluster in
    the Gulf of Guinea. The count difference is available from
    GET /api/missions/{id}/stats, which reports total vs geotagged explicitly.
    """
    features: List[GeoJSONFeature] = []
    for detection in detections:
        if detection.latitude is None or detection.longitude is None:
            continue
        features.append(
            GeoJSONFeature(
                geometry=GeoJSONGeometry(
                    # RFC 7946 order: longitude first.
                    coordinates=[detection.longitude, detection.latitude]
                ),
                properties={
                    "id": detection.id,
                    "mission_id": detection.mission_id,
                    "class_name": detection.class_name,
                    "class_id": detection.class_id,
                    "confidence": detection.confidence,
                    # Drives the uncertainty circle. A bare pin overstates what an
                    # RGB drone at 30 m can actually tell you (PRD section 10).
                    "horizontal_error_m": detection.horizontal_error_m,
                    "relative_altitude_m": detection.relative_altitude_m,
                    "gps_fix_type": detection.gps_fix_type,
                    "satellites_visible": detection.satellites_visible,
                    "captured_at": detection.captured_at.isoformat(),
                    "has_image": detection.image_path is not None,
                    "image_url": (
                        "/api/detections/{0}/image".format(detection.id)
                        if detection.image_path else None
                    ),
                    # The map colours markers by review state (confirmed = red,
                    # dismissed = grey, etc.), so the risk picture reflects human
                    # adjudication, not raw model output. NULL (never reviewed) is
                    # presented as 'unreviewed' to match the read schema.
                    "review_state": detection.review_state or "unreviewed",
                    "has_gradcam": detection.gradcam_path is not None,
                    "gradcam_url": (
                        "/api/detections/{0}/gradcam".format(detection.id)
                        if detection.gradcam_path else None
                    ),
                },
            )
        )
    return GeoJSONFeatureCollection(features=features)
