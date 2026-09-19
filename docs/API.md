# AeroShield API

Week 5 deliverable: REST API over the detection database.

Interactive docs are generated from the code and are the authoritative reference:

- Swagger UI: http://127.0.0.1:8000/docs
- ReDoc: http://127.0.0.1:8000/redoc
- OpenAPI JSON: http://127.0.0.1:8000/openapi.json

This file covers the things a schema cannot express: why the endpoints are shaped the
way they are, and the failure modes worth knowing about before a flight.

---

## The flow this API is built around

The Jetson runs YOLO **onboard** and posts finished detections. The backend records;
it never runs a model. PRD section 2.2 puts cloud inference explicitly out of scope.

```
Camera -> YOLO (Jetson) -> MAVLink GPS -> geotag -> POST /api/detections
                                                 -> PUT  /api/detections/{id}/image
```

Metadata and image are **two requests**, deliberately:

| | Size | Guarantee |
|---|---|---|
| `POST /api/detections` | ~1 KB JSON | Must never be lost. Spooled to disk on failure, replayed on reconnect. |
| `PUT /api/detections/{id}/image` | ~200 KB JPEG | Best-effort. Retried separately, abandoned if it will not go. |

A detection whose photo never arrived is still a usable safety record. A photo with
no detection row is useless. Welding them into one all-or-nothing multipart request
would give the small critical part the durability of the large optional one.

---

## Authentication

Every endpoint except `GET /` and `GET /health` requires a scoped API key:

```
X-API-Key: aero_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Minting keys

The first key has to come from the CLI, since `POST /api/admin/api-keys` itself
needs an admin key:

```bash
cd backend
python scripts/create_api_key.py --name laptop   --preset admin
python scripts/create_api_key.py --name drone-01 --preset drone
python scripts/create_api_key.py --list
python scripts/create_api_key.py --revoke 3
```

The plaintext key is printed **once**. Only a SHA-256 hash is stored, so it cannot be
recovered - if it is lost, revoke it and mint another.

### Scopes

| Scope | Grants |
|---|---|
| `drone:ingest` | POST detections, PUT detection images |
| `detections:read` | Read detections, missions, stats, images, GeoJSON |
| `missions:write` | Create and update missions |
| `admin` | Manage API keys, delete detections. **Implies every other scope.** |

Presets: `drone` (ingest + missions:write), `dashboard` (read), `operator`
(read + missions:write), `admin` (everything).

A key is revoked by flag, not deleted - the record of which key ingested which
detection has to outlive the key itself.

### What this does not give you

Keys are bearer credentials in a header. Over plain HTTP anything on the path can
read them. **Terminate TLS in front of this API before it leaves the bench.** That is
a deployment requirement, not something the code can solve.

CORS origins are explicit (`AEROSHIELD_CORS_ORIGINS`) and must never be `*`: a
wildcard origin plus a browser-held key leaks the key to any site the operator visits.

### Week 6 note

The React dashboard will need a human login. `app/core/dependencies.py` resolves a
credential into a `Principal`, and routes depend on `require_scope(...)` rather than
on API keys specifically - so a JWT verifier that returns the same `Principal` slots
in without touching a single route.

---

## Endpoints

### Detections

| Method | Path | Scope |
|---|---|---|
| POST | `/api/detections` | `drone:ingest` |
| GET | `/api/detections` | `detections:read` |
| GET | `/api/detections/geojson` | `detections:read` |
| GET | `/api/detections/{id}` | `detections:read` |
| PUT | `/api/detections/{id}/image` | `drone:ingest` |
| GET | `/api/detections/{id}/image` | `detections:read` |
| DELETE | `/api/detections/{id}` | `admin` |

**Ingest is idempotent on `client_detection_id`.** A replay returns `200` with
`duplicate: true` rather than `409`, because a 4xx would make the drone treat
successfully-stored work as failed and retry the same record forever.

**Mission resolution**, in order: `mission_id` (404 if unknown) -> `mission_name`
(get-or-create) -> neither (stored unassigned). The drone sends `mission_name` so a
detection spooled during a link outage can still be filed correctly hours later.

**Query parameters** on `GET /api/detections`:

| Parameter | Notes |
|---|---|
| `mission_id` | |
| `class_name` | Exact match |
| `min_confidence` | 0.0-1.0 |
| `since`, `until` | Filter on `captured_at`, ISO-8601 **with offset** |
| `near` | `latitude,longitude,radius_metres` - PostGIS `ST_DWithin` |
| `geotagged_only` | Exclude detections with no GPS lock |
| `limit`, `offset` | Default 50, max 500 |

Results are ordered by **`captured_at` descending, never `created_at`**. A spooled
detection is inserted long after it was seen, so insertion order does not reflect the
flight.

`near` radius is **metres**, because the column is `geography(POINT, 4326)` and not
`geometry`. With geometry the same number would mean *degrees* and silently match
half the planet - a bug the test suite pins down explicitly.

### Missions

| Method | Path | Scope |
|---|---|---|
| POST | `/api/missions` | `missions:write` |
| GET | `/api/missions` | `detections:read` |
| GET | `/api/missions/{id}` | `detections:read` |
| PATCH | `/api/missions/{id}` | `missions:write` |
| GET | `/api/missions/{id}/stats` | `detections:read` |

`POST /api/missions` is **get-or-create by name**: `201` when created, `200` when it
already existed. The drone calls it at every startup, and a reboot mid-flight must
rejoin the existing mission rather than fork it.

Setting `status` to `completed` or `aborted` stamps `ended_at` automatically, so the
Week 11 report agent always has a duration.

### Auth and admin

| Method | Path | Scope |
|---|---|---|
| GET | `/api/auth/me` | any valid key |
| POST | `/api/admin/api-keys` | `admin` |
| GET | `/api/admin/api-keys` | `admin` |
| DELETE | `/api/admin/api-keys/{id}` | `admin` |

### Health and dev tools

| Method | Path | Auth |
|---|---|---|
| GET | `/` | public |
| GET | `/health` | public - includes a real database round-trip |
| POST | `/api/detect` | public - **dev tool, mock detector, stores nothing** |

`POST /api/detect` (singular) predates the ingest path. It uploads an image and
returns a mock detection so the API can be demoed with no drone. It is **not** the
flight path and must never grow a real model - see PRD section 2.2.

---

## Positional accuracy

Every geotagged detection carries `horizontal_error_m`: a 1-sigma estimate combining

- GPS receiver error (~2.5 m for the Holybro M10, no RTK)
- altitude error (5% of AGL), which scales with distance from the frame centre
- heading error (5 degrees after a good compass calibration)
- box-centroid jitter (~4 px, converted through the GSD)

It **excludes** terrain slope, camera tilt away from nadir, and lens distortion,
because correcting those needs a terrain model and a calibrated camera. Get the
numbers for your own setup with:

```bash
python3 jetson/geo.py --hfov 62.2 --width 1280 --height 720 --alt 30
```

Render an uncertainty circle, not a pin. PRD section 10 is explicit that overstating
precision is the dangerous direction to be wrong in for a safety system.

When there is no usable GPS fix, `latitude`/`longitude` are `null` and the detection
is still stored. `GET /api/detections/geojson` omits those rows - GeoJSON cannot
express "exists but has no location", and `[0, 0]` would draw a phantom cluster in the
Gulf of Guinea. Use `GET /api/missions/{id}/stats` to see the
`total_detections` vs `geotagged_detections` split.

---

## Errors

| Status | Meaning |
|---|---|
| 400 | Malformed request; non-image upload (checked by magic bytes, not Content-Type) |
| 401 | Missing, unknown or revoked API key |
| 403 | Valid key without the required scope. The message names the scopes the key *does* have. |
| 404 | No such detection/mission, or an image that was never uploaded |
| 413 | Image over `AEROSHIELD_MAX_IMAGE_MB` |
| 422 | Schema validation failure - inverted bbox, out-of-range confidence, one-sided coordinates, naive timestamp, malformed `near` |

Validation worth knowing about, because each rejects a real failure mode:

- **Inverted or zero-area bbox** - the client's coordinate maths is wrong.
- **One-sided coordinates** - a latitude with no longitude plots on the prime meridian.
- **Naive `captured_at`** - drone, server and browser are routinely in different
  zones, so a timestamp with no offset silently shifts the mission timeline.
- **Non-image upload** - magic bytes are checked because `Content-Type` is whatever
  the client chose to send, and a truncated upload over a bad link lands here too.

---

## Worked example

```bash
export KEY=aero_...          # from scripts/create_api_key.py
export URL=http://127.0.0.1:8000

