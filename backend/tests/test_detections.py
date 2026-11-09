"""AeroShield - detection ingest, query and geospatial tests.

The idempotency and PostGIS tests are the load-bearing ones: the first guarantees a
flaky radio link cannot inflate a mission's detection count, the second guarantees
"within 500 metres" means metres.
"""

import uuid

from tests.conftest import auth
from tests.factories import MINIMAL_JPEG, MINIMAL_PNG, NOT_AN_IMAGE, detection_payload


class TestIngest:
    async def test_ingest_creates_detection(self, client, drone_key):
        payload = detection_payload(mission_name="flight-1")
        response = await client.post("/api/detections", json=payload, headers=auth(drone_key))

        assert response.status_code == 201
        body = response.json()
        assert body["duplicate"] is False
        assert body["mission_id"] is not None
        assert body["image_upload_url"] == "/api/detections/{0}/image".format(body["id"])

    async def test_mission_created_by_name(self, client, drone_key, full_key):
        """The drone sends a name; the backend creates the mission on first sight."""
        await client.post(
            "/api/detections", json=detection_payload(mission_name="auto-made"),
            headers=auth(drone_key),
        )
        missions = await client.get("/api/missions", headers=auth(full_key))
        names = [m["name"] for m in missions.json()["items"]]
        assert "auto-made" in names

    async def test_unknown_mission_id_is_404(self, client, drone_key):
        response = await client.post(
            "/api/detections",
            json=detection_payload(mission_name=None, mission_id=9999),
            headers=auth(drone_key),
        )
        assert response.status_code == 404
        # The error points at the workaround rather than just refusing.
        assert "mission_name" in response.json()["detail"]

    async def test_detection_without_mission_is_accepted(self, client, drone_key):
        """A detection with no mission context is still evidence worth keeping."""
        payload = detection_payload(mission_name=None)
        response = await client.post("/api/detections", json=payload, headers=auth(drone_key))
        assert response.status_code == 201
        assert response.json()["mission_id"] is None

    async def test_ungeotagged_detection_is_accepted(self, client, drone_key, full_key):
        """No GPS lock must not mean a lost detection."""
        payload = detection_payload(latitude=None, longitude=None, gps_fix_type=1)
        response = await client.post("/api/detections", json=payload, headers=auth(drone_key))
        assert response.status_code == 201

        stored = await client.get(
            "/api/detections/{0}".format(response.json()["id"]), headers=auth(full_key)
        )
        assert stored.json()["latitude"] is None
        assert stored.json()["longitude"] is None


