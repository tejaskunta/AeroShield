# AeroShield Backend Guide (Additional Readme)

This file is an additional project readme and does not replace the main README.

## Overview

AeroShield is an AI-assisted drone landmine detection and mapping project.
This document covers the `backend/` service: a FastAPI application over
PostgreSQL + PostGIS that stores geotagged detections coming off the drone.

Full API reference, including auth, filters and curl examples:
[docs/API.md](docs/API.md)

## Current Backend Progress

- Phase 1 complete: FastAPI app, root endpoint, health endpoint, Swagger docs.
- Phase 2 complete: image upload detection endpoint with a dummy/mock detector.
- **Week 5 complete: PostgreSQL + PostGIS persistence, scoped API key auth,
  missions, geospatial queries, Alembic migrations, pytest suite.**

## Backend Folder

```text
backend/
├── app/
│   ├── main.py                        app assembly: metadata, CORS, lifespan
│   ├── api/
│   │   ├── detections.py              canonical ingest + query (PRD 8)
│   │   ├── missions.py                flights that group detections
│   │   ├── auth.py                    key introspection + administration
│   │   ├── health.py                  public probes
│   │   └── detection.py               DEV ONLY - mock detector, kept for demos
│   ├── core/
│   │   ├── config.py                  typed settings from .env
│   │   ├── security.py                API key generation / hashing / scopes
│   │   └── dependencies.py            get_db, get_principal, require_scope
│   ├── db/
│   │   ├── base.py                    declarative base + naming convention
│   │   ├── session.py                 async engine + session
│   │   └── models/                    api_key, mission, detection
│   ├── schemas/                       pydantic request/response models
│   └── services/
│       ├── detection_repository.py    persistence (the only writer of `geog`)
│       ├── mission_service.py         get-or-create, stats aggregation
│       └── storage.py                 detection frame storage on disk
├── migrations/                        alembic
├── scripts/
│   ├── create_api_key.py              mint the first key (bootstrap)
│   └── init-db.sql                    creates the test database
├── tests/                             pytest suite
├── alembic.ini
├── pytest.ini
├── requirements.txt
└── .env.example
```

## Run

### 1. Database

PostGIS comes from Docker (PRD section 7 locks PostgreSQL + PostGIS and Compose):

```bash
docker compose up -d db
```

PostGIS is not decoration - the Week 11 safe-path planner needs `ST_DWithin` /
`ST_Distance` and a GiST index, so starting on plain PostgreSQL or SQLite would mean
rewriting the detections table later.

### 2. Backend

macOS / Linux:

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
alembic upgrade head
python scripts/create_api_key.py --name laptop --preset admin
uvicorn app.main:app --reload
```

Windows PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
alembic upgrade head
python scripts\create_api_key.py --name laptop --preset admin
python -m uvicorn app.main:app --reload
```

From the repository root instead of `backend/`:

```powershell
python -m uvicorn app.main:app --reload --app-dir .\backend
```

Copy the API key that gets printed. Only its SHA-256 hash is stored, so it is shown
once and cannot be recovered.

## Endpoints

Everything except `/` and `/health` needs `X-API-Key`.

| Method | Path | Scope |
|---|---|---|
| POST | `/api/detections` | `drone:ingest` |
| GET | `/api/detections` | `detections:read` |
| GET | `/api/detections/geojson` | `detections:read` |
| GET | `/api/detections/{id}` | `detections:read` |
| PUT | `/api/detections/{id}/image` | `drone:ingest` |
| GET | `/api/detections/{id}/image` | `detections:read` |
| DELETE | `/api/detections/{id}` | `admin` |
| POST | `/api/missions` | `missions:write` |
| GET | `/api/missions` | `detections:read` |
| GET | `/api/missions/{id}` | `detections:read` |
| PATCH | `/api/missions/{id}` | `missions:write` |
| GET | `/api/missions/{id}/stats` | `detections:read` |
| GET | `/api/auth/me` | any key |
| POST/GET/DELETE | `/api/admin/api-keys` | `admin` |
| GET | `/` | public |
| GET | `/health` | public |
| POST | `/api/detect` | public - **dev tool** |

## Swagger

Open:

- http://127.0.0.1:8000/docs

Click **Authorize** and paste an API key to exercise the protected endpoints.

## Tests

```bash
cd backend && pytest -v
```

Requires the database container. The suite uses the separate `aeroshield_test`
database (created by `scripts/init-db.sql`) and creates/drops tables in it, so
development data is never touched.

## Important Notes

**`POST /api/detect` (singular) is a development tool, not the flight path.**
It uploads an image, returns a mock detection, and stores nothing. It is kept only so
the API can be demoed with no drone hardware.

It must never become a real server-side YOLO endpoint. PRD section 2.2 puts cloud
inference explicitly out of scope: the Jetson runs the model onboard and posts the
finished result to `POST /api/detections`. The backend records; it does not infer.

**Metadata and images are separate requests.** `POST /api/detections` carries ~1 KB of
JSON that must never be lost; `PUT /api/detections/{id}/image` carries a ~200 KB JPEG
that is best-effort. Combining them would give the critical part the durability of the
optional one.

**Ingest is idempotent on `client_detection_id`.** The drone spools detections to disk
when the radio link drops and replays them on reconnect, so the same detection
legitimately arrives more than once. A replay returns `200 duplicate: true`, not a
`409` - a 4xx would make the drone retry stored work forever.

**Positions carry their own error bars.** `horizontal_error_m` accompanies every
geotagged detection. The dashboard should draw an uncertainty circle, not a pin.
