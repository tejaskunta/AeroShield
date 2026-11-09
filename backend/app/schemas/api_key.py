"""AeroShield - API key schemas."""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.core.security import ALL_SCOPES, SCOPE_PRESETS


class ApiKeyCreate(BaseModel):
    """POST /api/admin/api-keys.

    Either an explicit scope list or a preset. Presets exist because the common
    cases (a drone, a dashboard) should not require remembering which scopes pair
    together, and a key issued with the wrong scopes fails later at a confusing 403.
    """

    model_config = ConfigDict(
        json_schema_extra={
            "example": {"name": "drone-01", "preset": "drone"},
            "presets": sorted(SCOPE_PRESETS.keys()),
            "valid_scopes": list(ALL_SCOPES),
        }
    )

    name: str = Field(min_length=1, max_length=100,
                      description="Label identifying the holder, e.g. 'drone-01'")
    scopes: Optional[List[str]] = Field(
        default=None, description="Explicit scopes. Valid: {0}".format(", ".join(ALL_SCOPES))
    )
    preset: Optional[str] = Field(
        default=None,
        description="Named bundle instead of explicit scopes: {0}".format(
            ", ".join(sorted(SCOPE_PRESETS.keys()))
        ),
    )


class ApiKeyRead(BaseModel):
    """A key as listed. Contains no usable secret - only the display prefix."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    key_prefix: str
    scopes: List[str]
    is_active: bool
    created_at: datetime
    last_used_at: Optional[datetime]


class ApiKeyCreated(ApiKeyRead):
    """Creation response - the ONLY time the plaintext key is ever available.

    Only the SHA-256 hash is stored, so this value cannot be recovered afterwards
    by anyone, including an attacker with the database. Losing it means revoking the
    key and issuing a new one.
    """

    api_key: str = Field(
        description="The secret. Shown once. Store it now - it is unrecoverable."
    )
    warning: str = Field(
        default="Copy this key now. It is not stored in plaintext and cannot be "
                "shown again.",
    )


class PrincipalRead(BaseModel):
    """GET /api/auth/me - lets a client verify its own key and scopes.

    Worth having: the alternative way to discover a missing scope is a 403 from
    whichever endpoint the dashboard happened to call first.
    """

    id: int
    name: str
    kind: str
    scopes: List[str]
