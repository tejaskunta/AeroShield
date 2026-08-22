from app.schemas.detection import BoundingBox, DetectionItem, DetectionResponse


class DummyDetectionService:
    """Mock detection service for API testing before YOLO integration."""

    def detect(self, filename: str) -> DetectionResponse:
        mock_detection = DetectionItem(
            class_="landmine",
            confidence=0.92,
            bbox=BoundingBox(x1=100, y1=120, x2=250, y2=280),
        )

        return DetectionResponse(
            success=True,
            filename=filename,
            count=1,
            detections=[mock_detection],
        )
