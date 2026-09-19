"""AeroShield - dev-only image-upload detector.

NOT THE FLIGHT PATH.

This route uploads an image and returns detections from a mock service. It predates
the real ingest path and is kept because it is genuinely useful: you can exercise and
demo the API from Swagger with nothing but a JPEG - no drone, no Jetson, no engine.

PRD section 2.2 rules out cloud inference ("inference runs entirely on the Jetson"),
so this must never become a real server-side YOLO endpoint. The production flow is:

    Jetson detects  ->  POST /api/detections  (metadata the drone already computed)
                    ->  PUT  /api/detections/{id}/image

Nothing is persisted here. The response shape is unchanged from Week 5 and is
documented in the README, so it stays as-is.
"""

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.schemas.detection import DetectionResponse
from app.services.detection_service import DummyDetectionService

router = APIRouter(prefix="/api", tags=["Dev tools"])
service = DummyDetectionService()


@router.post(
    "/detect",
    response_model=DetectionResponse,
    summary="[DEV] Mock detection from an uploaded image",
    description=(
        "Development and demo utility. Returns a **mock** detection for an uploaded "
        "image and stores nothing.\n\n"
        "This is **not** how detections reach the system in flight. The drone runs "
        "YOLO onboard and posts the result to `POST /api/detections`; the backend "
        "never runs a model (PRD 2.2)."
    ),
)
async def detect_image(file: UploadFile = File(...)) -> DetectionResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed.")

    return service.detect(filename=file.filename or "upload")
