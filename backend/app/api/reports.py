"""AeroShield - mission report endpoints (PRD section 5.1).

Three routes: list the reports that exist, generate one for a mission, and download
its document. The work happens in `report_service`; this layer only maps HTTP to it
and translates a missing mission into a 404.

Scope choices follow the same logic as the rest of the API. Reading and downloading
reports is a dashboard action (`detections:read`). Generating one is deliberately
also `detections:read` rather than a write scope: a report changes nothing in the
database — it is a derived document written to storage — so requiring `missions:write`
would stop the plain dashboard key from producing the shareable artifact it exists
for, without protecting anything. The audit value is already covered: `generated_by`
is stamped from the authenticated principal, never from the request body.
"""

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import Principal, require_scope
from app.core.security import SCOPE_DETECTIONS_READ
from app.db.session import get_db
from app.schemas.report import ReportGenerateRequest, ReportRead
from app.services import report_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/reports", tags=["Reports"])


@router.get(
    "",
    response_model=List[ReportRead],
    summary="List generated mission reports",
)
async def list_reports(
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> List[ReportRead]:
    """Every report on file, newest first.

    No DB session: reports are filesystem sidecars (see report_service), so this is a
    directory read, not a query.
    """
    return report_service.list_reports()


@router.post(
    "",
    response_model=ReportRead,
    status_code=status.HTTP_201_CREATED,
    summary="Generate a mission report",
)
async def generate_report(
    payload: ReportGenerateRequest,
    db: AsyncSession = Depends(get_db),
    principal: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> ReportRead:
    """Build a report for one mission and persist it.

    The narrative may come from the LLM or the template, and the document from
    WeasyPrint or HTML — the response's `engine`/`renderer` fields say which, so a
    reader is never told a premium path ran when it did not. A 404 here means the
    mission id does not exist; there is nothing to report on.
    """
    try:
        report = await report_service.generate(
            db, payload, generated_by=principal.name
        )
    except LookupError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No mission with id {0}".format(payload.mission_id),
        )
    return report


@router.get(
    "/{report_id}/document",
    summary="Download a report document (PDF or HTML)",
)
async def download_report(
    report_id: str,
    _: Principal = Depends(require_scope(SCOPE_DETECTIONS_READ)),
) -> FileResponse:
    """Serve the report artifact.

    The id arrives from the URL, so report_service.document_path applies the same
    traversal guard the image endpoints use — a crafted id cannot reach outside the
    reports directory. PDF when WeasyPrint rendered it, HTML otherwise; the media type
    comes from the file that actually exists.
    """
    found = report_service.document_path(report_id)
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No report document for id {0}".format(report_id),
        )
    path, media_type = found
    filename = "{0}{1}".format(report_id, path.suffix)
    return FileResponse(path, media_type=media_type, filename=filename)
