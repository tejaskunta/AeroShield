"""AeroShield - aircraft position telemetry model.

One row per beaconed position frame. Distinct from `Detection` on purpose: a
detection is a *find*, this is the aircraft's own position log, and a survey
that finds nothing still produces a full telemetry track. Collapsing them would
mean either inventing detections to carry position, or losing the drone's path
on any flight where the model was quiet.

POSITION IS STORED TWICE, the same way `Detection` stores it:
    latitude / longitude    plain floats - what the drone sent, what the API returns
    geog                    Geography(POINT, 4326) - what PostGIS queries

The floats keep the dashboard's read path a plain column select with no
ST_X/ST_Y round-trip per frame. The geography column is what makes "did the
aircraft enter this area" answerable in metres. `geog` is derived from the
floats in exactly one place - TelemetryRepository.create - and nowhere else
writes it, so the two cannot disagree.

RETENTION IS A REAL QUESTION AND IS NOT SOLVED HERE.
At 1 Hz a two-hour flight is 7,200 rows per aircraft; that is trivial. But this
table grows without bound across sessions, and the honest eventual shape is a
partition by mission or a scheduled prune keeping decimated points for old
flights. Called out rather than silently left, because "the telemetry table is
a billion rows" is not a surprise anyone should get twice.
"""

from datetime import datetime
from typing import TYPE_CHECKING, Optional

from geoalchemy2 import Geography
from geoalchemy2.elements import WKBElement
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.db.models.mission import Mission


class Telemetry(Base):
    """A single beaconed aircraft position frame."""

    __tablename__ = "telemetry"

    id: Mapped[int] = mapped_column(primary_key=True)

    # CASCADE here, unlike Detection's ON DELETE SET NULL. A detection is
    # evidence and outlives its mission row; a telemetry frame is the flight's
    # own track and has no meaning without the mission it belongs to. Deleting
    # a mission should take its track with it.
    mission_id: Mapped[int] = mapped_column(
        ForeignKey("missions.id", ondelete="CASCADE"), nullable=False
    )
    mission: Mapped["Mission"] = relationship("Mission", lazy="joined")

    # --- position ---------------------------------------------------------
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)

    # spatial_index=False: the GiST index is declared in __table_args__ so its
    # name is under the naming convention and Alembic autogenerate does not see
    # a phantom extra index.
    geog: Mapped[Optional[WKBElement]] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False), nullable=True
    )

    # --- attitude and motion ----------------------------------------------
    altitude_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    relative_altitude_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    heading_deg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    ground_speed_ms: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # --- fix quality ------------------------------------------------------
    # Not nullable-with-a-default: a frame that arrived without a fix type is
    # stored as NULL, which is the truth, rather than as 0, which is "no fix"
    # and would read as a confident bad answer.
    gps_fix_type: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    satellites_visible: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # --- aircraft state ---------------------------------------------------
    battery_pct: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    battery_volts: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    link_pct: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    flight_mode: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    armed: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)

    # --- time -------------------------------------------------------------
    # captured_at is the drone's clock at the moment of the fix; created_at is
    # when this server stored it. A spooled replay after a link outage can put
    # hours between them, so anything ordering or ageing a track must use
    # captured_at. Every read query in the repository does.
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # Short names: the naming convention in app/db/base.py prefixes
        # ck_%(table_name)s_, so these become ck_telemetry_latitude_in_range and
        # so on. Writing the full name here would double the prefix.
        CheckConstraint(
            "latitude >= -90 AND latitude <= 90", name="latitude_in_range"
        ),
        CheckConstraint(
            "longitude >= -180 AND longitude <= 180", name="longitude_in_range"
        ),
        # The same bounds the ingest schema enforces, restated at the database
        # boundary. The drone is one client among several to come.
        CheckConstraint(
            "battery_pct IS NULL OR (battery_pct >= 0 AND battery_pct <= 100)",
            name="battery_in_range",
        ),
        CheckConstraint(
            "link_pct IS NULL OR (link_pct >= 0 AND link_pct <= 100)",
            name="link_in_range",
        ),
        CheckConstraint(
            "heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)",
            name="heading_in_range",
        ),

        # The dashboard's query: one mission's newest frames first. Ascending,
        # matching ix_detections_mission_captured - Postgres scans an index
        # backwards as cheaply as forwards, so ORDER BY captured_at DESC LIMIT 1
        # uses this without a DESC index, and a DESC index would be a second
        # convention to remember for no gain.
        Index("ix_telemetry_mission_captured", "mission_id", "captured_at"),

        # PostGIS proximity, for the same reason Detection has one: "what was the
        # aircraft near when X happened" should not be a full scan.
        Index("ix_telemetry_geog", "geog", postgresql_using="gist"),
    )

    def __repr__(self) -> str:
        return "<Telemetry id={0} mission={1} lat={2} lon={3}>".format(
            self.id, self.mission_id, self.latitude, self.longitude
        )
