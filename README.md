# AeroShield

AeroShield is an AI-based drone landmine detection and mapping system.

Current focus in this repository is the backend API foundation built with FastAPI, designed so a trained YOLO model can be integrated later without changing the API contract.

## Project Goal

Build a safe and practical system that can:

- Process drone images
- Detect possible landmine-like objects
- Attach GPS context to detections
- Support mission workflows
- Generate reports for field teams

Important limitation: RGB camera detection identifies visible landmine-like objects and indicators on the surface, not buried mines.

## Tech Stack (Planned)

- FastAPI (backend API)
- YOLO (object detection)
- GPS metadata handling
- MongoDB (data storage)
- RAG + LLM (analysis assistance)
- Web/Mobile dashboard
- PDF reports

## Current Implementation Status

### Phase 1 Complete

- FastAPI app initialized
- Health and root endpoints added
- Swagger docs enabled

Endpoints:

- `GET /` -> `{"message": "AeroShield API is running"}`
- `GET /health` -> `{"status": "healthy"}`

### Phase 2 Complete

- Detection API foundation added
- Image upload endpoint created
- Dummy/mock detector implemented (no YOLO loaded yet)
- Image content-type validation added

Endpoint:

- `POST /api/detect`

Example response:

```json
{
  "success": true,
  "filename": "example.jpg",
  "count": 1,
  "detections": [
    {
      "class": "landmine",
      "confidence": 0.92,
      "bbox": {
        "x1": 100,
        "y1": 120,
        "x2": 250,
        "y2": 280
      }
    }
  ]
}
```

## Backend Structure (Current)

```text
backend/
├── app/
│   ├── main.py
│   ├── api/
│   │   └── detection.py
│   ├── services/
│   │   └── detection_service.py
│   └── schemas/
│       └── detection.py
└── requirements.txt
```

## Quick Start (Windows PowerShell)

Run from project root (`AeroShield Project`):

```powershell
& ".\.venv\Scripts\python.exe" -m pip install -r .\backend\requirements.txt
& ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --app-dir .\backend
```

Alternative (if you work directly inside `backend`):

```powershell
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

## API Testing

Open these URLs after starting the server:

- http://127.0.0.1:8000
- http://127.0.0.1:8000/health
- http://127.0.0.1:8000/docs

To test detection endpoint in Swagger:

1. Open `/docs`
2. Expand `POST /api/detect`
3. Click `Try it out`
4. Upload an image file (`.jpg`, `.jpeg`, `.png`)
5. Click `Execute`

## Next Planned Phase

Phase 3 will add mission and GPS API foundations (still without YOLO model loading), while keeping clean separation between routes, schemas, and services.
