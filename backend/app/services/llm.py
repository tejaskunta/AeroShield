"""AeroShield - Groq LLM client (PRD section 7: "Claude or GPT API").

Groq serves Llama-3-class models over an OpenAI-compatible chat-completions API with a
free tier and sub-second latency, which is what makes it usable in a live classroom
demo. The endpoint and payload follow the OpenAI schema, so swapping to a different
provider is a base-url/model change, not a code change.

THE RULE THIS MODULE ENFORCES: it never raises.
Every AI feature in this system must degrade to a deterministic offline answer when
the key is missing, the network is down, or the request fails — a copilot that shows a
traceback in front of a reviewer is worse than one that says "retrieval only". So
`complete()` returns None on ANY failure and the caller falls back. The reason is
logged, never surfaced as an exception.

httpx is already a dependency (the test client uses it); no new package is needed.
"""

import json
import logging
from typing import List, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


def llm_available() -> bool:
    """True when an LLM call will actually be attempted.

    Checks the key only — not reachability. A configured key with no network is
    handled by complete() returning None, which is the same fallback path.
    """
    return bool(settings.groq_api_key)


async def complete(
    system: str,
    user: str,
    max_tokens: int = 600,
    temperature: float = 0.2,
) -> Optional[str]:
    """One chat completion. Returns the text, or None if it cannot be produced.

    temperature is low on purpose: this is a safety domain, and creative rephrasing
    of a standoff distance is not what the copilot is for. The retrieval layer, not
    the model, decides what the answer is based on; the model only composes it.
    """
    if not settings.groq_api_key:
        logger.debug("groq: no API key configured, skipping LLM call")
        return None

    messages: List[dict] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout_s) as client:
            response = await client.post(
                f"{settings.groq_base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {settings.groq_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": settings.groq_model,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
        response.raise_for_status()
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        return content.strip() if content else None
    except httpx.HTTPStatusError as exc:
        # Groq returns a JSON error body; keep the message short and log the rest.
        detail = ""
        try:
            detail = json.dumps(exc.response.json(), ensure_ascii=False)[:300]
        except Exception:
            detail = exc.response.text[:200]
        logger.warning("groq HTTP %s: %s", exc.response.status_code, detail)
        return None
    except Exception as exc:  # network errors, JSON shape surprises, timeouts
        logger.warning("groq request failed: %s", exc)
        return None
