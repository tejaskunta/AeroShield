"""AeroShield - safety copilot schemas (PRD section 5.1).

The response shape mirrors `CopilotMessage` / `Citation` in the frontend types
(`frontend/src/types/index.ts`) field for field, so wiring the UI to this endpoint is
a matter of pointing `askCopilot` at it — no transform layer. The frontend contract is
treated as the API contract here for the same reason the ingest path mirrors it.
"""

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class Citation(BaseModel):
    """A retrieved source behind part of an answer.

    In this domain an answer without provenance is worse than no answer, so citations
    are a first-class part of the response and the UI gives them their own rail.
    `relevance` is the retrieval score so a weak match is visibly weak.
    """

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "imas-09-10-7-2",
                "document": "IMAS 09.10",
                "clause": "7.2 Marking of hazards",
                "page": 14,
                "excerpt": "A hazardous area shall be treated as extending beyond ...",
                "relevance": 0.91,
            }
        }
    )

    id: str
    document: str = Field(description="The standard or manual, e.g. 'IMAS 09.10'")
    clause: str = Field(description="Section/clause reference within the document")
    page: int
    excerpt: str = Field(description="The passage that supported the answer")
    relevance: float = Field(ge=0.0, le=1.0, description="Retrieval score 0..1")


class CopilotQuery(BaseModel):
    """POST /api/copilot/query — an operator's question."""

    model_config = ConfigDict(
        json_schema_extra={"example": {"question": "What standoff for a suspected metal mine?"}}
    )

    question: str = Field(min_length=1, max_length=2000)


class CopilotAnswer(BaseModel):
    """The copilot's reply.

    `grounded` is the safety-critical flag: False means nothing in the corpus cleared
    the relevance threshold, so the text is an explicit refusal to guess rather than a
    generated answer. The UI must render the two differently, never with equal
    authority.

    `engine` names what actually produced the answer ('groq', 'extractive',
    'ungrounded') so the demo can be honest about which path ran.
    """

    text: str
    citations: List[Citation] = Field(default_factory=list)
    grounded: bool = Field(
        description="False when no source cleared the threshold — the answer refuses to guess"
    )
    engine: str = Field(description="'groq' | 'extractive' | 'ungrounded'")
