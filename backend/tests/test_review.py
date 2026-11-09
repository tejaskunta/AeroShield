"""AeroShield - review persistence and Grad-CAM overlay tests (PRD 5.1).

Two features that turn a raw detection into evidence:

  * `PATCH /review` records a human decision, with reviewer and timestamp stamped
    server-side. The audit trail is the whole point — a client that could name its
    own reviewer would make it decorative, so these tests assert the server overrode
    it with the authenticated principal.
  * `PUT/GET /gradcam` store the explainability overlay. The interesting behaviour is
    the 409: a heatmap without its frame is meaningless, and the edge uplink uploads
    the frame first for exactly this reason. The test asserts the ordering guard, not
    just the happy path.
"""

from tests.conftest import auth
from tests.factories import MINIMAL_JPEG, detection_payload


async def _make_detection(client, key, **overrides):
    """Ingest one detection and return its integer id."""
    response = await client.post(
        "/api/detections", json=detection_payload(**overrides), headers=auth(key)
    )
    assert response.status_code == 201
    return response.json()["id"]


class TestReview:
    async def test_confirm_stamps_server_side(self, client, full_key, read_key):
        """A confirmed review carries the reviewer name and a timestamp from the server."""
        detection_id = await _make_detection(client, full_key)

        response = await client.patch(
            "/api/detections/{0}/review".format(detection_id),
            json={"state": "confirmed", "reason": "visible AP blast marker"},
            headers=auth(read_key),
        )
        assert response.status_code == 200
        body = response.json()
        assert body["review_state"] == "confirmed"
        assert body["review_reason"] == "visible AP blast marker"
        # The key that made the call was "test-dashboard" — the server read that from
        # the credential, not from anything the request body could have supplied.
        assert body["reviewed_by"] == "test-dashboard"
        assert body["reviewed_at"] is not None

    async def test_review_persists_across_reads(self, client, full_key):
        """The decision is a row update, not a response-time flourish."""
        detection_id = await _make_detection(client, full_key)
        await client.patch(
            "/api/detections/{0}/review".format(detection_id),
            json={"state": "flagged"},
            headers=auth(full_key),
        )

        stored = await client.get(
            "/api/detections/{0}".format(detection_id), headers=auth(full_key)
        )
        assert stored.json()["review_state"] == "flagged"

    async def test_unreviewed_is_the_default(self, client, full_key):
        """A fresh detection reads back as 'unreviewed', never null/blank."""
        detection_id = await _make_detection(client, full_key)
        stored = await client.get(
            "/api/detections/{0}".format(detection_id), headers=auth(full_key)
        )
        assert stored.json()["review_state"] == "unreviewed"
        assert stored.json()["reviewed_by"] is None

    async def test_undo_back_to_unreviewed(self, client, full_key):
        """An operator who mis-taps can clear the decision; the state is settable."""
        detection_id = await _make_detection(client, full_key)
        await client.patch(
            "/api/detections/{0}/review".format(detection_id),
            json={"state": "dismissed", "reason": "metal fence post"},
            headers=auth(full_key),
        )
        cleared = await client.patch(
            "/api/detections/{0}/review".format(detection_id),
            json={"state": "unreviewed"},
            headers=auth(full_key),
        )
        assert cleared.status_code == 200
        assert cleared.json()["review_state"] == "unreviewed"

    async def test_unknown_state_rejected(self, client, full_key):
        """'state' is an enum, not free text — a typo must not store a bogus verdict."""
        detection_id = await _make_detection(client, full_key)
        response = await client.patch(
            "/api/detections/{0}/review".format(detection_id),
            json={"state": "probably-fine"},
            headers=auth(full_key),
        )
        assert response.status_code == 422

    async def test_review_missing_detection_is_404(self, client, full_key):
        response = await client.patch(
            "/api/detections/999999/review",
            json={"state": "confirmed"},
            headers=auth(full_key),
        )
        assert response.status_code == 404

    async def test_drone_key_cannot_review(self, client, full_key, drone_key):
        """Adjudication is a dashboard action — the drone cannot mark its own output
        confirmed. This is the scope choice that keeps the review workflow honest."""
        detection_id = await _make_detection(client, full_key)
        response = await client.patch(
            "/api/detections/{0}/review".format(detection_id),
            json={"state": "confirmed"},
            headers=auth(drone_key),
        )
        assert response.status_code == 403


