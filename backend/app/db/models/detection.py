"""AeroShield - detection model.

One row per detected object per frame. This is the table the whole system exists to
populate, and the one the Week 6 map, the Week 11 safe-path planner and the Week 11
report agent all read from.

TWO REPRESENTATIONS OF POSITION, ON PURPOSE:
    latitude / longitude    plain floats - what the drone sent, what the API returns
    geog                    Geography(POINT, 4326) - what PostGIS queries

The floats keep reads and JSON serialisation trivial (no ST_X/ST_Y round-trip on
every row the dashboard renders). The geography column is what makes ST_DWithin and
ST_Distance possible, which PRD section 7 requires for the A* risk graph. They can
drift, so `geog` is derived from the floats in exactly one place -
DetectionRepository.create - and nowhere else writes it.

Geography rather than Geometry: geography measures in metres on a spheroid, so
`ST_DWithin(geog, point, 500)` means 500 metres. With Geometry(4326) the same call
means 500 *degrees*, which silently matches the entire planet. That distinction is a
safety bug waiting to happen in a system that answers "what mines are near me".
"""

from datetime import datetime
from typing import TYPE_CHECKING, Optional
from uuid import UUID

from geoalchemy2 import Geography
from geoalchemy2.elements import WKBElement
from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.db.models.mission import Mission


class Detection(Base):
    """A single geotagged detection."""

    __tablename__ = "detections"

    id: Mapped[int] = mapped_column(primary_key=True)

    # --- idempotency ------------------------------------------------------
    # Generated on the drone, unique here. A radio link that drops mid-POST makes
    # the client retry; without this the same mine would be recorded two, five,
    # twenty times and the mission count would be fiction.
    client_detection_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, unique=True
    )

    # --- provenance -------------------------------------------------------
    # Nullable, with ON DELETE SET NULL: a detection that arrived while the backend
    # could not resolve a mission (spooled during a link outage, replayed later) is
    # still evidence. Discarding it to preserve referential tidiness would be the
    # wrong trade in a safety system.
    mission_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("missions.id", ondelete="SET NULL"), nullable=True
    )
    mission: Mapped[Optional["Mission"]] = relationship(
        "Mission", back_populates="detections", lazy="joined"
    )

    # --- what was detected ------------------------------------------------
    class_name: Mapped[str] = mapped_column(String(100), nullable=False)
    class_id: Mapped[int] = mapped_column(Integer, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)

    # Pixel box in the ORIGINAL frame's coordinates (not letterboxed).
    bbox_x1: Mapped[int] = mapped_column(Integer, nullable=False)
    bbox_y1: Mapped[int] = mapped_column(Integer, nullable=False)
    bbox_x2: Mapped[int] = mapped_column(Integer, nullable=False)
    bbox_y2: Mapped[int] = mapped_column(Integer, nullable=False)

    # --- where it was ------------------------------------------------------
    # All nullable. A detection with no GPS lock is recorded ungeotagged rather
    # than dropped or defaulted to (0, 0) - see jetson/gps.py NullGpsProvider for
    # the same reasoning on the drone side.
    latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    altitude_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    relative_altitude_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    heading_deg: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    gps_fix_type: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    satellites_visible: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # 1-sigma horizontal error from jetson/geo.py. Stored so the dashboard can draw
    # an uncertainty circle instead of a pin that implies precision we do not have
    # (PRD section 10).
    horizontal_error_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # spatial_index=False: the GiST index is declared explicitly in __table_args__
    # so its name is under the naming convention and Alembic does not see a
    # phantom extra index on every autogenerate.
    # The Python-side value is a WKBElement when loaded from the database. It is
    # written as WKT by the repository; nothing reads it back through the ORM, since
    # latitude/longitude carry the same fact in a directly-usable form.
    geog: Mapped[Optional[WKBElement]] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False), nullable=True
    )

    # --- evidence ---------------------------------------------------------
    # Path relative to the storage root, not an absolute path: absolute paths break
    # the moment the app moves into a container with a different mount point.
    image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    frame_width: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    frame_height: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # --- how it was produced ----------------------------------------------
    inference_ms: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Which weights produced this. Needed to re-evaluate old detections after a
    # retrain, and to explain a sudden change in false-positive rate.
    model_version: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    source: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # --- time -------------------------------------------------------------
    # captured_at is when the frame was taken (drone clock); created_at is when the
    # server stored it. They differ by the spool delay, which can be the whole
    # flight if the link was down - so ordering a mission timeline must use
    # captured_at, and never created_at.
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # Reject impossible values at the database boundary. The drone is one client
        # among several to come; the constraint holds for all of them.
        CheckConstraint("confidence >= 0.0 AND confidence <= 1.0",
                        name="confidence_in_range"),
        CheckConstraint("latitude IS NULL OR (latitude >= -90 AND latitude <= 90)",
                        name="latitude_in_range"),
        CheckConstraint("longitude IS NULL OR (longitude >= -180 AND longitude <= 180)",
                        name="longitude_in_range"),
        CheckConstraint("bbox_x2 > bbox_x1 AND bbox_y2 > bbox_y1",
                        name="bbox_well_formed"),
        # Either both coordinates or neither. One-sided coordinates are corrupt and
        # would produce a point at latitude 0 in any naive consumer.
        CheckConstraint(
            "(latitude IS NULL) = (longitude IS NULL)",
            name="latlon_both_or_neither",
        ),

        # PostGIS proximity queries (PRD section 7). Without GiST, ST_DWithin is a
        # full scan and the Week 11 planner degrades as the dataset grows.
        Index("ix_detections_geog", "geog", postgresql_using="gist"),

        # The dashboard's main query: one mission's detections, newest first.
        Index("ix_detections_mission_captured", "mission_id", "captured_at"),
        Index("ix_detections_class_name", "class_name"),
        Index("ix_detections_captured_at", "captured_at"),
    )

    def __repr__(self) -> str:
        return "<Detection id={0} class={1!r} conf={2:.2f} lat={3} lon={4}>".format(
            self.id, self.class_name, self.confidence, self.latitude, self.longitude
        )