class TestIdempotency:
    async def test_replay_does_not_duplicate(self, client, drone_key, full_key):
        """The core spool-replay guarantee.

        The drone re-sends after a dropped link. Two POSTs of the same
        client_detection_id must leave exactly one row.
        """
        client_id = str(uuid.uuid4())
        payload = detection_payload(client_detection_id=client_id)

        first = await client.post("/api/detections", json=payload, headers=auth(drone_key))
        second = await client.post("/api/detections", json=payload, headers=auth(drone_key))

        assert first.status_code == 201
        assert first.json()["duplicate"] is False

        # 200, not 409: a 4xx would make the drone treat stored work as failed and
        # retry the same record forever.
        assert second.status_code == 200
        assert second.json()["duplicate"] is True
        assert second.json()["id"] == first.json()["id"]

        listing = await client.get("/api/detections", headers=auth(full_key))
        assert listing.json()["total"] == 1

    async def test_replay_does_not_overwrite_attached_image(self, client, full_key):
        """A replay must not clobber an image uploaded after the original POST."""
        client_id = str(uuid.uuid4())
        payload = detection_payload(client_detection_id=client_id)

        created = await client.post("/api/detections", json=payload, headers=auth(full_key))
        detection_id = created.json()["id"]

        await client.put(
            "/api/detections/{0}/image".format(detection_id),
            files={"image": ("frame.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        await client.post("/api/detections", json=payload, headers=auth(full_key))

        stored = await client.get(
            "/api/detections/{0}".format(detection_id), headers=auth(full_key)
        )
        assert stored.json()["image_path"] is not None


class TestValidation:
    async def test_inverted_bbox_rejected(self, client, drone_key):
        response = await client.post(
            "/api/detections",
            json=detection_payload(bbox_x1=500, bbox_x2=100),
            headers=auth(drone_key),
        )
        assert response.status_code == 422

    async def test_confidence_out_of_range_rejected(self, client, drone_key):
        response = await client.post(
            "/api/detections", json=detection_payload(confidence=1.4),
            headers=auth(drone_key),
        )
        assert response.status_code == 422

    async def test_one_sided_coordinates_rejected(self, client, drone_key):
        """A latitude with no longitude would plot on the prime meridian."""
        response = await client.post(
            "/api/detections",
            json=detection_payload(latitude=12.97, longitude=None),
            headers=auth(drone_key),
        )
        assert response.status_code == 422
        assert "together" in str(response.json()["detail"])

    async def test_naive_timestamp_rejected(self, client, drone_key):
        """Drone, server and browser are routinely in different zones."""
        response = await client.post(
            "/api/detections",
            json=detection_payload(captured_at="2026-08-23T09:14:22"),   # no offset
            headers=auth(drone_key),
        )
        assert response.status_code == 422
        assert "timezone" in str(response.json()["detail"])


class TestQuerying:
    async def test_pagination(self, client, full_key):
        for i in range(5):
            await client.post(
                "/api/detections", json=detection_payload(minutes_ago=i),
                headers=auth(full_key),
            )

        page = await client.get("/api/detections?limit=2&offset=0", headers=auth(full_key))
        body = page.json()
        assert body["total"] == 5
        assert len(body["items"]) == 2
        assert body["limit"] == 2

    async def test_ordered_by_capture_time_desc(self, client, full_key):
        """Ordering must follow capture time, not insertion order.

        Inserted oldest-first here on purpose: a spooled detection is stored long
        after it was seen, so insert order does not reflect the flight.
        """
        for minutes in (30, 20, 10):
            await client.post(
                "/api/detections", json=detection_payload(minutes_ago=minutes),
                headers=auth(full_key),
            )

        items = (await client.get("/api/detections", headers=auth(full_key))).json()["items"]
        timestamps = [item["captured_at"] for item in items]
        assert timestamps == sorted(timestamps, reverse=True)

    async def test_filter_by_class_and_confidence(self, client, full_key):
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(class_name="landmine_metal", confidence=0.9))
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(class_name="debris_negative", confidence=0.3))

        by_class = await client.get(
            "/api/detections?class_name=landmine_metal", headers=auth(full_key)
        )
        assert by_class.json()["total"] == 1

        by_conf = await client.get(
            "/api/detections?min_confidence=0.5", headers=auth(full_key)
        )
        assert by_conf.json()["total"] == 1

    async def test_geotagged_only_filter(self, client, full_key):
        await client.post("/api/detections", json=detection_payload(),
                          headers=auth(full_key))
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(latitude=None, longitude=None))

        everything = await client.get("/api/detections", headers=auth(full_key))
        assert everything.json()["total"] == 2

        geotagged = await client.get(
            "/api/detections?geotagged_only=true", headers=auth(full_key)
        )
        assert geotagged.json()["total"] == 1


class TestGeospatial:
    """PostGIS behaviour - the part that must not silently be in the wrong units."""

    async def test_near_radius_is_metres(self, client, full_key):
        """ST_DWithin on a geography column measures METRES.

        The two detections are ~1.1 km apart (0.01 degrees of latitude). A 500 m
        radius must match one, a 2 km radius both. If the column were
        geometry(4326) the radius would be degrees and both queries would match
        everything - which is exactly the bug this test exists to catch.
        """
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(latitude=12.9716, longitude=77.5946))
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(latitude=12.9816, longitude=77.5946))

        close = await client.get(
            "/api/detections?near=12.9716,77.5946,500", headers=auth(full_key)
        )
        assert close.json()["total"] == 1

        wide = await client.get(
            "/api/detections?near=12.9716,77.5946,2000", headers=auth(full_key)
        )
        assert wide.json()["total"] == 2

    async def test_near_rejects_malformed_input(self, client, full_key):
        bad = await client.get("/api/detections?near=12.97,77.59", headers=auth(full_key))
        assert bad.status_code == 422

        swapped = await client.get(
            "/api/detections?near=77.5946,12.9716,500", headers=auth(full_key)
        )
        # 77.59 is a valid latitude, so this specific swap cannot be detected; the
        # guard catches the out-of-range case.
        assert swapped.status_code == 200

        out_of_range = await client.get(
            "/api/detections?near=200,77.59,500", headers=auth(full_key)
        )
        assert out_of_range.status_code == 422
        assert "lat,lon" in out_of_range.json()["detail"]

    async def test_geojson_shape(self, client, full_key):
        """Leaflet-ready output, in RFC 7946 lon/lat order."""
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(latitude=12.9716, longitude=77.5946))

        response = await client.get("/api/detections/geojson", headers=auth(full_key))
        assert response.status_code == 200
        body = response.json()
        assert body["type"] == "FeatureCollection"
        assert len(body["features"]) == 1

        feature = body["features"][0]
        assert feature["geometry"]["type"] == "Point"
        # Longitude FIRST. Getting this backwards puts every detection in the sea.
        longitude, latitude = feature["geometry"]["coordinates"]
        assert round(longitude, 4) == 77.5946
        assert round(latitude, 4) == 12.9716
        assert feature["properties"]["horizontal_error_m"] == 3.4

    async def test_geojson_omits_ungeotagged(self, client, full_key):
        """GeoJSON cannot say "exists but has no location"; [0,0] would be a lie."""
        await client.post("/api/detections", headers=auth(full_key),
                          json=detection_payload(latitude=None, longitude=None))

        response = await client.get("/api/detections/geojson", headers=auth(full_key))
        assert response.json()["features"] == []

    async def test_geojson_route_not_shadowed(self, client, full_key):
        """/geojson must not be parsed as /{detection_id}."""
        response = await client.get("/api/detections/geojson", headers=auth(full_key))
        assert response.status_code == 200


