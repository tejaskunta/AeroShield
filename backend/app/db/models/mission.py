"""AeroShield - mission model.

A mission groups the detections from one flight. Week 5 needs it to satisfy "store
detection history"; Week 11's report agent needs it to have something to report
*about* - "mission stats + detections" per PRD section 5.1.
"""

import enum
from datetime import datetime
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import CheckConstraint, DateTime, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.db.models.detection import Detection


class MissionStatus(str, enum.Enum):
    """Lifecycle of a survey flight."""

    ACTIVE = "active"
    COMPLETED = "completed"
    ABORTED = "aborted"

    @classmethod
    def values(cls) -> List[str]:
        return [member.value for member in cls]


class Mission(Base):
    """One survey flight.

    Stored as a plain string with a CHECK constraint rather than a native Postgres
    ENUM type. Adding a value to a PG enum needs ALTER TYPE, which cannot run
    inside a transaction on older servers and makes migrations awkward; a CHECK
    constraint is a one-line migration to change.
    """

    __tablename__ = "missions"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Unique, because the drone does get-or-create by name at startup. That is what
    # lets it re-register after a reboot mid-flight without splitting one flight
    # across two mission rows.
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)

    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=MissionStatus.ACTIVE.value
    )

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    ended_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # No cascade delete: losing a mission row must not silently destroy the
    # detections filed under it. Detection.mission_id is ON DELETE SET NULL.
    detections: Mapped[List["Detection"]] = relationship(
        back_populates="mission", lazy="raise"
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('active', 'completed', 'aborted')",
            name="mission_status_valid",
        ),
        Index("ix_missions_status", "status"),
        Index("ix_missions_started_at", "started_at"),
    )

    def __repr__(self) -> str:
        return "<Mission id={0} name={1!r} status={2}>".format(self.id, self.name, self.status)
