"""AeroShield - the copilot knowledge corpus (PRD section 5.1, RAG Safety Copilot).

This is the set of passages the copilot is allowed to answer from. It is deliberately
small and hand-written: it stands in for the full IMAS / national-standards document
set the project would ingest in production, and each chunk carries the same metadata
(document, clause, page) a real ingestion pipeline would extract, so the citations the
copilot returns are honest references to *this* corpus.

WHY IT LIVES IN CODE AND NOT ONLY IN CHROMA.
The retrieval layer (copilot_rag.py) indexes these chunks into Chroma when it is
available, but the chunks themselves are the source of truth and are re-embedded on
demand when it is not. Keeping the text here means the offline fallback and the online
path answer from exactly the same passages — the demo cannot drift between "with
Chroma" and "without Chroma", which would be a confusing thing to discover live.

SAFETY NOTE ON CONTENT.
Every answer is framed as decision support, not a clearance authorisation, mirroring
the copilot's own intro. The wording is conservative on purpose: in mine action, an
assistant that sounds confident about something it is not authoritative on is the most
dangerous failure mode in the system. These passages say "treat as", "hold outside",
"until verified" — provisional language for provisional data.
"""

from typing import List

from app.schemas.copilot import Citation


class CorpusChunk:
    """One retrievable passage, with the citation it produces when matched."""

    def __init__(
        self,
        chunk_id: str,
        document: str,
        clause: str,
        page: int,
        text: str,
    ) -> None:
        self.id = chunk_id
        self.document = document
        self.clause = clause
        self.page = page
        self.text = text

    def citation(self, relevance: float) -> Citation:
        """Render as a UI citation. `excerpt` is the passage itself, truncated."""
        excerpt = self.text if len(self.text) <= 320 else self.text[:317].rstrip() + "..."
        return Citation(
            id=self.id,
            document=self.document,
            clause=self.clause,
            page=self.page,
            excerpt=excerpt,
            relevance=round(max(0.0, min(1.0, relevance)), 2),
        )


# --- the corpus ---------------------------------------------------------------
# A handful of standards-shaped passages covering the questions a field operator
# actually asks: standoff, confidence, marking, case type, clearance, geolocation
# error. Written to be genuinely useful answers, not lorem filler — if the copilot
# cites one, a person should be able to act on it.

CORPUS: List[CorpusChunk] = [
    CorpusChunk(
        chunk_id="imas-09-10-7-2",
        document="IMAS 09.10",
        clause="7.2 Marking of hazards",
        page=14,
        text=(
            "A hazardous area shall be treated as extending beyond the located item to "
            "account for positional uncertainty and the possibility of additional items. "
            "For a suspected metal-cased anti-personnel mine, ground personnel should hold "
            "outside a 25 m radius until the area is verified, and approach only along a "
            "lane cleared from a known-safe start. Aerial detection gives a position "
            "estimate with several metres of error, so any standoff must absorb that error "
            "rather than walking to the reported point."
        ),
    ),
    CorpusChunk(
        chunk_id="imas-10-20-5-4",
        document="IMAS 10.20",
        clause="5.4 Safety distances",
        page=9,
        text=(
            "Minimum safety distances shall be established on the basis of the greatest "
            "credible threat and maintained until the area is confirmed clear. Distances "
            "are reduced only by a competent authority after verification, never by an "
            "automated system's confidence score."
        ),
    ),
    CorpusChunk(
        chunk_id="ops-3-1-bands",
        document="AeroShield Ops Note",
        clause="3.1 Confidence bands",
        page=3,
        text=(
            "Detections below the review threshold are retained for human adjudication and "
            "never auto-dismissed; the model reports likelihood, not ground truth. A "
            "low-confidence detection is a reason for a human to inspect the frame and the "
            "Grad-CAM activation map, not a reason to clear or to condemn the ground. "
            "Confidence is a triage signal, not a verdict."
        ),
    ),
    CorpusChunk(
        chunk_id="imas-08-40-6-1",
        document="IMAS 08.40",
        clause="6.1 Marking systems",
        page=11,
        text=(
            "Marking shall use red to indicate the hazardous side and white the safe side, "
            "and shall be intelligible to all personnel who may enter the area. The marking "
            "of a hazardous area shall be recorded and reported through the information "
            "management system, with the grid reference and confirmed coordinate handed to "
            "the ground team alongside the standoff distance."
        ),
    ),
    CorpusChunk(
        chunk_id="imas-09-10-4-3",
        document="IMAS 09.10",
        clause="4.3 Detection methods",
        page=8,
        text=(
            "Where minimum-metal or plastic-cased items are suspected, detection and "
            "clearance drills shall not rely solely on metal detection; prodding, dual-"
            "sensor, or ground-penetrating radar methods may be required. A plastic-cased "
            "detection does not change the immediate action — stand off and mark — but the "
            "case type should be flagged in the report so the clearance team plans for a "
            "low-metal target."
        ),
    ),
    CorpusChunk(
        chunk_id="ops-5-2-geolocation",
        document="AeroShield Ops Note",
        clause="5.2 Positional accuracy",
        page=6,
        text=(
            "Every geotagged detection carries a 1-sigma horizontal error estimate combining "
            "GPS accuracy, altitude error, heading error and box-centroid jitter. It excludes "
            "terrain slope, camera tilt and lens distortion, so the true error is often "
            "larger. Render detections as an uncertainty circle, not a pin, and never present "
            "a coordinate as precise to better than the reported error."
        ),
    ),
    CorpusChunk(
        chunk_id="imas-07-11-4-1",
        document="IMAS 07.11",
        clause="4.1 Survey and non-technical",
        page=12,
        text=(
            "Aerial imagery survey identifies visible surface indicators and suspected items; "
            "it is a means of narrowing where ground investigation is required, not a means "
            "of releasing land. No area may be declared clear on the basis of imagery alone. "
            "A negative aerial pass — no detections — reduces suspicion; it does not prove "
            "absence, because an RGB sensor cannot see buried objects."
        ),
    ),
    CorpusChunk(
        chunk_id="ops-6-3-reporting",
        document="AeroShield Ops Note",
        clause="6.3 Mission reporting",
        page=8,
        text=(
            "A mission report shall state the sensor limits as plainly as its findings: that "
            "detection is of visible landmine-like objects and surface indicators only, that "
            "positions carry a stated error budget, and that every retained detection is "
            "subject to human adjudication. The report supports a decision; it does not "
            "authorise one."
        ),
    ),
]


def chunks_by_id():
    """Index the corpus by chunk id, for the retrieval layer to attach metadata."""
    return {chunk.id: chunk for chunk in CORPUS}
