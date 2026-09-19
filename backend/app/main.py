"""AeroShield - FastAPI application entry point.

    uvicorn app.main:app --reload            # from backend/
    uvicorn app.main:app --reload --app-dir backend   # from the repo root

Routes live in app/api/ and are aggregated by app.api.api_router. This module only
assembles the application: metadata, middleware, lifespan.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import api_router
from app.core.config import settings
from app.db.session import check_database, dispose_engine

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("aeroshield")

DESCRIPTION = """
Backend API for **AeroShield** - AI-assisted drone landmine detection and mapping.

AeroShield uses RGB imagery to detect **visible** landmine-like objects and surface
indicators. It does **not** detect buried mines, and it is a research and
decision-support prototype, not a certified mine-clearance system.

### How detections reach this API

The Jetson Nano runs YOLO onboard, geotags each hit from MAVLink GPS, and posts the
finished result. Inference never happens on the server.

```
Camera -> YOLO (Jetson) -> MAVLink GPS -> POST /api/detections
                                       -> PUT  /api/detections/{id}/image
```

Metadata and image are separate requests so a large frame can fail or retry without
risking the small row that matters.

### Authentication

Every endpoint except `/` and `/health` needs a scoped API key in the `X-API-Key`
header. Mint one with:

```
python backend/scripts/create_api_key.py --name drone-01 --preset drone
```

Scopes: `drone:ingest`, `detections:read`, `missions:write`, `admin`
(`admin` implies the rest).

Keys are bearer credentials. Terminate TLS in front of this API before it leaves
the bench.

### Positional accuracy

Every geotagged detection carries `horizontal_error_m`, a 1-sigma estimate combining
GPS error, altitude error, heading error and box-centroid jitter. It excludes terrain
slope, camera tilt and lens distortion. Render an uncertainty circle, not a pin.
"""

TAGS_METADATA = [
    {
        "name": "Detections",
        "description": "Canonical ingest and query paths. This is what the drone talks to.",
    },
    {
        "name": "Missions",
        "description": "Flights that group detections. Created by name, so the drone "
                       "can self-register and rejoin after a reboot.",
    },
    {
        "name": "Auth",
        "description": "Key introspection and administration.",
    },
    {
        "name": "Dev tools",
        "description": "Utilities for working without drone hardware. Not part of the "
                       "flight path.",
    },
    {
        "name": "Health",
        "description": "Public liveness and readiness probes.",
    },
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown.

    The database check is a warning, not a hard failure: a developer who starts the
    API before `docker compose up -d db` should get a clear log line and a working
    /docs page, not a process that refuses to boot.
    """
    logger.info("AeroShield API starting (env=%s)", settings.env)

    if await check_database():
        logger.info("database: connected")
    else:
        logger.warning(
            "database: UNREACHABLE at %s",
            settings.database_url.rsplit("@", 1)[-1],   # never log credentials
        )
        logger.warning("  start it with:  docker compose up -d db")
        logger.warning("  then migrate :  cd backend && alembic upgrade head")

    settings.storage_path.mkdir(parents=True, exist_ok=True)
    await _bootstrap_admin_key()

    yield

    logger.info("AeroShield API shutting down")
    await dispose_engine()


async def _bootstrap_admin_key() -> None:
    """Upsert AEROSHIELD_BOOTSTRAP_ADMIN_KEY as an admin key, if one is configured.

    Convenience for a fresh clone or a CI run. Intentionally opt-in and empty by
    default: a key in an env file ends up in shell history and screenshots, so real
    deployments should use scripts/create_api_key.py instead.
    """
    if not settings.bootstrap_admin_key:
        return

    from sqlalchemy import select

    from app.core.security import (
        SCOPE_PRESETS,
        display_prefix,
        hash_api_key,
    )
    from app.db.models.api_key import ApiKey
    from app.db.session import SessionLocal

    key = settings.bootstrap_admin_key
    try:
        async with SessionLocal() as db:
            key_hash = hash_api_key(key)
            existing = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
            if existing.scalar_one_or_none() is not None:
                logger.info("bootstrap admin key already present")
                return

            db.add(ApiKey(
                name="bootstrap",
                key_prefix=display_prefix(key),
                key_hash=key_hash,
                scopes=SCOPE_PRESETS["admin"],
                is_active=True,
            ))
            await db.commit()
            logger.warning("registered AEROSHIELD_BOOTSTRAP_ADMIN_KEY as an admin key "
                           "- unset it for any real deployment")
    except Exception as exc:            # noqa: BLE001
        # Almost always "tables do not exist yet". Not worth blocking startup for.
        logger.warning("could not register bootstrap admin key: %s", exc)
        logger.warning("  run migrations first: cd backend && alembic upgrade head")


app = FastAPI(
    title="AeroShield API",
    description=DESCRIPTION,
    version="1.0.0",
    openapi_tags=TAGS_METADATA,
    lifespan=lifespan,
    contact={"name": "AeroShield", "url": "https://github.com/tejaskunta/AeroShield"},
    license_info={"name": "See repository LICENSE"},
)

# Explicit origins, never "*": a wildcard origin combined with a browser-held API
# key is how a credential leaks to any site the operator happens to visit.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(api_router)
