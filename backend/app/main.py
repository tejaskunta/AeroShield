from fastapi import FastAPI

from app.api.detection import router as detection_router

app = FastAPI(
    title="AeroShield API",
    description="Backend API for the AeroShield AI-based drone landmine detection and mapping system.",
    version="1.0.0",
)


@app.get("/")
def read_root() -> dict[str, str]:
    return {"message": "AeroShield API is running"}


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "healthy"}


app.include_router(detection_router)
