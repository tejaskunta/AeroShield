"""AeroShield - pytest fixtures.

Runs against the SEPARATE aeroshield_test database, never the development one. The
suite creates and drops tables, so pointing it at `aeroshield` would wipe real data.

Everything here is FUNCTION-SCOPED on purpose. Session-scoped async fixtures need a
session-scoped event loop, and the way you request one changed across pytest-asyncio
0.21/0.23/0.24 (the `event_loop` fixture override is deprecated, `loop_scope` is new).
Recreating the schema per test costs a few tens of milliseconds against three small
tables and sidesteps that entire compatibility problem - a slower suite that runs is
worth more than a faster one that breaks on a dependency bump.

Tables are created from Base.metadata rather than by running Alembic, which keeps the
suite independent of migration history. The migration is verified separately by
`alembic upgrade head` against a real database - see docs/API.md.

Requires the database container:
    docker compose up -d db
"""

from typing import AsyncGenerator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings
from app.core.security import (
    SCOPE_ADMIN,
    SCOPE_DETECTIONS_READ,
    SCOPE_DRONE_INGEST,
    SCOPE_MISSIONS_WRITE,
    display_prefix,
    generate_api_key,
    hash_api_key,
)
from app.db.base import Base
from app.db.models import ApiKey  # noqa: F401  (registers every model on the metadata)
from app.db.session import get_db
from app.main import app


@pytest_asyncio.fixture
async def engine():
    """Engine on the test database, with a freshly created schema.

    NullPool so no connection outlives the test's event loop - a pooled connection
    bound to a closed loop is the classic source of "attached to a different loop"
    errors in async test suites.
    """
    test_engine = create_async_engine(settings.test_database_url, poolclass=NullPool)

    async with test_engine.begin() as conn:
        # Defensive: docker-compose's init script enables postgis, but a database
        # created by hand (or a volume predating that script) will not have it, and
        # the failure otherwise reads as "type geography does not exist".
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    yield test_engine
    await test_engine.dispose()


@pytest_asyncio.fixture
async def db(engine) -> AsyncGenerator[AsyncSession, None]:
    """A session per test.

    No outer transaction wrapping the test: the code under test commits (the ingest
    path must commit before it can read back a conflicting row), so a rollback-based
    isolation strategy would not isolate anything. The fresh schema per test is what
    provides isolation instead.
    """
    session_factory = async_sessionmaker(
        bind=engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
    )
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def client(db, tmp_path) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client driving the real app in-process.

    ASGITransport does not run the lifespan hooks, which is exactly what we want:
    startup would connect to the DEVELOPMENT database and try to register a bootstrap
    admin key.

    Storage is redirected into tmp_path so image tests do not litter backend/storage.
    """
    original_storage = settings.storage_dir
    settings.storage_dir = str(tmp_path / "storage")

    async def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client

    app.dependency_overrides.clear()
    settings.storage_dir = original_storage


async def _make_key(db: AsyncSession, name: str, scopes) -> str:
    plaintext = generate_api_key()
    db.add(ApiKey(
        name=name,
        key_prefix=display_prefix(plaintext),
        key_hash=hash_api_key(plaintext),
        scopes=list(scopes),
        is_active=True,
    ))
    await db.commit()
    return plaintext


@pytest_asyncio.fixture
async def admin_key(db) -> str:
    return await _make_key(db, "test-admin", [SCOPE_ADMIN])


@pytest_asyncio.fixture
async def drone_key(db) -> str:
    """What a real drone holds: ingest + mission registration, nothing else."""
    return await _make_key(db, "test-drone", [SCOPE_DRONE_INGEST, SCOPE_MISSIONS_WRITE])


@pytest_asyncio.fixture
async def read_key(db) -> str:
    """Read-only, as the Week 6 dashboard would hold."""
    return await _make_key(db, "test-dashboard", [SCOPE_DETECTIONS_READ])


@pytest_asyncio.fixture
async def full_key(db) -> str:
    """Every scope - for tests about behaviour rather than authorisation."""
    return await _make_key(db, "test-full", [
        SCOPE_ADMIN, SCOPE_DRONE_INGEST, SCOPE_DETECTIONS_READ, SCOPE_MISSIONS_WRITE,
    ])


def auth(key: str) -> dict:
    """Header helper."""
    return {"X-API-Key": key}
