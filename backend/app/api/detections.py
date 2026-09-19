"""AeroShield - canonical detection endpoints.

This is the PRD section 8 ingest path: the Jetson runs YOLO onboard, geotags the
result, and POSTs the finished detection here. The backend records; it does not
infer. PRD section 2.2 puts cloud inference explicitly out of scope, so there is no
model on the server.

The older POST /api/detect (singular, in api/detection.py) uploads an image and runs
a mock detector. It is kept as a dev tool and tagged as such.
"""

import logging
from datetime import datetime
from typing import Optional, Tuple

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import Principal, require_scope
from app.core.security import SCOPE_ADMIN, SCOPE_DETECTIONS_READ, SCOPE_DRONE_INGEST
from app.db.session import get_db
from app.schemas.common import Message, Page
from app.schemas.detection_io import (
    DetectionIngest,
    DetectionIngestResult,
    DetectionRead,
    GeoJSONFeatureCollection,
)
from app.services import detection_repository, mission_service, storage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/detections", tags=["Detections"])


def _parse_near(near: Optional[str]) -> Optional[Tuple[float, float, float]]:
    """Parse "lat,lon,radius_m" into a tuple, with an error a human can act on."""
    if not near:
        return None

    parts = [part.strip() for part in near.split(",")]
    if len(parts) != 3:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="near must be 'latitude,longitude,radius_metres' "
                   "(e.g. near=12.9716,77.5946,500). Got {0} value(s).".format(len(parts)),
        )

    try:
        latitude, longitude, radius = (float(parts[0]), float(parts[1]), float(parts[2]))
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="near values must be numbers: 'latitude,longitude,radius_metres'.",
        )

    if not -90.0 <= latitude <= 90.0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="near latitude {0} is outside -90..90. Note the order is "
                   "lat,lon - not the lon,lat order GeoJSON uses.".format(latitude),
        )
    if not -180.0 <= longitude <= 180.0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="near longitude {0} is outside -180..180.".format(longitude),
        )
    if radius <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="near radius must be greater than 0 metres.",
        )

    return latitude, longitude, radius


async def _resolve_mission_id(db: AsyncSession, payload: DetectionIngest) -> Optional[int]:
    """Work out which mission this detection belongs to.

    mission_id wins if given; otherwise mission_name is get-or-created. Neither is
    also valid - the detection is stored unassigned rather than rejected, because a
    detection that arrives without mission context is still evidence.
    """
    if payload.mission_id is not None:
        mission = await mission_service.get_by_id(db, payload.mission_id)
        if mission is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No mission with id {0}. Send mission_name instead to have it "
                       "created automatically.".format(payload.mission_id),
            )
        return mission.id

    if payload.mission_name:
        mission, _ = await mission_service.get_or_create(db, payload.mission_name)
        return mission.id

    return None


@router.post(
    "",
    response_model=DetectionIngestResult,
    status_code=status.HTTP_201_CREATED,
    summary="Ingest a detection from the drone",
)
async def ingest_detection(
    payload: DetectionIngest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DRONE_INGEST)),
) -> DetectionIngestResult:
    """Record one detection produced onboard the Jetson.

    Idempotent on client_detection_id. A replayed detection returns 200 with
    duplicate=true rather than 409: the drone retries after a dropped link and
    drains its offline spool on reconnect, and a 4xx there would make it treat
    successfully-stored work as a failure and keep retrying forever.

    The image is NOT part of this request. PUT it to
    /api/detections/{id}/image afterwards, so a large frame can fail independently
    of the small metadata row that actually matters.
    """
    mission_id = await _resolve_mission_id(db, payload)
    detection, duplicate = await detection_repository.create(db, payload, mission_id)

    if detection is None:
        # Only reachable if the row vanished between the conflicting insert and the
        # read-back - a concurrent delete. Nothing sensible to return.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Detection could not be stored or retrieved after an insert "
                   "conflict. Retry the request.",
        )

    if duplicate:
        response.status_code = status.HTTP_200_OK

    return DetectionIngestResult(
        id=detection.id,
        client_detection_id=detection.client_detection_id,
        mission_id=detection.mission_id,
        duplicate=duplicate,
        image_upload_url="/api/detections/{0}/image".format(detection.id),
    )


# IMPORTANT: /geojson is declared before /{detection_id}. FastAPI matches routes in
# declaration order, so the parameterised route would otherwise swallow "geojson"
# and fail trying to parse it as an integer.
@router.get(
    "/geojson",
    response_model=GeoJSONFeatureCollection,
    summary="Detections as GeoJSON for the map",
)
async def detections_geojson(
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
    mission_id: Optional[int] = Query(default=None, ge=1),
    class_name: Optional[str] = None,
    min_confidence: Optional[float] = Query(default=None, ge=0.0, le=1.0),
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    near: Optional[str] = Query(
        default=None, description="latitude,longitude,radius_metres"
    ),
    limit: int = Query(default=None, ge=1),
) -> GeoJSONFeatureCollection:
    """A FeatureCollection Leaflet can consume directly (PRD section 7).

    Ungeotagged detections are omitted - GeoJSON cannot express "exists but has no
    location", and emitting them at [0, 0] would draw a phantom cluster off West
    Africa. Use /api/missions/{id}/stats to see the total-vs-geotagged split.
    """
    limit = min(limit or settings.max_page_size, settings.max_page_size)
    detections, _total = await detection_repository.list_detections(
        db,
        limit=limit,
        offset=0,
        mission_id=mission_id,
        class_name=class_name,
        min_confidence=min_confidence,
        since=since,
        until=until,
        near=_parse_near(near),
        geotagged_only=True,
    )
    return await detection_repository.to_geojson(detections)


