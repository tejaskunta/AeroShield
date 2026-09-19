"""AeroShield - detection image storage.

Frames go on the filesystem; the database stores a RELATIVE path. Two reasons not
to put the bytes in Postgres: a mission produces thousands of ~200 KB JPEGs, which
bloats the table and every backup of it, and PRD section 5.1 needs to read these
files directly to compute Grad-CAM overlays in Week 7.

Relative and not absolute, because an absolute path breaks the moment the app moves
into a container with a different mount point - and the Week 12 deliverable is
Docker Compose.
"""

import logging
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, status

from app.core.config import settings

logger = logging.getLogger(__name__)

# Magic bytes, checked instead of trusting the client's Content-Type header - that
# header is whatever the client chose to send. This endpoint takes uploads from a
# field device over an unreliable link; a truncated or garbled body should be
# rejected here, not discovered in Week 7 when Grad-CAM cannot decode it.
IMAGE_SIGNATURES = {
    b"\xff\xd8\xff": "jpg",             # JPEG
    b"\x89PNG\r\n\x1a\n": "png",        # PNG
}


def sniff_image_type(data: bytes) -> Optional[str]:
    """Return 'jpg'/'png' from the leading bytes, or None if it is neither."""
    for signature, extension in IMAGE_SIGNATURES.items():
        if data.startswith(signature):
            return extension
    return None


def _storage_root() -> Path:
    root = settings.storage_path / "detections"
    root.mkdir(parents=True, exist_ok=True)
    return root


def validate_image(data: bytes) -> str:
    """Check size and format. Raises HTTPException with an actionable message."""
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded image is empty.",
        )

    if len(data) > settings.max_image_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Image is {0:.1f} MB; the limit is {1} MB. Raise "
                   "AEROSHIELD_MAX_IMAGE_MB or lower --jpeg-quality on the drone."
                   .format(len(data) / (1024 * 1024), settings.max_image_mb),
        )

    extension = sniff_image_type(data)
    if extension is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Body is not a JPEG or PNG (checked by magic bytes, not by "
                   "Content-Type). A truncated upload also lands here.",
        )
    return extension


def save_detection_image(data: bytes, detection_id: int,
                         mission_id: Optional[int] = None) -> str:
    """Write one frame, returning its path relative to the storage root.

    Partitioned by mission so a directory listing stays navigable, and named by
    detection id so the mapping is unambiguous in both directions. Writing is
    idempotent: re-uploading the image for the same detection overwrites in place
    rather than accumulating copies.
    """
    extension = validate_image(data)

    subdir = "mission-{0}".format(mission_id) if mission_id else "unassigned"
    directory = _storage_root() / subdir
    directory.mkdir(parents=True, exist_ok=True)

    filename = "detection-{0}.{1}".format(detection_id, extension)
    path = directory / filename

    # Write to a temporary name then rename. An interrupted upload must not leave a
    # truncated file that the dashboard renders as a broken image.
    tmp_path = path.with_suffix(path.suffix + ".part")
    tmp_path.write_bytes(data)
    tmp_path.replace(path)

    relative = str(Path("detections") / subdir / filename)
    logger.info("stored detection image %s (%d bytes)", relative, len(data))
    return relative


def resolve_image_path(relative_path: str) -> Optional[Path]:
    """Absolute path for a stored image, or None if it is missing.

    Guards against path traversal: a stored value is only ever trusted if it
    resolves to somewhere inside the storage root. The paths are server-generated
    today, but this function is what a future import tool would also call.
    """
    root = settings.storage_path.resolve()
    candidate = (settings.storage_path / relative_path).resolve()

    try:
        candidate.relative_to(root)
    except ValueError:
        logger.warning("refusing image path outside storage root: %s", relative_path)
        return None

    return candidate if candidate.is_file() else None


def delete_detection_image(relative_path: Optional[str]) -> bool:
    """Remove a stored frame. Missing files are not an error."""
    if not relative_path:
        return False
    path = resolve_image_path(relative_path)
    if path is None:
        return False
    try:
        path.unlink()
        return True
    except OSError as exc:
        logger.warning("could not delete %s: %s", relative_path, exc)
        return False
