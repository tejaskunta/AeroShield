"""AeroShield model registry.

Importing this package imports every model, which is what registers them on
Base.metadata. Alembic's migrations/env.py and the test harness both rely on that:
a model that is never imported is invisible to autogenerate and to create_all, and
the resulting "missing table" error points at the query rather than at the missing
import.
"""

from app.db.models.api_key import ApiKey
from app.db.models.detection import Detection
from app.db.models.mission import Mission, MissionStatus

__all__ = ["ApiKey", "Detection", "Mission", "MissionStatus"]