@router.get("", response_model=Page[DetectionRead], summary="List detections")
async def list_detections(
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
    mission_id: Optional[int] = Query(default=None, ge=1),
    class_name: Optional[str] = Query(default=None, description="Exact class name match"),
    min_confidence: Optional[float] = Query(default=None, ge=0.0, le=1.0),
    since: Optional[datetime] = Query(
        default=None, description="captured_at >= this (ISO-8601 with offset)"
    ),
    until: Optional[datetime] = Query(default=None, description="captured_at <= this"),
    near: Optional[str] = Query(
        default=None,
        description="Proximity filter 'latitude,longitude,radius_metres' via PostGIS "
                    "ST_DWithin. Radius is METRES.",
    ),
    geotagged_only: bool = Query(
        default=False, description="Exclude detections with no GPS lock"
    ),
    limit: int = Query(default=None, ge=1),
    offset: int = Query(default=0, ge=0),
) -> Page[DetectionRead]:
    """Filtered and paginated, ordered by capture time descending.

    Ordered by captured_at, not created_at: a spooled detection is inserted long
    after it was seen, so insertion order does not reflect the flight.
    """
    limit = min(limit or settings.default_page_size, settings.max_page_size)

    detections, total = await detection_repository.list_detections(
        db,
        limit=limit,
        offset=offset,
        mission_id=mission_id,
        class_name=class_name,
        min_confidence=min_confidence,
        since=since,
        until=until,
        near=_parse_near(near),
        geotagged_only=geotagged_only,
    )
    return Page[DetectionRead](
        items=[DetectionRead.model_validate(d) for d in detections],
        total=total, limit=limit, offset=offset,
    )


@router.get("/{detection_id}", response_model=DetectionRead, summary="Get one detection")
async def get_detection(
    detection_id: int,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> DetectionRead:
    detection = await detection_repository.get(db, detection_id)
    if detection is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No detection with id {0}".format(detection_id),
        )
    return DetectionRead.model_validate(detection)


@router.put(
    "/{detection_id}/image",
    response_model=DetectionRead,
    summary="Attach the source frame",
)
async def upload_detection_image(
    detection_id: int,
    image: UploadFile = File(..., description="The unannotated source frame, JPEG or PNG"),
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DRONE_INGEST)),
) -> DetectionRead:
    """Store the frame this detection came from.

    A separate request from the metadata POST on purpose: the JSON is small and must
    not be lost, the JPEG is large and can be retried or abandoned independently.

    Idempotent - re-uploading replaces the file in place. The frame should be the
    CLEAN capture with no annotations burned in; Week 7's Grad-CAM overlay needs the
    original pixels.
    """
    detection = await detection_repository.get(db, detection_id)
    if detection is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No detection with id {0}. POST the detection before its image."
                   .format(detection_id),
        )

    data = await image.read()
    relative_path = storage.save_detection_image(
        data, detection_id=detection.id, mission_id=detection.mission_id
    )
    updated = await detection_repository.attach_image(db, detection, relative_path)
    return DetectionRead.model_validate(updated)


@router.get("/{detection_id}/image", summary="Fetch the stored frame")
async def get_detection_image(
    detection_id: int,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> FileResponse:
    """Serve the stored frame.

    Served through the app so the same scope check applies to the image as to the
    detection. In production, put a reverse proxy in front - streaming files from
    the ASGI worker does not scale, but correctness first.
    """
    detection = await detection_repository.get(db, detection_id)
    if detection is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No detection with id {0}".format(detection_id),
        )
    if not detection.image_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Detection {0} has no image. The drone may have run with "
                   "--no-images, or the upload never completed.".format(detection_id),
        )

    path = storage.resolve_image_path(detection.image_path)
    if path is None:
        # Row says there is a file and there is not. Worth surfacing distinctly from
        # "no image recorded" - it means storage and database have diverged.
        logger.error("detection %s references missing file %s",
                     detection_id, detection.image_path)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image file for detection {0} is recorded but missing from "
                   "storage.".format(detection_id),
        )

    media_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(path, media_type=media_type)


@router.delete("/{detection_id}", response_model=Message, summary="Delete a detection")
async def delete_detection(
    detection_id: int,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_ADMIN)),
) -> Message:
    """Remove a detection and its frame - false-positive triage.

    Admin-scoped. Deleting evidence from a safety system should require the highest
    privilege in the system, and the drone's ingest key deliberately cannot do it.
    """
    detection = await detection_repository.get(db, detection_id)
    if detection is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No detection with id {0}".format(detection_id),
        )

    image_path = detection.image_path
    await detection_repository.delete(db, detection)
    # After the row, so a failed file delete cannot leave an orphaned row pointing
    # at nothing. An orphaned file is harmless by comparison.
    storage.delete_detection_image(image_path)

    logger.info("deleted detection %s", detection_id)
    return Message(detail="Detection {0} deleted.".format(detection_id))
