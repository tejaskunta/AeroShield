"""AeroShield - async database engine and session management.

One engine per process, one session per request. The session is opened by the
get_db dependency and always closed, including on an exception, because a leaked
connection from a failed request permanently shrinks the pool.

Transactions: get_db does NOT wrap the request in an implicit commit. Routes commit
explicitly. That is deliberate - the detection ingest path needs to commit, then
read back the row it just wrote to detect an idempotent replay, and an
auto-committing dependency makes that ordering impossible to express.
"""

from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings

# pool_pre_ping costs one cheap round-trip per checkout and eliminates the
# "server closed the connection unexpectedly" class of error that otherwise shows
# up after the database restarts or an idle laptop wakes from sleep.
engine: AsyncEngine = create_async_engine(
    settings.database_url,
    echo=settings.db_echo,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
)

# expire_on_commit=False keeps ORM objects readable after commit. Without it, the
# attribute access in a response serialiser triggers a lazy refresh, which under
# asyncio raises MissingGreenlet instead of simply reloading.
SessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding a request-scoped session."""
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            # A half-applied transaction must not be reused by the next request
            # that borrows this connection.
            await session.rollback()
            raise


async def check_database() -> bool:
    """Shallow connectivity probe for GET /health.

    Deliberately a real query rather than an engine-state inspection: the pool can
    hold handles to a database that has since gone away.
    """
    from sqlalchemy import text

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


async def dispose_engine() -> None:
    """Close every pooled connection. Called from the app's shutdown hook."""
    await engine.dispose()