class TestImages:
    async def test_upload_and_fetch(self, client, full_key):
        created = await client.post(
            "/api/detections", json=detection_payload(), headers=auth(full_key)
        )
        detection_id = created.json()["id"]

        uploaded = await client.put(
            "/api/detections/{0}/image".format(detection_id),
            files={"image": ("frame.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        assert uploaded.status_code == 200
        assert uploaded.json()["image_path"] is not None

        fetched = await client.get(
            "/api/detections/{0}/image".format(detection_id), headers=auth(full_key)
        )
        assert fetched.status_code == 200
        assert fetched.headers["content-type"] == "image/jpeg"
        assert fetched.content == MINIMAL_JPEG

    async def test_png_accepted(self, client, full_key):
        created = await client.post(
            "/api/detections", json=detection_payload(), headers=auth(full_key)
        )
        response = await client.put(
            "/api/detections/{0}/image".format(created.json()["id"]),
            files={"image": ("frame.png", MINIMAL_PNG, "image/png")},
            headers=auth(full_key),
        )
        assert response.status_code == 200
        assert response.json()["image_path"].endswith(".png")

    async def test_non_image_rejected_despite_content_type(self, client, full_key):
        """Magic bytes are checked; the client's Content-Type is not trusted."""
        created = await client.post(
            "/api/detections", json=detection_payload(), headers=auth(full_key)
        )
        response = await client.put(
            "/api/detections/{0}/image".format(created.json()["id"]),
            files={"image": ("lies.jpg", NOT_AN_IMAGE, "image/jpeg")},
            headers=auth(full_key),
        )
        assert response.status_code == 400
        assert "magic bytes" in response.json()["detail"]

    async def test_image_for_unknown_detection_is_404(self, client, full_key):
        response = await client.put(
            "/api/detections/4242/image",
            files={"image": ("frame.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        assert response.status_code == 404

    async def test_missing_image_is_404_with_a_reason(self, client, full_key):
        created = await client.post(
            "/api/detections", json=detection_payload(), headers=auth(full_key)
        )
        response = await client.get(
            "/api/detections/{0}/image".format(created.json()["id"]), headers=auth(full_key)
        )
        assert response.status_code == 404
        assert "no image" in response.json()["detail"].lower()

    async def test_reupload_replaces_in_place(self, client, full_key):
        created = await client.post(
            "/api/detections", json=detection_payload(), headers=auth(full_key)
        )
        detection_id = created.json()["id"]
        url = "/api/detections/{0}/image".format(detection_id)

        first = await client.put(url, files={"image": ("a.jpg", MINIMAL_JPEG, "image/jpeg")},
                                 headers=auth(full_key))
        second_bytes = MINIMAL_JPEG + b"\x01\x02\x03"
        second = await client.put(url, files={"image": ("b.jpg", second_bytes, "image/jpeg")},
                                  headers=auth(full_key))

        assert first.json()["image_path"] == second.json()["image_path"]
        fetched = await client.get(url, headers=auth(full_key))
        assert fetched.content == second_bytes


class TestDeletion:
    async def test_delete_removes_row_and_file(self, client, full_key):
        created = await client.post(
            "/api/detections", json=detection_payload(), headers=auth(full_key)
        )
        detection_id = created.json()["id"]
        await client.put(
            "/api/detections/{0}/image".format(detection_id),
            files={"image": ("frame.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )

        deleted = await client.delete(
            "/api/detections/{0}".format(detection_id), headers=auth(full_key)
        )
        assert deleted.status_code == 200

        gone = await client.get(
            "/api/detections/{0}".format(detection_id), headers=auth(full_key)
        )
        assert gone.status_code == 404

        image_gone = await client.get(
            "/api/detections/{0}/image".format(detection_id), headers=auth(full_key)
        )
        assert image_gone.status_code == 404
