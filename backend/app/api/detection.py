from fastapi import APIRouter, File, HTTPException, UploadFile

from app.schemas.detection import DetectionResponse
from app.services.detection_service import DummyDetectionService

router = APIRouter(prefix="/api", tags=["Detection"])
service = DummyDetectionService()


@router.post("/detect", response_model=DetectionResponse)
async def detect_image(file: UploadFile = File(...)) -> DetectionResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed.")

    return service.detect(filename=file.filename)
