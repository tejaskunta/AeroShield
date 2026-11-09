"""AeroShield - mission endpoint tests."""

from tests.conftest import auth
from tests.factories import detection_payload


class TestMissionCreation:
    async def test_create_returns_201(self, client, drone_key):
        response = await client.post(
            "/api/missions", json={"name": "flight-1", "description": "North paddock"},
            headers=auth(drone_key),
        )
        assert response.status_code == 201
        assert response.json()["status"] == "active"

    async def test_second_create_joins_existing(self, client, drone_key):
        """Get-or-create, not a 409.

        The drone calls this at every startup. A reboot mid-flight must rejoin the
        existing mission rather than fail or fork it - so the same name returns the
        same row, with 200 instead of 201 to signal it already existed.
        """
        first = await client.post("/api/missions", json={"name": "same-flight"},
                                  headers=auth(drone_key))
        second = await client.post("/api/missions", json={"name": "same-flight"},
                                   headers=auth(drone_key))

        assert first.status_code == 201
        assert second.status_code == 200
        assert first.json()["id"] == second.json()["id"]

    async def test_read_key_cannot_create(self, client, read_key):
        response = await client.post("/api/missions", json={"name": "nope"},
                                     headers=auth(read_key))
        assert response.status_code == 403


class TestMissionListing:
    async def test_list_includes_detection_count(self, client, full_key):
        """The count comes from one aggregate query, not N+1 per row."""
        await client.post("/api/missions", json={"name": "busy"}, headers=auth(full_key))
        for _ in range(3):
            await client.post("/api/detections", headers=auth(full_key),
                              json=detection_payload(mission_name="busy"))
        await client.post("/api/missions", json={"name": "quiet"}, headers=auth(full_key))

        response = await client.get("/api/missions", headers=auth(full_key))
        by_name = {m["name"]: m for m in response.json()["items"]}
        assert by_name["busy"]["detection_count"] == 3
        assert by_name["quiet"]["detection_count"] == 0

    async def test_filter_by_status(self, client, full_key):
        created = await client.post("/api/missions", json={"name": "done"},
                                    headers=auth(full_key))
        await client.patch(
            "/api/missions/{0}".format(created.json()["id"]),
            json={"status": "completed"}, headers=auth(full_key),
        )
        await client.post("/api/missions", json={"name": "ongoing"}, headers=auth(full_key))

        completed = await client.get("/api/missions?status=completed", headers=auth(full_key))
        assert [m["name"] for m in completed.json()["items"]] == ["done"]

    async def test_unknown_mission_is_404(self, client, full_key):
        response = await client.get("/api/missions/9999", headers=auth(full_key))
        assert response.status_code == 404


class TestMissionUpdate:
    async def test_completing_stamps_ended_at(self, client, full_key):
        """The report agent always needs a duration, so closing sets the end time."""
        created = await client.post("/api/missions", json={"name": "to-close"},
                                    headers=auth(full_key))
        assert created.json()["ended_at"] is None

        response = await client.patch(
            "/api/missions/{0}".format(created.json()["id"]),
            json={"status": "completed"}, headers=auth(full_key),
        )
        assert response.status_code == 200
        assert response.json()["status"] == "completed"
        assert response.json()["ended_at"] is not None

    async def test_invalid_status_rejected(self, client, full_key):
        created = await client.post("/api/missions", json={"name": "s"}, headers=auth(full_key))
        response = await client.patch(
            "/api/missions/{0}".format(created.json()["id"]),
            json={"status": "landed"}, headers=auth(full_key),
        )
        assert response.status_code == 422

    async def test_partial_update_leaves_other_fields(self, client, full_key):
        created = await client.post(
            "/api/missions", json={"name": "keep", "description": "original"},
            headers=auth(full_key),
        )
        response = await client.patch(
            "/api/missions/{0}".format(created.json()["id"]),
            json={"status": "aborted"}, headers=auth(full_key),
        )
        assert response.json()["description"] == "original"


class TestMissionStats:
    async def test_stats_aggregate_correctly(self, client, full_key):
        await client.post("/api/missions", json={"name": "stats"}, headers=auth(full_key))

        for class_name, confidence in [
            ("landmine_metal", 0.9),
            ("landmine_metal", 0.7),
            ("debris_negative", 0.5),
        ]:
            await client.post("/api/detections", headers=auth(full_key),
                              json=detection_payload(mission_name="stats",
                                                     class_name=class_name,
                                                     confidence=confidence))

        mission_id = (await client.get("/api/missions", headers=auth(full_key))
                      ).json()["items"][0]["id"]
        response = await client.get(
            "/api/missions/{0}/stats".format(mission_id), headers=auth(full_key)
        )
        assert response.status_code == 200

        stats = response.json()
        assert stats["total_detections"] == 3
        assert stats["by_class"] == {"landmine_metal": 2, "debris_negative": 1}
        assert stats["max_confidence"] == 0.9
        assert abs(stats["mean_confidence"] - 0.7) < 0.01
        assert stats["bounds"] is not None

    async def test_stats_separate_total_from_geotagged(self, client, full_key):
        """The gap is how much of the flight had no usable GPS lock.

        Reporting only the total would overstate what is actually mappable.
        """
        await client.post("/api/missions", json={"name": "gap"}, headers=auth(full_key))
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(mission_name="gap"))
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(mission_name="gap",
                                                 latitude=None, longitude=None))

        mission_id = (await client.get("/api/missions", headers=auth(full_key))
                      ).json()["items"][0]["id"]
        stats = (await client.get("/api/missions/{0}/stats".format(mission_id),
                                  headers=auth(full_key))).json()

        assert stats["total_detections"] == 2
        assert stats["geotagged_detections"] == 1

    async def test_stats_for_empty_mission(self, client, full_key):
        """Zero detections must not divide by zero or return nulls where a 0 belongs."""
        created = await client.post("/api/missions", json={"name": "empty"},
                                    headers=auth(full_key))
        stats = (await client.get(
            "/api/missions/{0}/stats".format(created.json()["id"]), headers=auth(full_key)
        )).json()

        assert stats["total_detections"] == 0
        assert stats["geotagged_detections"] == 0
        assert stats["by_class"] == {}
        assert stats["mean_confidence"] is None
        assert stats["bounds"] is None
        assert stats["duration_seconds"] is None

    async def test_deleting_mission_preserves_detections(self, client, full_key, db):
        """ON DELETE SET NULL - losing a mission row must not destroy evidence.

        Asserted with raw SQL rather than through the API. The test shares one session
        with the app and `expire_on_commit=False`, so an ORM read after the delete
        would hand back the cached mission_id and the test would pass for the wrong
        reason. This checks the database itself, which is what the constraint lives in.
        """
        from sqlalchemy import text

        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(mission_name="doomed"))
        mission_id = (await client.get("/api/missions", headers=auth(full_key))
                      ).json()["items"][0]["id"]

        # No API route deletes missions; exercise the constraint directly.
        await db.execute(text("DELETE FROM missions WHERE id = :i"), {"i": mission_id})
        await db.commit()

        rows = (await db.execute(
            text("SELECT id, mission_id FROM detections")
        )).all()

        # The detection survived, orphaned rather than cascaded away.
        assert len(rows) == 1
        assert rows[0].mission_id is None

