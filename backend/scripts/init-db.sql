-- AeroShield - one-time database initialisation.
--
-- Runs automatically the FIRST time the postgis container starts with an empty
-- data directory (docker-entrypoint-initdb.d). It does not run again on restart.
-- If you need to re-run it: docker compose down -v && docker compose up -d db
--
-- Purpose: create the separate database the test suite uses. Tests create and
-- drop tables, so pointing them at the development database would wipe your data
-- every time you ran pytest.

CREATE DATABASE aeroshield_test OWNER aeroshield;

-- PostGIS must be enabled per-database. The application database gets its
-- extension from Alembic migration 0001 (so a fresh clone with an existing
-- volume still works); the test database gets it here because the test harness
-- creates tables directly from metadata without running migrations.
\connect aeroshield_test
CREATE EXTENSION IF NOT EXISTS postgis;

\connect aeroshield
CREATE EXTENSION IF NOT EXISTS postgis;
