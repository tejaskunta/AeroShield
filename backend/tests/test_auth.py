"""AeroShield - authentication and authorisation tests.

Week 5 lists an "Authentication Module" as a deliverable; these are the tests that
make that claim checkable.
"""

from tests.conftest import auth


class TestPublicEndpoints:
    async def test_root_needs_no_key(self, client):
        response = await client.get("/")
        assert response.status_code == 200
        # Shape documented in the README - a script may already depend on it.
        assert response.json() == {"message": "AeroShield API is running"}

    async def test_health_needs_no_key(self, client):
        """A health check behind auth is useless to a load balancer.

        Note this does NOT assert database=="ok": /health deliberately probes the real
        configured engine rather than a request-scoped session, so under test it
        reports on the DEVELOPMENT database. Asserting "ok" here would be testing
        whether the developer happens to have docker running, not the endpoint.
        """
        response = await client.get("/health")
        assert response.status_code == 200

        body = response.json()
        assert body["status"] in ("healthy", "degraded")
        assert body["database"] in ("ok", "unreachable")
        assert body["version"]


class TestAuthentication:
    async def test_missing_key_is_401(self, client):
        response = await client.get("/api/detections")
        assert response.status_code == 401
        assert "X-API-Key" in response.json()["detail"]

    async def test_unknown_key_is_401(self, client):
        response = await client.get("/api/detections", headers=auth("aero_not_a_real_key"))
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid API key."

    async def test_revoked_key_is_401(self, client, db, admin_key, read_key):
        """Revocation takes effect immediately, with no cached authorisation."""
        listed = await client.get("/api/admin/api-keys", headers=auth(admin_key))
        target = next(k for k in listed.json() if k["name"] == "test-dashboard")

        revoked = await client.delete(
            "/api/admin/api-keys/{0}".format(target["id"]), headers=auth(admin_key)
        )
        assert revoked.status_code == 200

        response = await client.get("/api/detections", headers=auth(read_key))
        assert response.status_code == 401
        assert "revoked" in response.json()["detail"].lower()

    async def test_auth_me_reports_scopes(self, client, drone_key):
        response = await client.get("/api/auth/me", headers=auth(drone_key))
        assert response.status_code == 200
        body = response.json()
        assert body["name"] == "test-drone"
        assert body["kind"] == "api_key"
        assert set(body["scopes"]) == {"drone:ingest", "missions:write"}


class TestAuthorisation:
    async def test_read_key_cannot_ingest(self, client, read_key):
        """A dashboard credential must not be able to write detections."""
        from tests.factories import detection_payload

        response = await client.post(
            "/api/detections", json=detection_payload(), headers=auth(read_key)
        )
        assert response.status_code == 403
        detail = response.json()["detail"]
        assert "drone:ingest" in detail
        # The message names what the key does have, so the fix is obvious.
        assert "detections:read" in detail

    async def test_drone_key_cannot_delete(self, client, drone_key, full_key):
        """Deleting evidence requires admin; the drone's own key must not suffice."""
        from tests.factories import detection_payload

        created = await client.post(
            "/api/detections", json=detection_payload(), headers=auth(full_key)
        )
        detection_id = created.json()["id"]

        response = await client.delete(
            "/api/detections/{0}".format(detection_id), headers=auth(drone_key)
        )
        assert response.status_code == 403

    async def test_drone_key_cannot_manage_keys(self, client, drone_key):
        response = await client.get("/api/admin/api-keys", headers=auth(drone_key))
        assert response.status_code == 403

    async def test_admin_scope_implies_read(self, client, admin_key):
        """admin is a superset - it should not need detections:read spelled out."""
        response = await client.get("/api/detections", headers=auth(admin_key))
        assert response.status_code == 200


class TestKeyAdministration:
    async def test_create_key_returns_plaintext_once(self, client, admin_key):
        response = await client.post(
            "/api/admin/api-keys",
            json={"name": "drone-02", "preset": "drone"},
            headers=auth(admin_key),
        )
        assert response.status_code == 201
        body = response.json()
        assert body["api_key"].startswith("aero_")
        assert set(body["scopes"]) == {"drone:ingest", "missions:write"}

        # The new key works immediately.
        me = await client.get("/api/auth/me", headers=auth(body["api_key"]))
        assert me.status_code == 200
        assert me.json()["name"] == "drone-02"

        # ...and the listing never exposes a usable secret.
        listed = await client.get("/api/admin/api-keys", headers=auth(admin_key))
        for key in listed.json():
            assert "api_key" not in key
            assert "key_hash" not in key

    async def test_unknown_scope_rejected(self, client, admin_key):
        """A typo'd scope must fail loudly, not create a key that authorises nothing."""
        response = await client.post(
            "/api/admin/api-keys",
            json={"name": "typo", "scopes": ["detection:read"]},   # missing the 's'
            headers=auth(admin_key),
        )
        assert response.status_code == 400
        assert "Unknown scope" in response.json()["detail"]

    async def test_cannot_revoke_own_key(self, client, admin_key):
        """Otherwise nobody can mint a replacement without database access."""
        me = await client.get("/api/auth/me", headers=auth(admin_key))
        own_id = me.json()["id"]

        response = await client.delete(
            "/api/admin/api-keys/{0}".format(own_id), headers=auth(admin_key)
        )
        assert response.status_code == 400
        assert "Refusing to revoke" in response.json()["detail"]

    async def test_preset_and_scopes_are_exclusive(self, client, admin_key):
        response = await client.post(
            "/api/admin/api-keys",
            json={"name": "both", "preset": "drone", "scopes": ["admin"]},
            headers=auth(admin_key),
        )
        assert response.status_code == 400
