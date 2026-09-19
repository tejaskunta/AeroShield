"""AeroShield - API key model.

Only the hash is stored. A key is shown to a human exactly once, at creation, and
is unrecoverable afterwards - which is the point: a database dump does not leak
working credentials.
"""

from datetime import datetime
from typing import List, Optional

from sqlalchemy import Boolean, DateTime, Index, String, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ApiKey(Base):
    """A credential held by a drone, a dashboard, or an operator's tooling."""

    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Human label, so a key can be revoked by knowing which device it went to.
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    # Leading fragment of the plaintext, for display in listings only.
    key_prefix: Mapped[str] = mapped_column(String(20), nullable=False)

    # Hex SHA-256 of the full key. Unique + indexed because authentication is a
    # lookup by this value on every single request - it is the hottest query in
    # the system and must not be a table scan.
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    # Postgres text[]. A join table would be more normalised, but scopes are read
    # on every request and never queried independently, so the array avoids a join
    # in the hot path.
    scopes: Mapped[List[str]] = mapped_column(ARRAY(String(50)), nullable=False)

    # Revocation is a flag, not a delete: the audit trail of which key ingested
    # which detection has to survive the key being turned off.
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Best-effort, updated on use. Makes an unused or forgotten key visible.
    last_used_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index("ix_api_keys_is_active", "is_active"),
    )

    def __repr__(self) -> str:
        return "<ApiKey id={0} name={1!r} prefix={2}>".format(
            self.id, self.name, self.key_prefix
        )
