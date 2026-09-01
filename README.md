# AeroShield

AeroShield is a mission-focused drone safety and detection console for AI-assisted landmine monitoring and route planning. The project combines a simulated mission dashboard, a FastAPI backend, and a frontend workflow for reviewing detections, risk patterns, telemetry, and safe corridors in a single operator view.

This repository is currently structured as a simulator-first prototype: the frontend models mission traffic and detection activity in-browser, while the backend exposes a lightweight API foundation for future YOLO or sensor integration.

---

## Project goal

AeroShield is designed to give an operator a clear understanding of:

- current drone telemetry and mission state
- hazard and caution detections across a mapped area
- risk concentration and coverage movement
- safe route planning around uncertain or flagged cells
- mission reporting and operator review workflows

The system is intentionally built around an operator interface rather than a raw model pipeline alone. The UX is tuned for rapid decision-making in a monitoring environment.

---

## Current implementation status

### Frontend

- React + TypeScript + Vite app
- Mission control dashboard with live map and drone telemetry
- Detection center and review workflow
- Analytics and safety copilots screens
- Mission reports and status summaries
- Simulated mission stream with detections and path planning

### Backend

- FastAPI service with health and root endpoints
- detection API for uploaded image handling
- mock detection service ready to be replaced by real model inference

### Current model reality

- The app uses client-side simulation data in the frontend
- The backend currently returns mock detection results instead of live YOLO predictions
- The repo is best understood as a foundation for a real AI mission platform rather than a final production deployment

---

## Repository structure

```text
AeroShield Project/
├── README.md
├── README_BACKEND_GUIDE.md
├── requirements.txt
├── week3_train_yolov8.py
├── backend/
│   ├── requirements.txt
│   └── app/
│       ├── main.py
│       ├── api/
│       │   └── detection.py
│       ├── schemas/
│       │   └── detection.py
│       └── services/
│           └── detection_service.py
├── configs/
│   └── data.yaml.example
├── docs/
│   └── TRAINING_NOTES.md
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       ├── screens/
│       └── types/
├── jetson/
│   ├── README.md
│   ├── build_engine.sh
│   └── infer_trt.py
├── scripts/
│   ├── check_env.py
│   ├── export_onnx.py
│   ├── predict.py
│   └── verify_dataset.py
├── weights/
│   └── README.txt
└── .gitignore
```

---

## Tech stack

### Frontend

- React 18
- TypeScript
- Vite
- Tailwind CSS
- Leaflet + React Leaflet
- Recharts
- React Router

### Backend

- Python
- FastAPI
- Uvicorn
- Python multipart upload support

### AI / inference work

- YOLOv8-related scripts and training assets are present in the project root and under the `scripts/` and `jetson/` directories
- Model integration is in progress and not yet fully connected to the live backend API

---

## Quick start

### 1. Clone and install backend dependencies

```bash
cd "AeroShield Project"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r .\backend\requirements.txt
```

### 2. Run the backend

```bash
cd "AeroShield Project"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --app-dir .\backend
```

The backend will be available at:

- http://127.0.0.1:8000/
- Swagger docs: http://127.0.0.1:8000/docs

### 3. Install and run the frontend

```bash
cd "AeroShield Project\frontend"
npm install
npm run dev -- --host 0.0.0.0
```

Open:

- http://localhost:5173/

---

## Frontend app overview

At the main mission dashboard, the app presents:

- a mission map with detection overlays
- a status rail with telemetry and detection counts
- a drone summary with battery, link, GPS, altitude, and speed
- a safe path planner with start/end selection and route plotting
- a detections ticker for operator review

Key screens are mounted via the router in [frontend/src/App.tsx](frontend/src/App.tsx):

- Mission Control
- Detection Center
- Analytics
- Safety Copilot
- Mission Reports

---

## Backend API

The current FastAPI implementation exposes:

```http
GET /
GET /health
POST /api/detect
```

Example behavior:

- `/` returns a simple service-running message
- `/health` returns a health status payload
- `/api/detect` accepts an uploaded image and returns a mock detection response

The mock detection service is defined in [backend/app/services/detection_service.py](backend/app/services/detection_service.py) and is intended to be replaced later with real detection logic.

---

## Development notes

### Frontend verification

The current frontend was validated by running:

```bash
cd "AeroShield Project\frontend"
npm run build
```

This completed successfully, confirming the app compiles cleanly in its current state.

### Current design assumption

The current project is simulation-led and operator-first. That means the interface and workflow are already shaped around real mission operations even though the underlying detection pipeline is not fully or continuously connected to a live model yet.

---

## Documentation

Additional documentation in the repo:

- [README_BACKEND_GUIDE.md](README_BACKEND_GUIDE.md) — backend-focused setup and API notes
- [docs/TRAINING_NOTES.md](docs/TRAINING_NOTES.md) — training and dataset notes for the model-oriented part of the project
- [jetson/README.md](jetson/README.md) — Jetson-side deployment notes

---

## Roadmap direction

The likely next evolution of this project is:

1. connect the backend to a real model inference path
2. replace mock detection payloads with YOLO or TensorRT outputs
3. wire live mission telemetry into the frontend
4. tighten the analytics, risk scoring, and operator review workflows
5. support deployment to field-ready drone mission tooling

---

## License

This repository does not currently declare a project license in the root package metadata. Review your team or institutional requirements before distributing the project externally.

---

## Contribution

Use the repository as a working prototype for a drone safety and detection platform. Contributions should keep the operator workflow practical and the model/inference integration clearly separated from the UI logic.

## Repo layout

```
AeroShield/
├── backend/                   ← FastAPI backend (detection API, future agents)
├── frontend/                  ← React dashboard (to be developed)
├── jetson/                    ← Jetson Nano deployment (TensorRT)
├── ml/                        ← YOLOv8 training pipeline
├── scripts/
│   ├── check_env.py            run this first
│   ├── verify_dataset.py       run this before every training run
│   ├── export_onnx.py          standalone re-export
│   └── predict.py              visual sanity check
├── week3_train_yolov8.py       ← main training deliverable: train → val → export
├── configs/data.yaml.example
├── docs/TRAINING_NOTES.md      ← what to record for the report
├── docker-compose.yml          ← (to be developed) service orchestration
└── README.md
```

---

## Stack (per PRD §7)

| Component | Tool |
|---|---|
| Detection model | YOLOv8s (Ultralytics), TensorRT-exported |
| Training | PyTorch + CUDA 12.4, RTX 4070 8 GB |
| Deployment | Jetson Nano P3450, JetPack 4.6, TensorRT 8.2, FP16 |
| Explainability | Grad-CAM (Week 5 — needs `best.pt`, not the engine) |

**Keep `best.pt`.** Grad-CAM (PRD §5.1, the highest-ROI feature) runs against
the PyTorch checkpoint, not the TensorRT engine. The `.pt` file is not disposable
once you have the `.onnx`.

## Dataset licensing

Public datasets (Roboflow Universe etc.) are typically CC BY 4.0 — you must
attribute them in the final report and repo (PRD §10). Record every source in
[docs/TRAINING_NOTES.md](docs/TRAINING_NOTES.md) as you go; reconstructing it in
week 12 is miserable.
