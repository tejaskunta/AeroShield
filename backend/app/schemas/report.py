"""AeroShield - mission report schemas (PRD section 5.1).

`ReportRecord` mirrors the frontend `MissionReport` type so the Reports screen can
switch from fixtures to this endpoint without a transform. The stats it summarises
come from `MissionStats` (PostgreSQL aggregates); the narrative comes from the report
agent (Groq LLM, or a deterministic template offline); the PDF is rendered by
WeasyPrint when it is installed, and the endpoint says which renderer produced it
rather than pretending.
"""

from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ReportTallies(BaseModel):
    """Detection counts by review state — the headline numbers of a report.

    Mirrors the frontend's `tallies` shape exactly. Detections with no review row
    count as `unreviewed`, which is the honest default: absence of a decision is a
    decision state, not zero.
    """

    total: int
    confirmed: int
    dismissed: int
    flagged: int
    unreviewed: int


class ReportRead(BaseModel):
    """A generated report, as listed/returned by the API."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "RPT-12",
                "mission_id": 12,
                "mission_name": "field-test-1",
                "status": "draft",
                "generated_at": "2026-09-26T10:00:00Z",
                "generated_by": "drone-01",
                "summary": "Survey of ... completed...",
                "engine": "groq",
                "renderer": "weasyprint",
                "pdf_url": "/api/reports/RPT-12/pdf",
                "tallies": {"total": 9, "confirmed": 3, "dismissed": 4,
                            "flagged": 0, "unreviewed": 2},
                "detection_ids": ["D-101", "D-102"],
            }
        }
    )

    id: str
    mission_id: int
    mission_name: str
    site: str = Field(
        default="", description="Human name for the surveyed area. Derived from the "
        "mission description when set, else the detection bounding box."
    )
    status: str = Field(description="'draft' | 'final'")
    generated_at: datetime
    generated_by: str
    summary: str = Field(description="The narrative the report agent composed")
    engine: str = Field(description="'groq' | 'template' — what wrote the narrative")
    renderer: str = Field(
        description="'weasyprint' | 'html' — what produced the document; 'html' means "
                    "the PDF renderer is unavailable and the styled HTML is the artifact"
    )
    area_surveyed_m2: Optional[float] = None
    coverage_pct: Optional[float] = None
    flight_time_s: Optional[float] = None
    tallies: ReportTallies
    detection_ids: List[str] = Field(
        default_factory=list, description="Detection ids in the register table"
    )
    pdf_url: Optional[str] = None
    stats: Dict[str, object] = Field(
        default_factory=dict, description="The MissionStats the report was built from"
    )


class ReportGenerateRequest(BaseModel):
    """POST /api/reports — generate (or regenerate) a report for a mission."""

    mission_id: int = Field(ge=1)
    mark_final: bool = Field(
        default=False,
        description="Stamp the report 'final' instead of 'draft'. A final report is a "
                    "record; a draft can be regenerated as the mission evolves.",
    )
    # Optional coverage figures. The backend knows detection counts and durations,
    # but "area surveyed / % of block" belongs to the survey plan, which lives on the
    # ground station (the mission grid). The dashboard passes them through so the
    # report's headline numbers match what the operator was shown. Absent = null in
    # the report, not a fabricated zero.
    area_surveyed_m2: Optional[float] = Field(default=None, ge=0.0)
    coverage_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
