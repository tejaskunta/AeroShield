from pydantic import BaseModel, ConfigDict, Field


class BoundingBox(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int


class DetectionItem(BaseModel):
    class_: str = Field(alias="class")
    confidence: float
    bbox: BoundingBox

    model_config = ConfigDict(populate_by_name=True)


class DetectionResponse(BaseModel):
    success: bool
    filename: str
    count: int
    detections: list[DetectionItem]
