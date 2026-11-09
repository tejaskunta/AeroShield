"""AeroShield - shared FastAPI dependencies.

Authentication resolves an API key into a Principal; authorisation is a scope check
against that Principal.

WEEK 6 SEAM: routes depend on `require_scope(...)`, which depends on a Principal -
not on an API key specifically. When the React dashboard needs a human login, add a
JWT resolver that returns the same Principal shape and chain it here. No route
signature changes, no re-testing of the authorisation logic.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, List, Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import APIKeyHeader
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import has_scope, hash_api_key
from app.db.models.api_key import ApiKey
from app.db.session import get_db

API_KEY_HEADER_NAME = "X-API-Key"

# auto_error=False so this module controls the 401 body and the WWW-Authenticate
# header. FastAPI's default message is generic; a drone operator reading a log at
# 2am benefits from being told which header was missing.
api_key_header = APIKeyHeader(
    name=API_KEY_HEADER_NAME,
    auto_error=False,
    description=(
        "Scoped API key. Mint one with "
        "`python backend/scripts/create_api_key.py --name <label> --preset drone`."
    ),
)

# last_used_at is diagnostic, not audit. Refreshing it on every request would add a
# write to every read; once a minute is enough to answer "is this key still in use"
# without amplifying a read-heavy dashboard into a write-heavy one.
LAST_USED_REFRESH_INTERVAL = timedelta(seconds=60)


@dataclass
class Principal:
    """Whoever is making this request, and what they are allowed to do."""

    id: int
    name: str
    scopes: List[str] = field(default_factory=list)
    kind: str = "api_key"          # "jwt" when Week 6 adds operator login

    def can(self, scope: str) -> bool:
        return has_scope(self.scopes, scope)


def _unauthorised(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": API_KEY_HEADER_NAME},
    )


async def get_principal(
    raw_key: Optional[str] = Depends(api_key_header),
    db: AsyncSession = Depends(get_db),
) -> Principal:
    """Authenticate the caller. Raises 401 if the key is absent, unknown or revoked.

    Lookup is by SHA-256 hash on a unique index - a single indexed equality probe,
    which matters because this runs on every request including the drone's ingest
    stream.
    """
    if not raw_key:
        raise _unauthorised(
            "Missing {0} header. Every endpoint except / and /health requires a key."
            .format(API_KEY_HEADER_NAME)
        )

    key_hash = hash_api_key(raw_key)
    result = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
    api_key = result.scalar_one_or_none()

    if api_key is None:
        # Deliberately identical wording for "no such key" and "revoked key" would
        # be better practice against enumeration, but these keys are 256-bit and
        # unguessable, so a clearer message is worth more than the non-existent
        # enumeration risk.
        raise _unauthorised("Invalid API key.")

    if not api_key.is_active:
        raise _unauthorised(
            "API key '{0}' has been revoked. Mint a replacement with "
            "scripts/create_api_key.py".format(api_key.name)
        )

    now = datetime.now(timezone.utc)
    if api_key.last_used_at is None or (now - api_key.last_used_at) > LAST_USED_REFRESH_INTERVAL:
        await db.execute(
            update(ApiKey).where(ApiKey.id == api_key.id).values(last_used_at=now)
        )
        # Committed on its own: this is bookkeeping, and it should survive even if
        # the request it belongs to later fails.
        await db.commit()

    return Principal(
        id=api_key.id,
        name=api_key.name,
        scopes=list(api_key.scopes or []),
        kind="api_key",
    )


def require_scope(scope: str) -> Callable:
    """Build a dependency asserting the caller holds `scope`.

        @router.post("/detections", dependencies=[Depends(require_scope("drone:ingest"))])

    Use it as a parameter instead when the route body needs the Principal:

        principal: Principal = Depends(require_scope("admin"))
    """

    async def _check(principal: Principal = Depends(get_principal)) -> Principal:
        if not principal.can(scope):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "API key '{0}' lacks the '{1}' scope. It has: {2}."
                    .format(principal.name, scope,
                            ", ".join(principal.scopes) or "no scopes")
                ),
            )
        return principal

    return _check
