"""POST /api/detections/test-inject - the dashboard's own end-to-end check.

Pinned: it stores a real row and frame through the normal ingest path, it is ALWAYS
labelled manual-test (so the console can never call it "Flown"), and it refuses to
run outside development.
"""
from app.core.config import settings

from tests.conftest import auth

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64 + b"\xff\xd9"


def _form(**over):
    base = {
        "latitude": "17.396990", "longitude": "78.490760", "mission_name": "inject-test",
        "frame_width": "640", "frame_height": "360",
        "bbox_x1": "280", "bbox_y1": "140", "bbox_x2": "360", "bbox_y2": "220",
        "confidence": "0.82",
    }
    base.update(over)
    return base


async def test_inject_stores_a_labelled_detection_with_its_frame(client, read_key):
    r = await client.post(
        "/api/detections/test-inject",
        data=_form(),
        files={"image": ("mine.jpg", JPEG, "image/jpeg")},
        headers=auth(read_key),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["source"] == "manual-test"
    assert body["model_version"] == "manual-test"
    assert abs(body["latitude"] - 17.39699) < 1e-6
    img = await client.get("/api/detections/{0}/image".format(body["id"]), headers=auth(read_key))
    assert img.status_code == 200
    assert img.content == JPEG


async def test_inject_rejects_an_empty_box(client, read_key):
    r = await client.post(
        "/api/detections/test-inject",
        data=_form(bbox_x2="280"),
        files={"image": ("mine.jpg", JPEG, "image/jpeg")},
        headers=auth(read_key),
    )
    assert r.status_code == 422


async def test_inject_is_refused_outside_development(client, read_key, monkeypatch):
    monkeypatch.setattr(settings, "env", "production")
    r = await client.post(
        "/api/detections/test-inject",
        data=_form(),
        files={"image": ("mine.jpg", JPEG, "image/jpeg")},
        headers=auth(read_key),
    )
    assert r.status_code == 403
