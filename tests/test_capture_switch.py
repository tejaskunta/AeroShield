"""The record switch the dashboard drives: CaptureSwitch and the /capture endpoint."""

import json
import urllib.error
import urllib.request

import pytest

from stream import CaptureSwitch, FrameBroadcaster, start_server


def test_switch_sessions_advance_only_on_off_to_on():
    s = CaptureSwitch(on=False)
    assert s.state() == {"capturing": False, "session": 0}
    s.set(True)
    assert s.state() == {"capturing": True, "session": 1}
    s.set(True)  # already on: same session
    assert s.session() == 1
    s.set(False)
    s.set(True)
    assert s.state() == {"capturing": True, "session": 2}


@pytest.fixture
def server():
    capture = CaptureSwitch(on=False)
    broadcaster = FrameBroadcaster()
    srv = start_server(0, broadcaster, capture)
    base = "http://127.0.0.1:{0}".format(srv.server_address[1])
    yield base, capture
    srv.shutdown()
    broadcaster.close()


def _post(url, body):
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=3)


def test_get_and_post_capture(server):
    base, capture = server
    with urllib.request.urlopen(base + "/capture", timeout=3) as r:
        assert json.loads(r.read()) == {"capturing": False, "session": 0}

    with _post(base + "/capture", b'{"capturing": true}') as r:
        assert json.loads(r.read()) == {"capturing": True, "session": 1}
    assert capture.is_on()


def test_post_rejects_non_boolean(server):
    base, capture = server
    with pytest.raises(urllib.error.HTTPError) as exc:
        _post(base + "/capture", b'{"capturing": "yes"}')
    assert exc.value.code == 400
    assert not capture.is_on()