curl -s $URL/health | python3 -m json.tool
curl -s -H "X-API-Key: $KEY" $URL/api/auth/me | python3 -m json.tool

# Create a mission
curl -s -X POST $URL/api/missions \
     -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
     -d '{"name":"bench-1","description":"desk test"}'

# Ingest a detection
cat > /tmp/det.json <<'EOF'
{
  "client_detection_id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "mission_name": "bench-1",
  "class_name": "landmine_metal",
  "class_id": 0,
  "confidence": 0.87,
  "bbox_x1": 640, "bbox_y1": 360, "bbox_x2": 730, "bbox_y2": 450,
  "latitude": 12.9716214, "longitude": 77.5946101,
  "relative_altitude_m": 30.0, "heading_deg": 90.0,
  "gps_fix_type": 3, "satellites_visible": 14, "horizontal_error_m": 3.4,
  "frame_width": 1280, "frame_height": 720,
  "captured_at": "2026-08-23T09:14:22.481Z"
}
EOF

curl -s -X POST $URL/api/detections \
     -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
     -d @/tmp/det.json

# Same request again -> duplicate: true, still one row
curl -s -X POST $URL/api/detections \
     -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
     -d @/tmp/det.json

# Attach the frame
curl -s -X PUT $URL/api/detections/1/image \
     -H "X-API-Key: $KEY" -F 'image=@frame.jpg;type=image/jpeg'

# Query
curl -s -H "X-API-Key: $KEY" "$URL/api/detections?near=12.9716,77.5946,500"
curl -s -H "X-API-Key: $KEY" $URL/api/detections/geojson | python3 -m json.tool
curl -s -H "X-API-Key: $KEY" $URL/api/missions/1/stats | python3 -m json.tool
```

---

## Running it

```bash
docker compose up -d db                     # PostGIS

cd backend
python3 -m venv .venv && source .venv/bin/activate    # macOS/Linux
# .\.venv\Scripts\Activate.ps1                        # Windows PowerShell
pip install -r requirements.txt
cp .env.example .env
alembic upgrade head
python scripts/create_api_key.py --name laptop --preset admin
uvicorn app.main:app --reload
```

Verify the schema really is spatial:

```bash
docker compose exec db psql -U aeroshield -d aeroshield \
  -c "SELECT PostGIS_Version();" \
  -c "\d detections"        # expect ix_detections_geog USING gist
```

Tests (needs the database container up; uses the separate `aeroshield_test`
database, so development data is never touched):

```bash
cd backend && pytest -v      # API suite
cd .. && pytest -v           # jetson/ geolocation + GPS unit tests, no DB needed
```
