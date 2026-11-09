"""AeroShield - mission report endpoint tests (PRD 5.1).

The report is the artifact this whole pipeline exists to produce, so the tests
guard three properties:

  * the numbers are true — tallies reflect the review decisions actually stored,
    the register lists the mission's detections, and optional coverage figures
    pass through (absent stays null, never a fabricated zero);
  * the provenance is honest — `engine` and `renderer` name the path that actually
    ran, and `generated_by` comes from the credential, not the request body;
  * the file is contained — a crafted report id cannot escape the reports directory,
    because the id arrives from a URL and must be treated as attacker-controlled.

Everything here runs keyless and WeasyPrint-less — the classroom configuration.
The template narrative and the styled-HTML artifact are the tested paths, not a
degraded exception.
"""

from app.services import report_service
from tests.conftest import auth
from tests.factories import detection_payload


async def _mission(client, key, name):
    response = await client.post("/api/missions", json={"name": name}, headers=auth(key))
    assert response.status_code == 201
    return response.json()["id"]


async def _detection(client, key, mission_id, **overrides):
    response = await client.post(
        "/api/detections",
        json=detection_payload(mission_id=mission_id, **overrides),
        headers=auth(key),
    )
    assert response.status_code == 201
    return response.json()["id"]


class TestGenerate:
    async def test_generates_offline_report(self, client, full_key, monkeypatch):
        """No Groq key => the template writes the narrative, and the report says so."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "groq_api_key", "", raising=False)

        mission_id = await _mission(client, full_key, "report-flight")
        detection_id = await _detection(client, full_key, mission_id)

        response = await client.post(
            "/api/reports", json={"mission_id": mission_id}, headers=auth(full_key)
        )
        assert response.status_code == 201
        body = response.json()

        assert body["mission_id"] == mission_id
        assert body["mission_name"] == "report-flight"
        assert body["status"] == "draft"
        assert body["engine"] == "template"
        assert body["renderer"] in ("html", "weasyprint")
        # generated_by is the authenticated principal's name, not a client field.
        assert body["generated_by"] == "test-full"
        assert body["detection_ids"] == ["D-{0:04d}".format(detection_id)]
        assert body["tallies"]["total"] == 1
        assert body["tallies"]["unreviewed"] == 1
        assert body["summary"]
        # The template cannot invent: the mission name it reports is the one stored.
        assert "report-flight" in body["summary"]

    async def test_tallies_reflect_review_decisions(self, client, full_key):
        """The headline numbers are the audit trail, so they must match what was
        actually adjudicated — this is what separates a report from a row count."""
        mission_id = await _mission(client, full_key, "tally-flight")
        first = await _detection(client, full_key, mission_id)
        second = await _detection(client, full_key, mission_id)
        await _detection(client, full_key, mission_id)  # stays unreviewed

        await client.patch(
            "/api/detections/{0}/review".format(first),
            json={"state": "confirmed"}, headers=auth(full_key),
        )
        await client.patch(
            "/api/detections/{0}/review".format(second),
            json={"state": "dismissed"}, headers=auth(full_key),
        )

        response = await client.post(
            "/api/reports", json={"mission_id": mission_id}, headers=auth(full_key)
        )
        tallies = response.json()["tallies"]
        assert tallies == {
            "total": 3, "confirmed": 1, "dismissed": 1, "flagged": 0, "unreviewed": 1,
        }

    async def test_coverage_passes_through_absent_stays_null(self, client, full_key):
        """Area/coverage live on the survey plan, not the database. Provided values are
        echoed; omitted ones stay null rather than becoming a fabricated zero."""
        mission_id = await _mission(client, full_key, "coverage-flight")

        with_figures = await client.post(
            "/api/reports",
            json={"mission_id": mission_id, "area_surveyed_m2": 12345.0, "coverage_pct": 42.0},
            headers=auth(full_key),
        )
        assert with_figures.json()["area_surveyed_m2"] == 12345.0
        assert with_figures.json()["coverage_pct"] == 42.0

        without = await client.post(
            "/api/reports", json={"mission_id": mission_id}, headers=auth(full_key)
        )
        assert without.json()["area_surveyed_m2"] is None
        assert without.json()["coverage_pct"] is None

    async def test_mark_final(self, client, full_key):
        mission_id = await _mission(client, full_key, "final-flight")
        response = await client.post(
            "/api/reports",
            json={"mission_id": mission_id, "mark_final": True},
            headers=auth(full_key),
        )
        assert response.json()["status"] == "final"

    async def test_empty_mission_still_reports(self, client, full_key):
        """A flight with zero detections is a finding, not an error — the report says
        the ground surveyed can be considered clear pending the flight track."""
        mission_id = await _mission(client, full_key, "clean-flight")
        response = await client.post(
            "/api/reports", json={"mission_id": mission_id}, headers=auth(full_key)
        )
        assert response.status_code == 201
        assert response.json()["tallies"]["total"] == 0
        assert "clear" in response.json()["summary"].lower()

    async def test_unknown_mission_is_404(self, client, full_key):
        response = await client.post(
            "/api/reports", json={"mission_id": 9999}, headers=auth(full_key)
        )
        assert response.status_code == 404
        assert "9999" in response.json()["detail"]

    async def test_read_key_can_generate(self, client, full_key, read_key):
        """Generation is a dashboard action: it changes nothing in the database, so
        requiring a write scope would block the plain key from the artifact it exists
        for. The audit value is covered by generated_by being server-stamped."""
        mission_id = await _mission(client, full_key, "dashboard-flight")
        response = await client.post(
            "/api/reports", json={"mission_id": mission_id}, headers=auth(read_key)
        )
        assert response.status_code == 201
        assert response.json()["generated_by"] == "test-dashboard"

    async def test_drone_key_cannot_generate(self, client, full_key, drone_key):
        mission_id = await _mission(client, full_key, "drone-blocked")
        response = await client.post(
            "/api/reports", json={"mission_id": mission_id}, headers=auth(drone_key)
        )
        assert response.status_code == 403


class TestListAndDocument:
    async def test_list_empty_then_newest_first(self, client, full_key):
        """An empty list is a valid answer, not a failure — the UI shows its empty state."""
        empty = await client.get("/api/reports", headers=auth(full_key))
        assert empty.status_code == 200
        assert empty.json() == []

        first_mission = await _mission(client, full_key, "list-a")
        second_mission = await _mission(client, full_key, "list-b")
        for mission_id in (first_mission, second_mission):
            await client.post(
                "/api/reports", json={"mission_id": mission_id}, headers=auth(full_key)
            )

        listed = await client.get("/api/reports", headers=auth(full_key))
        reports = listed.json()
        assert len(reports) == 2
        stamps = [r["generated_at"] for r in reports]
        assert stamps == sorted(stamps, reverse=True)

    async def test_document_downloads_with_matching_renderer(self, client, full_key):
        """The media type comes from the file that actually exists — an HTML artifact
        is served as HTML, never labelled a PDF it is not."""
        mission_id = await _mission(client, full_key, "doc-flight")
        generated = await client.post(
            "/api/reports", json={"mission_id": mission_id}, headers=auth(full_key)
        )
        body = generated.json()
        assert body["pdf_url"] == "/api/reports/{0}/document".format(body["id"])

        document = await client.get(body["pdf_url"], headers=auth(full_key))
        assert document.status_code == 200
        if body["renderer"] == "html":
            assert document.headers["content-type"].startswith("text/html")
            assert "doc-flight" in document.text
        else:
            assert document.headers["content-type"].startswith("application/pdf")
            assert document.content[:4] == b"%PDF"

    async def test_missing_document_is_404(self, client, full_key):
        response = await client.get(
            "/api/reports/RPT-MSN1-19700101000000/document", headers=auth(full_key)
        )
        assert response.status_code == 404

    async def test_traversal_cannot_escape_reports_dir(self, client, full_key):
        """The id arrives from the URL and must be treated as attacker-controlled.

        Checked at the service layer, where the containment rule lives — an HTTP-level
        test would depend on how the client and router each normalise dots and slashes,
        and the guard should not rely on either.
        """
        assert report_service.document_path("../../app/main") is None
        assert report_service.load("../../app/main") is None
        assert report_service.document_path("RPT-../secrets") is None


class TestReportsAuth:
    async def test_no_key_is_401(self, client):
        response = await client.get("/api/reports")
        assert response.status_code == 401
