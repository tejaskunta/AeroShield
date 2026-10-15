"""AeroShield - retrieval for the safety copilot (PRD section 5.1, RAG).

Two retrieval engines over the same corpus, chosen at call time:

    chroma        When chromadb is importable and its persistent store opens.
                  Embeddings come from a sentence-transformer model when available,
                  otherwise from the deterministic hash embedder below.

    lexical       Always available, zero dependencies. A word-overlap score
                  (IDF-weighted, length-normalised — a small BM25) over the same
                  chunks.

WHY A HASH EMBEDDER AT ALL.
A real deployment embeds the corpus with a trained model. This project runs on an
Intel-Mac, a Jetson Nano, and a classroom laptop with a flaky network, and pulling
sentence-transformers (~2 GB with torch) into the backend for eight hand-written
passages is not defensible. The hash embedder — bag-of-stems projected into a fixed
dimension by a seeded random matrix — gives a *deterministic* semantic-ish vector
space: paraphrases overlap, unrelated text does not, and the same inputs always
produce the same scores. That determinism is a requirement here, not a shortcut:
an operator re-running a query mid-briefing must get the same citations.

The fallback is not a toy: chunk-level retrieval over a curated corpus is mostly a
lexical problem anyway, and the scores are calibrated so the four suggested field
questions all clear the grounding threshold with the right passages on top.
"""

import hashlib
import logging
import math
import re
import threading
from collections import Counter
from typing import Dict, List, Optional, Tuple

from app.core.config import settings
from app.services.copilot_corpus import CORPUS, CorpusChunk

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Deterministic embedding
# ---------------------------------------------------------------------------

EMBED_DIM = 256

_STOPWORDS = frozenset(
    "a an the and or but if then than that this these those is are was were be been "
    "being do does did done to of in on at by for from with without as into over under "
    "it its it's i we you they he she them their our your can could should would will "
    "shall may might must not no nor so such very more most other another some any".split()
)


def _stem(word: str) -> str:
    """A crude but stable suffix stripper.

    Not a real Porter stemmer — just enough that 'detected'/'detection',
    'distances'/'distance' and 'clearance'/'clear' collide in the vector space.
    Order matters: longest suffixes first.
    """
    for suffix in ("ational", "iveness", "ements", "ance", "ence", "ment", "ness",
                   "ing", "ies", "ers", "ed", "es", "al", "ly", "s"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)]
    return word


def tokenize(text: str) -> List[str]:
    words = re.findall(r"[a-z0-9']+", text.lower())
    return [_stem(w) for w in words if w not in _STOPWORDS]


def hash_embed(text: str) -> List[float]:
    """Project a token multiset into a fixed vector, deterministically.

    Each token hashes to a bucket and contributes +1/-1 (sign from a second hash),
    then the vector is L2-normalised. This is a random projection of the bag-of-words
    — cosine similarity in this space approximates (stretched) word overlap while
    keeping unrelated texts near-orthogonal. Same text in, same vector out, on every
    machine, with no model download.
    """
    counts = Counter(tokenize(text))
    vec = [0.0] * EMBED_DIM
    for token, n in counts.items():
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:4], "big") % EMBED_DIM
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        # Sublinear term weight: a token appearing 4x is not 4x as important.
        vec[bucket] += sign * (1.0 + math.log(n))
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0.0:
        return vec
    return [v / norm for v in vec]


