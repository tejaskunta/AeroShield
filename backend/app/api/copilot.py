"""AeroShield - safety copilot endpoints (PRD section 5.1).

`POST /api/copilot/query` is the endpoint `askCopilot` in the frontend has been
pointing at a keyword stub for. The response shape matches the frontend's
`CopilotMessage` contract so the UI swap is body-only.

Auth: `detections:read` — the same scope the dashboard holds. A copilot that answers
safety questions should not be open to the whole internet, but it is a read-side
feature: it needs no ingest or admin rights.
"""

import logging

from fastapi import APIRouter, Depends

from app.core.dependencies import Principal, require_scope
from app.core.security import SCOPE_DETECTIONS_READ
from app.schemas.copilot import CopilotAnswer, CopilotQuery
from app.services import copilot_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/copilot", tags=["Copilot"])


@router.post(
    "/query",
    response_model=CopilotAnswer,
    summary="Ask the safety copilot a field question",
    description=(
        "Retrieval-augmented answer grounded in the loaded demining standards. "
        "Every grounded answer carries its source passages as citations; an answer "
        "with no source clears the bar for `grounded: false` and says so rather "
        "than guessing. The `engine` field reports which path composed the reply "
        "(`groq`, `extractive`, or `ungrounded`)."
    ),
)
async def copilot_query(
    payload: CopilotQuery,
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> CopilotAnswer:
    return await copilot_service.answer(payload.question)
