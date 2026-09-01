from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.detection import router as detection_router

app = FastAPI(
    title="AeroShield API",
    description="Backend API for the AeroShield AI-based drone landmine detection and mapping system.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'http://localhost:5173',
        'http://localhost:5174',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:5174',
    ],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.get("/")
def read_root() -> dict[str, str]:
    return {"message": "AeroShield API is running"}


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "healthy"}


app.include_router(detection_router)
