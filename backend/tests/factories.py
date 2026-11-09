"""AeroShield - shared test data builders."""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional


def detection_payload(
    mission_name: Optional[str] = "test-mission",
    mission_id: Optional[int] = None,
    client_detection_id: Optional[str] = None,
    latitude: Optional[float] = 12.9716214,
    longitude: Optional[float] = 77.5946101,
    confidence: float = 0.87,
    class_name: str = "landmine_metal",
    class_id: int = 0,
    captured_at: Optional[datetime] = None,
    minutes_ago: float = 0.0,
    **overrides,
) -> dict:
    """A valid DetectionIngest body, with any field overridable.

    Defaults describe the normal case: a 3D GPS fix over Bangalore at 30 m AGL.
    Pass latitude=None, longitude=None for the ungeotagged case.
    """
    if captured_at is None:
        captured_at = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)

    payload = {
        "client_detection_id": client_detection_id or str(uuid.uuid4()),
        "class_name": class_name,
        "class_id": class_id,
        "confidence": confidence,
        "bbox_x1": 640, "bbox_y1": 360, "bbox_x2": 730, "bbox_y2": 450,
        "latitude": latitude,
        "longitude": longitude,
        "altitude_m": 942.5,
        "relative_altitude_m": 30.0,
        "heading_deg": 90.0,
        "gps_fix_type": 3,
        "satellites_visible": 14,
        "horizontal_error_m": 3.4,
        "frame_width": 1280,
        "frame_height": 720,
        "inference_ms": 71.2,
        "model_version": "best.engine",
        "source": "jetson-trt",
        "captured_at": captured_at.isoformat() if isinstance(captured_at, datetime) else captured_at,
    }

    if mission_id is not None:
        payload["mission_id"] = mission_id
    elif mission_name is not None:
        payload["mission_name"] = mission_name

    payload.update(overrides)
    return payload


# Smallest bytes that pass storage.sniff_image_type. Not a decodable image - the
# storage layer checks magic bytes and size, and never decodes, so this is enough
# and keeps a binary fixture out of the repo.
MINIMAL_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 128
MINIMAL_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 128
NOT_AN_IMAGE = b"this is plainly not an image" * 4
