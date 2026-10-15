"""AeroShield - API router aggregation.

Order matters. `detections` is included before the legacy `detection` router so the
canonical plural path is registered first, and health last so its bare "/" cannot
shadow anything.
"""

from fastapi import APIRouter

from app.api import auth, copilot, detection, detections, health, missions, reports

api_router = APIRouter()

# Canonical PRD section 8 paths.
api_router.include_router(detections.router)
api_router.include_router(missions.router)
api_router.include_router(auth.router)

# Intelligence layer (PRD section 5.1). Copilot answers read-side questions and
# reports turn stored facts into a shareable document; both sit with the read
# endpoints because neither runs inference on the server.
api_router.include_router(copilot.router)
api_router.include_router(reports.router)

# Dev-only image-upload detector. Predates the ingest path and is kept for demos.
api_router.include_router(detection.router)

api_router.include_router(health.router)

__all__ = ["api_router"]