class TestGradCam:
    async def test_heatmap_without_frame_is_409(self, client, full_key):
        """The ordering guard: a heatmap of nothing is unexplainable later, so the
        frame must exist first. The uplink uploads image-then-heatmap for this reason."""
        detection_id = await _make_detection(client, full_key)  # no image uploaded
        response = await client.put(
            "/api/detections/{0}/gradcam".format(detection_id),
            files={"heatmap": ("gradcam.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        assert response.status_code == 409
        assert "frame" in response.json()["detail"].lower()

    async def test_upload_after_frame_then_fetch(self, client, full_key):
        """The happy path: frame, then heatmap, then read the bytes back."""
        detection_id = await _make_detection(client, full_key)
        await client.put(
            "/api/detections/{0}/image".format(detection_id),
            files={"image": ("frame.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )

        uploaded = await client.put(
            "/api/detections/{0}/gradcam".format(detection_id),
            files={"heatmap": ("gradcam.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        assert uploaded.status_code == 200
        assert uploaded.json()["gradcam_path"] is not None

        fetched = await client.get(
            "/api/detections/{0}/gradcam".format(detection_id), headers=auth(full_key)
        )
        assert fetched.status_code == 200
        assert fetched.content == MINIMAL_JPEG

    async def test_reupload_replaces_overlay(self, client, full_key):
        """Idempotent like the frame upload: re-running the analysis overwrites."""
        detection_id = await _make_detection(client, full_key)
        await client.put(
            "/api/detections/{0}/image".format(detection_id),
            files={"image": ("frame.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        first = await client.put(
            "/api/detections/{0}/gradcam".format(detection_id),
            files={"heatmap": ("gradcam.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        second = await client.put(
            "/api/detections/{0}/gradcam".format(detection_id),
            files={"heatmap": ("gradcam.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        # Same detection, same slot — the path is stable across re-analysis.
        assert first.json()["gradcam_path"] == second.json()["gradcam_path"]

    async def test_fetch_missing_overlay_is_404(self, client, full_key):
        """Frame present, heatmap never uploaded — a distinct 404 from the frame's."""
        detection_id = await _make_detection(client, full_key)
        await client.put(
            "/api/detections/{0}/image".format(detection_id),
            files={"image": ("frame.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        response = await client.get(
            "/api/detections/{0}/gradcam".format(detection_id), headers=auth(full_key)
        )
        assert response.status_code == 404

    async def test_read_dashboard_can_fetch_not_upload(self, client, full_key, read_key):
        """GET /gradcam is a read (dashboard); PUT is ingest (drone). The dashboard key
        can pull an overlay but cannot push one — the split mirrors the frame upload."""
        detection_id = await _make_detection(client, full_key)
        await client.put(
            "/api/detections/{0}/image".format(detection_id),
            files={"image": ("frame.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )
        await client.put(
            "/api/detections/{0}/gradcam".format(detection_id),
            files={"heatmap": ("gradcam.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(full_key),
        )

        allowed = await client.get(
            "/api/detections/{0}/gradcam".format(detection_id), headers=auth(read_key)
        )
        assert allowed.status_code == 200

        refused = await client.put(
            "/api/detections/{0}/gradcam".format(detection_id),
            files={"heatmap": ("gradcam.jpg", MINIMAL_JPEG, "image/jpeg")},
            headers=auth(read_key),
        )
        assert refused.status_code == 403
