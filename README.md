# AeroShield

## AI-Powered Drone Landmine Detection and Mapping System

AeroShield is an AI-driven drone system designed to autonomously survey predefined GPS grid missions, detect visible landmine-like objects and surface indicators using onboard computer vision, associate detections with GPS coordinates, and present them through a real-time web dashboard with geospatial analysis, safety assistance, and automated reporting.

Important: AeroShield uses RGB imagery and is designed to detect visible landmine-like objects and surface indicators. It does not detect buried mines.

---

## Project Overview

Traditional landmine detection can expose personnel to significant risk, requires substantial time, and is difficult in large or inaccessible areas. AeroShield explores a safer and more scalable approach by combining autonomous drone surveying, onboard AI inference, GPS geotagging, geospatial analysis, and decision-support tools.

Core end-to-end pipeline:

```text
Autonomous Drone Mission
        -> RGB Image Capture
        -> YOLO Detection on Jetson Nano
        -> Grad-CAM Explanation
        -> MAVLink GPS Geotagging
        -> FastAPI Backend
        -> PostgreSQL + PostGIS
        -> Real-Time Web Dashboard
        -> AI Assistance + Safe Path + Report
```

The project is currently developed as a single-drone, web-dashboard MVP.

---

## Current Repository Status

Implemented now:

- FastAPI backend foundation
- Root and health endpoints
- Swagger docs
- Detection upload endpoint with a dummy detector

Current backend endpoints:

- GET /
- GET /health
- POST /api/detect

Example detection response:

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

---

## Key Features (Target Architecture)

1. Autonomous grid survey using ArduPilot and Mission Planner.
2. Onboard YOLO inference on Jetson Nano.
3. Grad-CAM based explainability for detections.
4. MAVLink GPS geotagging for every detection.
5. Real-time dashboard updates via API plus websocket layer.
6. RAG safety copilot grounded in demining documentation.
7. Deterministic safe-path planner using A* and geospatial risk.
8. Automated mission report generation.
9. Voice-assisted query flow through browser speech input.

---

## System Architecture

```text
Mission Planner
    -> Pixhawk 4 (ArduPilot)
    -> Jetson Nano (OpenCV + YOLO + Grad-CAM + GPS geotagging)
    -> REST to FastAPI
    -> PostgreSQL + PostGIS
    -> Dashboard + AI services (RAG, A*, report agents)
```

---

## Technology Stack

### Hardware

| Component | Technology |
|---|---|
| Drone frame | ZD550 550mm carbon fiber folding quadcopter |
| Flight controller | Pixhawk 4 |
| Flight firmware | ArduPilot |
| GPS and compass | Holybro M10 |
| Companion computer | NVIDIA Jetson Nano |
| Camera | USB or CSI RGB camera |
| Ground station | Mission Planner |

### Software

| Layer | Technology |
|---|---|
| Backend API | FastAPI |
| Computer vision | OpenCV |
| Object detection | YOLOv8 (Ultralytics) |
| Jetson optimization | TensorRT |
| Explainability | Grad-CAM |
| Telemetry integration | pymavlink or MAVSDK |
| Database | PostgreSQL + PostGIS |
| Vector store | Chroma |
| Agent framework | CrewAI |
| LLM provider | Claude API or GPT API |
| Frontend | React |
| Mapping | Leaflet |
| Real-time channel | Socket.IO |
| Report generation | WeasyPrint |
| Containerization | Docker Compose |
| Version control | Git and GitHub |

---

## Project Structure

The exact structure will evolve, but the target organization is:

```text
AeroShield/
|-- backend/
|   |-- app/
|   |   |-- api/
|   |   |-- services/
|   |   |-- schemas/
|   |   |-- database/
|   |   |-- agents/
|   |   |-- rag/
|   |   |-- planner/
|   |   `-- main.py
|   |-- migrations/
|   |-- reports/
|   |-- tests/
|   |-- requirements.txt
|   `-- .env.example
|-- frontend/
|-- jetson/
|-- ml/
|-- docs/
|-- docker-compose.yml
|-- .gitignore
`-- README.md
```

Current implemented backend files are in backend/app and backend/requirements.txt.

---

## Getting Started

### Prerequisites

- Python 3
- Git
- PostgreSQL with PostGIS (for later phases)
- Node.js and npm (for frontend phase)
- Docker and Docker Compose (optional)

### Clone

```bash
git clone https://github.com/tejaskunta/AeroShield.git
cd "AeroShield Project"
```

### Backend Setup (Current)

From project root (Windows PowerShell):

```powershell
& ".\.venv\Scripts\python.exe" -m pip install -r .\backend\requirements.txt
& ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --app-dir .\backend
```

From backend folder:

```powershell
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

### API Docs and Health Checks

- http://127.0.0.1:8000
- http://127.0.0.1:8000/health
- http://127.0.0.1:8000/docs

### Test Detection Endpoint in Swagger

1. Open /docs.
2. Expand POST /api/detect.
3. Click Try it out.
4. Upload a jpg, jpeg, or png image.
5. Click Execute.

---

## Development Strategy

Development is incremental:

1. Mock detection -> backend -> dashboard integration.
2. Replace mock detector with real YOLO model.
3. Integrate Jetson inference and MAVLink GPS geotagging.
4. Add database, geospatial analysis, RAG assistant, and reports.

SITL-first testing is recommended before physical flight tests.

---

## Limitations and Safety

- RGB-only detection cannot detect buried mines.
- Geolocation is affected by GPS error, camera calibration, attitude error, and terrain assumptions.
- AeroShield is a research and decision-support prototype, not a certified mine-clearance system.

---

## Out of Scope for MVP v1

- Mobile app
- Dashboard-based manual drone control
- Multi-drone coordination
- Cloud YOLO inference
- Live model retraining
- Buried-mine detection

Mission creation and flight control remain in Mission Planner. AI inference remains on Jetson.

---

## License

Add the final project license here (for example, MIT).

Also ensure all external datasets, models, and documents comply with their licenses and attribution requirements.
