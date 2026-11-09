"""AeroShield - API router aggregation.

Order matters. `detections` is included before the legacy `detection` router so the
canonical plural path is registered first, and health last so its bare "/" cannot
shadow anything.
"""

from fastapi import APIRouter

from app.api import (
    auth,
    copilot,
    detection,
    detections,
    health,
    missions,
    reports,
    telemetry,
    ws,
)

api_router = APIRouter()

# Canonical PRD section 8 paths.
api_router.include_router(detections.router)
api_router.include_router(missions.router)

# Aircraft position. Shares the /api/missions prefix and adds /telemetry beneath
# it. Order against `missions` does not actually matter - Starlette matches on the
# whole path pattern, and /api/missions/{id} cannot claim the longer
# /api/missions/{id}/telemetry - but it is grouped next to the mission routes
# because that is what it belongs to.
api_router.include_router(telemetry.router)

api_router.include_router(auth.router)

# Intelligence layer (PRD section 5.1). Copilot answers read-side questions and
# reports turn stored facts into a shareable document; both sit with the read
# endpoints because neither runs inference on the server.
api_router.include_router(copilot.router)
api_router.include_router(reports.router)

# Dev-only image-upload detector. Predates the ingest path and is kept for demos.
api_router.include_router(detection.router)

# Live push, as a websocket beside the REST routes it mirrors. Included after the
# HTTP routers on purpose: a websocket route is matched on its own scope type, so
# it cannot shadow an HTTP path, and keeping the push routes at the end of the file
# keeps the REST surface readable as one list. /api/ws/missions/{id} is deliberately
# not a sibling of /api/missions/{id}, because a socket is not a resource - it is a
# subscription, and giving it its own noun makes that obvious in an access log.
api_router.include_router(ws.router)

api_router.include_router(health.router)

__all__ = ["api_router"]
