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
