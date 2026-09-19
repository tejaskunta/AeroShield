"""AeroShield - authentication introspection and API key administration.

Key creation lives here rather than only in the CLI so an operator can rotate a
drone's credential from the dashboard in Week 6 without shell access to the server.
The CLI (scripts/create_api_key.py) still exists because it solves the bootstrap
problem: creating the first admin key needs no admin key.
"""

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import Principal, get_principal, require_scope
from app.core.security import (
    SCOPE_ADMIN,
    SCOPE_PRESETS,
    display_prefix,
    generate_api_key,
    hash_api_key,
    normalise_scopes,
)
from app.db.models.api_key import ApiKey
from app.db.session import get_db
from app.schemas.api_key import ApiKeyCreate, ApiKeyCreated, ApiKeyRead, PrincipalRead
from app.schemas.common import Message

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Auth"])


@router.get("/auth/me", response_model=PrincipalRead, summary="Introspect the current key")
async def read_me(principal: Principal = Depends(get_principal)) -> PrincipalRead:
    """Echo back who this key belongs to and what it may do.

    Cheap way for a client to verify its credential and discover its scopes, rather
    than inferring them from whichever endpoint returned the first 403.
    """
    return PrincipalRead(
        id=principal.id,
        name=principal.name,
        kind=principal.kind,
        scopes=principal.scopes,
    )


@router.post(
    "/admin/api-keys",
    response_model=ApiKeyCreated,
    status_code=status.HTTP_201_CREATED,
    summary="Issue a new API key",
)
async def create_api_key(
    body: ApiKeyCreate,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_ADMIN)),
) -> ApiKeyCreated:
    """Mint a key. The plaintext is in this response and nowhere else, ever."""
    if body.preset and body.scopes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide either 'scopes' or 'preset', not both.",
        )

    if body.preset:
        if body.preset not in SCOPE_PRESETS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown preset '{0}'. Available: {1}".format(
                    body.preset, ", ".join(sorted(SCOPE_PRESETS))
                ),
            )
        requested = SCOPE_PRESETS[body.preset]
    elif body.scopes:
        requested = body.scopes
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="One of 'scopes' or 'preset' is required.",
        )

    try:
        scopes = normalise_scopes(requested)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    plaintext = generate_api_key()
    api_key = ApiKey(
        name=body.name,
        key_prefix=display_prefix(plaintext),
        key_hash=hash_api_key(plaintext),
        scopes=scopes,
        is_active=True,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)

    # Never log the plaintext - logs get shipped, tailed and pasted into tickets.
    logger.info("issued API key id=%s name=%s scopes=%s",
                api_key.id, api_key.name, ",".join(scopes))

    return ApiKeyCreated(
        id=api_key.id,
        name=api_key.name,
        key_prefix=api_key.key_prefix,
        scopes=api_key.scopes,
        is_active=api_key.is_active,
        created_at=api_key.created_at,
        last_used_at=api_key.last_used_at,
        api_key=plaintext,
    )


@router.get("/admin/api-keys", response_model=List[ApiKeyRead], summary="List API keys")
async def list_api_keys(
    include_revoked: bool = False,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(require_scope(SCOPE_ADMIN)),
) -> List[ApiKey]:
    """All keys, secrets excluded. Revoked keys are hidden unless asked for."""
    query = select(ApiKey).order_by(ApiKey.created_at.desc())
    if not include_revoked:
        query = query.where(ApiKey.is_active.is_(True))
    return list((await db.execute(query)).scalars().all())


@router.delete("/admin/api-keys/{key_id}", response_model=Message, summary="Revoke an API key")
async def revoke_api_key(
    key_id: int,
    db: AsyncSession = Depends(get_db),
    principal: Principal = Depends(require_scope(SCOPE_ADMIN)),
) -> Message:
    """Deactivate a key.

    A flag flip, not a DELETE: the record of which key ingested which detection has
    to outlive the key. Rows are kept, access is not.
    """
    api_key = await db.get(ApiKey, key_id)
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No API key with id {0}".format(key_id),
        )

    if api_key.id == principal.id:
        # Revoking the credential you are authenticating with would leave nobody able
        # to issue a replacement without shell access to the database.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Refusing to revoke the key used to make this request. Use another "
                   "admin key, or scripts/create_api_key.py.",
        )

    if not api_key.is_active:
        return Message(detail="API key '{0}' was already revoked.".format(api_key.name))

    api_key.is_active = False
    await db.commit()
    logger.info("revoked API key id=%s name=%s", api_key.id, api_key.name)
    return Message(detail="API key '{0}' revoked.".format(api_key.name))
