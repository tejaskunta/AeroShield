"""AeroShield - safety copilot endpoint tests (PRD 5.1).

The contract these tests protect is the honesty of the answer, not its fluency:

  * a question the corpus does cover comes back grounded, cited, and with an
    `engine` naming the path that ran;
  * a question it does not cover comes back `grounded: false` with an explicit
    refusal — the dangerous failure mode in this domain is a confident guess,
    so the refusal is the feature;
  * every citation carries real provenance (document, clause, page, excerpt),
    because an answer without sources is worse than no answer.

All of this runs with no Groq key and no Chroma installed, which is the classroom
demo configuration: the extractive fallback over the built-in scorer is the path
under test. A key would only swap the composer, not the guarantees.
"""

from tests.conftest import auth


class TestGroundedAnswers:
    async def test_covered_question_is_grounded_and_cited(self, client, read_key):
        """A standoff question matches the IMAS marking/safety-distance chunks."""
        response = await client.post(
            "/api/copilot/query",
            json={"question": "What standoff distance for a suspected metal-cased mine?"},
            headers=auth(read_key),
        )
        assert response.status_code == 200
        body = response.json()

        assert body["grounded"] is True
        assert body["engine"] in ("groq", "extractive")
        assert len(body["citations"]) >= 1

        # The best-matching chunk is the 25 m standoff passage; the answer must
        # actually reflect what it retrieved, not just carry a citation label.
        cited_ids = {c["id"] for c in body["citations"]}
        assert "imas-09-10-7-2" in cited_ids
        assert "25" in body["text"]

    async def test_citations_carry_full_provenance(self, client, read_key):
        """Each citation is actionable: document, clause, page, excerpt, relevance."""
        response = await client.post(
            "/api/copilot/query",
            json={"question": "How should detections be marked on the ground?"},
            headers=auth(read_key),
        )
        body = response.json()
        assert body["grounded"] is True
        for citation in body["citations"]:
            assert citation["document"]
            assert citation["clause"]
            assert isinstance(citation["page"], int)
            assert citation["excerpt"]
            assert 0.0 <= citation["relevance"] <= 1.0

    async def test_relevance_is_ranked(self, client, read_key):
        """Citations come back best-first — the rail shows the strongest source on top."""
        response = await client.post(
            "/api/copilot/query",
            json={"question": "Can a negative aerial pass declare land clear?"},
            headers=auth(read_key),
        )
        body = response.json()
        assert body["grounded"] is True
        scores = [c["relevance"] for c in body["citations"]]
        assert scores == sorted(scores, reverse=True)

    async def test_inflected_query_forms_are_grounded(self, client, read_key):
        """Every question the UI offers as a suggestion must actually be answerable.

        The UI's four suggested queries are the worst case for a lexical retriever,
        because they are written the way an operator speaks, not the way the corpus
        is written — "detector" for a passage about "detection", "mine" for one
        about "mines". Bag-of-words cannot see through that, so the stemmer has to.
        A suggested question that comes back refused is a demo that fails on its own
        prompt, so each of these is pinned here.
        """
        suggested = [
            "What standoff distance for a suspected mine?",
            "Can I trust a detection at 0.5 confidence?",
            "How should I mark a confirmed hazard for the ground team?",
            "What does the detector actually detect?",
        ]
        for question in suggested:
            response = await client.post(
                "/api/copilot/query", json={"question": question}, headers=auth(read_key)
            )
            assert response.status_code == 200
            body = response.json()
            assert body["grounded"] is True, "suggested query refused: %r" % question
            assert body["citations"], "suggested query returned no citations: %r" % question

    async def test_detector_wording_reaches_the_sensor_limits_passage(self, client, read_key):
        """'detector' must find the passages that only ever say 'detection'."""
        response = await client.post(
            "/api/copilot/query",
            json={"question": "What does the detector actually detect?"},
            headers=auth(read_key),
        )
        body = response.json()
        assert body["grounded"] is True
        cited_ids = {c["id"] for c in body["citations"]}
        assert cited_ids & {"imas-09-10-4-3", "ops-6-3-reporting"}


class TestStemmerConsistency:
    """The scorer is only as good as its tokeniser, and this tokeniser is custom."""

    def test_related_word_forms_share_a_stem(self):
        """Inflected and derived forms must collapse together.

        Regression guard: the first stemmer stripped one suffix in a single pass
        with a fixed 3-character floor, so `distance` -> `dist` while
        `distances` -> `distanc`, and `detector` never met `detection` at all.
        """
        from app.services.copilot_rag import _stem

        groups = [
            ["detect", "detector", "detectors", "detection", "detections", "detected"],
            ["distance", "distances"],
            ["mark", "marking", "markings", "marker", "markers"],
            ["mine", "mines"],
            ["report", "reports", "reporting"],
        ]
        for group in groups:
            stems = {_stem(word) for word in group}
            assert len(stems) == 1, "%r stemmed inconsistently: %r" % (group, stems)

    def test_stemmer_leaves_short_words_alone(self):
        """Short words must not be reduced to debris."""
        from app.services.copilot_rag import _stem

        for word in ["ais", "at", "end", "land", "map", "soil"]:
            assert _stem(word) == word


class TestUngroundedRefusals:
    async def test_off_topic_question_refuses(self, client, read_key):
        """Nothing in a demining corpus matches this — the copilot must say so rather
        than improvise. The refusal text is part of the contract the UI renders."""
        response = await client.post(
            "/api/copilot/query",
            json={"question": "What is the best recipe for banana bread?"},
            headers=auth(read_key),
        )
        assert response.status_code == 200
        body = response.json()

        assert body["grounded"] is False
        assert body["engine"] == "ungrounded"
        assert body["citations"] == []
        # The refusal names what to do instead of guessing.
        assert "guess" in body["text"].lower()

    async def test_empty_question_is_422(self, client, read_key):
        """min_length=1 on the schema: an empty question is a client bug, not a refusal."""
        response = await client.post(
            "/api/copilot/query", json={"question": ""}, headers=auth(read_key)
        )
        assert response.status_code == 422


class TestCopilotAuth:
    async def test_no_key_is_401(self, client):
        response = await client.post(
            "/api/copilot/query", json={"question": "standoff distance?"}
        )
        assert response.status_code == 401

    async def test_drone_key_cannot_query(self, client, drone_key):
        """The copilot is a read-side feature; a drone credential has no business
        asking it safety questions."""
        response = await client.post(
            "/api/copilot/query",
            json={"question": "standoff distance?"},
            headers=auth(drone_key),
        )
        assert response.status_code == 403