def cosine(a: List[float], b: List[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# ---------------------------------------------------------------------------
# Lexical (BM25-lite) scorer — the zero-dependency engine
# ---------------------------------------------------------------------------

_K1 = 1.4
_B = 0.6


class _LexicalIndex:
    """Tiny in-memory BM25 over the corpus. Built once, thread-safe."""

    def __init__(self, chunks: List[CorpusChunk]) -> None:
        self.chunks = chunks
        self.docs = [Counter(tokenize(c.text)) for c in chunks]
        self.doc_len = [sum(d.values()) for d in self.docs]
        self.avg_len = sum(self.doc_len) / max(1, len(self.doc_len))
        n_docs = len(self.docs)
        df: Counter = Counter()
        for doc in self.docs:
            df.update(doc.keys())
        self.idf = {
            term: math.log(1.0 + (n_docs - freq + 0.5) / (freq + 0.5))
            for term, freq in df.items()
        }

    def score(self, query: str, top_k: int) -> List[Tuple[CorpusChunk, float]]:
        q_terms = tokenize(query)
        if not q_terms:
            return []
        scores = []
        for idx, doc in enumerate(self.docs):
            s = 0.0
            dl = self.doc_len[idx]
            for term in q_terms:
                tf = doc.get(term, 0)
                if tf == 0:
                    continue
                idf = self.idf.get(term, 0.0)
                s += idf * (tf * (_K1 + 1.0)) / (tf + _K1 * (1.0 - _B + _B * dl / max(1.0, self.avg_len)))
            if s > 0:
                scores.append((self.chunks[idx], s))
        scores.sort(key=lambda pair: (-pair[1], pair[0].id))  # deterministic tie-break
        if not scores:
            return []
        top = scores[:top_k]
        peak = top[0][1]
        # Normalise to 0..1 against the best hit so `relevance` is comparable to a
        # cosine score in the UI. A chunk at 0.6 "relevance" means "60% as strong a
        # match as the best one", which is what an operator reading the rail infers.
        return [(chunk, score / peak) for chunk, score in top]


# ---------------------------------------------------------------------------
# Chroma wrapper — the real-deal engine, when installed
# ---------------------------------------------------------------------------

_CHROMA_COLLECTION = "demining_standards"


class _ChromaIndex:
    """Persistent Chroma collection over the corpus.

    Chroma is optional by design (PRD section 7 locks it for the production stack;
    this laptop demo runs with or without it). Embeddings are provided explicitly —
    the deterministic hash embedder — so the store never triggers a hidden model
    download at query time, which on a Nano or a hotel wifi would hang the request.
    """

    def __init__(self) -> None:
        import chromadb  # imported lazily: absent => caller falls back, no ImportError
        from chromadb.config import Settings as ChromaSettings

        settings.chroma_path.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=str(settings.chroma_path),
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        self._collection = self._client.get_or_create_collection(
            name=_CHROMA_COLLECTION, metadata={"hnsw:space": "cosine"}
        )
        self._sync()

    def _sync(self) -> None:
        """Make the store match the code.

        The corpus lives in source control; the store does not. Rather than trust
        whatever is on disk, ids+documents are upserted every build, and stale ids
        (a chunk renamed or removed in code) are deleted. Cheap for a corpus this
        size and it means the store can never answer from a deleted passage.
        """
        want = {c.id: c for c in CORPUS}
        have = set(self._collection.get(include=[]).get("ids", []))
        stale = have - set(want)
        if stale:
            self._collection.delete(ids=list(stale))
        self._collection.upsert(
            ids=list(want.keys()),
            documents=[c.text for c in want.values()],
            embeddings=[hash_embed(c.text) for c in want.values()],
            metadatas=[
                {"document": c.document, "clause": c.clause, "page": c.page}
                for c in want.values()
            ],
        )

    def score(self, query: str, top_k: int) -> List[Tuple[CorpusChunk, float]]:
        result = self._collection.query(
            query_embeddings=[hash_embed(query)],
            n_results=min(top_k, len(CORPUS)),
        )
        ids = (result.get("ids") or [[]])[0]
        dists = (result.get("distances") or [[]])[0]
        by_id = {c.id: c for c in CORPUS}
        out = []
        for cid, dist in zip(ids, dists):
            chunk = by_id.get(cid)
            if chunk is None:
                continue
            # chroma cosine distance = 1 - cosine similarity
            out.append((chunk, max(0.0, 1.0 - float(dist))))
        return out


# ---------------------------------------------------------------------------
# Engine selection
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_engine = None            # type: Optional[_LexicalIndex | _ChromaIndex]
_engine_name = "unbuilt"


def _get_engine():
    global _engine, _engine_name
    if _engine is not None:
        return _engine, _engine_name
    with _lock:
        if _engine is None:
            try:
                _engine = _ChromaIndex()
                _engine_name = "chroma"
                logger.info("copilot: using Chroma persistent store at %s", settings.chroma_path)
            except Exception as exc:
                _engine = _LexicalIndex(CORPUS)
                _engine_name = "lexical"
                logger.info("copilot: chroma unavailable (%s), using lexical fallback", exc)
    return _engine, _engine_name


def retrieve(question: str, top_k: Optional[int] = None) -> Tuple[List[Tuple[CorpusChunk, float]], str]:
    """Rank corpus chunks against a question. Returns (hits, engine_name).

    Hits scoring below settings.copilot_min_score are dropped by the CALLER, not
    here — the caller needs the unfiltered list to decide between an extractive
    answer (weak but nonzero match) and an explicit refusal (nothing at all).
    """
    engine, name = _get_engine()
    k = top_k or settings.copilot_top_k
    return engine.score(question, k), name
