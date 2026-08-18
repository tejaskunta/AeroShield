# AeroShield Backend Guide (Additional Readme)

This file is an additional project readme and does not replace the main README.

## Overview

AeroShield is an AI-assisted drone landmine detection and mapping project.
Current implementation in this repository focuses on a clean FastAPI backend foundation.

## Current Backend Progress

- Phase 1 complete: FastAPI app, root endpoint, health endpoint, Swagger docs.
- Phase 2 complete: image upload detection endpoint with a dummy/mock detector.

## Backend Folder

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

## Run (Windows PowerShell)

From project root:

```powershell
& ".\\.venv\\Scripts\\python.exe" -m pip install -r .\\backend\\requirements.txt
& ".\\.venv\\Scripts\\python.exe" -m uvicorn app.main:app --reload --app-dir .\\backend
```

From backend folder:

```powershell
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

## Endpoints

- GET / -> {"message": "AeroShield API is running"}
- GET /health -> {"status": "healthy"}
- POST /api/detect -> mock detection response for uploaded image

## Swagger

Open:

- http://127.0.0.1:8000/docs

## Important Note

The detection route currently uses a mock service.
Later, it can be swapped with a YOLO model service without breaking the API route contract.
