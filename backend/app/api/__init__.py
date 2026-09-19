"""AeroShield - API router aggregation.

Order matters. `detections` is included before the legacy `detection` router so the
canonical plural path is registered first, and health last so its bare "/" cannot
shadow anything.
"""

from fastapi import APIRouter

from app.api import auth, detection, detections, health, missions

api_router = APIRouter()

# Canonical PRD section 8 paths.
api_router.include_router(detections.router)
api_router.include_router(missions.router)
api_router.include_router(auth.router)

# Dev-only image-upload detector. Predates the ingest path and is kept for demos.
api_router.include_router(detection.router)

api_router.include_router(health.router)

__all__ = ["api_router"]
