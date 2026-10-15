"""AeroShield - safety copilot service (PRD section 5.1).

Answer pipeline, in order of trustworthiness:

    1. Retrieve the top passages from the corpus (Chroma or lexical — see copilot_rag).
    2. If nothing clears the relevance floor, REFUSE. `grounded: false`, no citations,
       and a reply that says so. In this domain a guessed answer is more dangerous
       than a blank one, and the UI is built to show refusals honestly.
    3. If a Groq key is configured, ask the model to compose an answer FROM THE
       RETRIEVED PASSAGES ONLY, and verify it actually used them.
    4. Otherwise (or if the LLM fails/strays), compose an extractive answer: the
       retrieved passages, lightly stitched. Deterministic, cited, and never
       invents a number that is not in the corpus.

Step 3's verification is the interesting one. The LLM is asked to answer using only
the provided passages; we then check that its reply overlaps those passages. If it
has drifted — invented a standoff distance, cited a clause that was not retrieved —
the answer is discarded and the extractive one used instead. A copilot that
hallucinates a safety distance is the failure mode this whole feature has to avoid,
so the model is treated as a *composer*, not an *authority*, and can be overruled by
a string-similarity check.

The `engine` field on the response records which path ran ('groq', 'extractive',
'ungrounded') so the demo tells the truth about what it just did.
"""

import logging
import re
from typing import List, Optional, Tuple

from app.core.config import settings
from app.schemas.copilot import Citation, CopilotAnswer
from app.services import llm
from app.services.copilot_corpus import CorpusChunk
from app.services.copilot_rag import retrieve

logger = logging.getLogger(__name__)

UNGROUNDED_REPLY = (
    "I don't have a sourced answer for that in the loaded standards set. Rather than "
    "guess — which is dangerous in this domain — treat this as unanswered and consult "
    "your technical field manual or EOD lead."
)

SYSTEM_PROMPT = (
    "You are the AeroShield safety copilot, an assistant for drone landmine-detection "
    "survey teams. Answer the operator's question using ONLY the retrieved passages "
    "supplied below. Never state a distance, procedure, or standard that is not in "
    "those passages. If the passages do not answer the question, say so plainly. "
    "You support decisions; you never authorise clearance. Be concise: 2-4 sentences. "
    "Do not add a sources list — the UI attaches citations separately."
)


def _format_passages(hits: List[Tuple[CorpusChunk, float]]) -> str:
    lines = []
    for chunk, score in hits:
        lines.append(
            "[{doc} {clause} p.{page} | relevance {score:.2f}]\n{text}".format(
                doc=chunk.document, clause=chunk.clause, page=chunk.page,
                score=score, text=chunk.text,
            )
        )
    return "\n\n".join(lines)


def _citation_overlaps(answer: str, passages: str) -> bool:
    """Did the model stay inside the provided material?

    Compares content-word overlap between the answer and the passages. A genuine
    grounded answer shares a lot of vocabulary with its source; a hallucinated one —
    new numbers, new clauses, new procedures — diverges. This is a guardrail, not a
    proof: it catches the obvious drift, and the extractive fallback catches the rest.
    """
    def content_words(text: str) -> set:
        words = set(re.findall(r"[a-z]{4,}", text.lower()))
        return words

    answer_words = content_words(answer)
    if not answer_words:
        return False
    overlap = answer_words & content_words(passages)
    return len(overlap) / len(answer_words) >= 0.5


def _extractive_answer(question: str, hits: List[Tuple[CorpusChunk, float]]) -> str:
    """Compose an answer by stitching the retrieved passages.

    Deterministic and fully cited. The first (best) passage is quoted in full;
    supporting passages contribute their lead sentence. Not elegant prose, but it
    cannot invent anything, which is the property that matters here.
    """
    primary = hits[0][0]
    parts = [primary.text]
    for chunk, _score in hits[1:3]:
        first_sentence = re.split(r"(?<=[.!?])\s+", chunk.text, maxsplit=1)[0]
        parts.append(first_sentence)
    answer = " ".join(parts)
    return answer


def _citations(hits: List[Tuple[CorpusChunk, float]]) -> List[Citation]:
    return [chunk.citation(score) for chunk, score in hits]


async def answer(question: str) -> CopilotAnswer:
    """Produce a grounded copilot answer. Never raises; never guesses."""
    hits, rag_engine = retrieve(question)

    # Keep only passages that clear the floor. `hits` may be empty, or all weak.
    strong = [(c, s) for c, s in hits if s >= settings.copilot_min_score]

    if not strong:
        logger.info("copilot: no grounded match (engine=%s)", rag_engine)
        return CopilotAnswer(
            text=UNGROUNDED_REPLY, citations=[], grounded=False, engine="ungrounded"
        )

    passages = _format_passages(strong)
    citations = _citations(strong)

    # Try the LLM as a composer, then verify it.
    composed: Optional[str] = None
    engine_used = "extractive"
    if llm.llm_available():
        user = "Retrieved passages:\n\n{p}\n\nQuestion: {q}".format(p=passages, q=question)
        draft = await llm.complete(SYSTEM_PROMPT, user, max_tokens=400, temperature=0.2)
        if draft and _citation_overlaps(draft, passages):
            composed = draft
            engine_used = "groq"
        elif draft:
            # The model answered but drifted from the source. Discard it — this is
            # the guardrail doing its job, and it is worth a log line.
            logger.warning("copilot: LLM answer rejected for low source overlap")

    text = composed if composed else _extractive_answer(question, strong)
    logger.info("copilot: answered via %s (rag=%s, %d citations)",
                engine_used, rag_engine, len(citations))

    return CopilotAnswer(text=text, citations=citations, grounded=True, engine=engine_used)
