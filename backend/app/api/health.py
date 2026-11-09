"""AeroShield - root and health endpoints.

Both are public. A health check that needs a credential is useless to a load
balancer, and the information here is not sensitive.
"""

from fastapi import APIRouter

from app.core.config import settings
from app.db.session import check_database
from app.schemas.common import HealthResponse

router = APIRouter(tags=["Health"])

API_VERSION = "1.0.0"


@router.get("/", summary="Liveness")
async def read_root() -> dict:
    """Confirms the process is up. Says nothing about the database.

    Response shape is unchanged from the Week 5 placeholder, and is documented in
    the README - a dashboard or a script may already be checking for this string.
    """
    return {"message": "AeroShield API is running"}


@router.get("/health", response_model=HealthResponse, summary="Readiness")
async def health_check() -> HealthResponse:
    """Readiness, including a real database round-trip.

    `status` stays "healthy" only when every dependency answers, so this endpoint
    can gate a deployment. It reports rather than raises: a 200 with
    database="unreachable" is more useful to a human debugging a broken .env than a
    503 with no detail.
    """
    database_ok = await check_database()
    return HealthResponse(
        status="healthy" if database_ok else "degraded",
        database="ok" if database_ok else "unreachable",
        environment=settings.env,
        version=API_VERSION,
    )
