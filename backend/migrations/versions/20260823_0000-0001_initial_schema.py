"""initial schema: api_keys, missions, detections + postgis

Revision ID: 0001
Revises:
Create Date: 2026-08-23

Week 5's database. Three tables, one extension, and the GiST index that makes the
Week 11 safe-path planner viable.

The PostGIS extension is created FIRST and in its own statement. The detections
table has a Geography column, so the type must exist before the table referencing
it - CREATE EXTENSION cannot be reordered after, and a failure here is much easier
to read than "type geography does not exist" from inside a CREATE TABLE.
"""

from typing import Sequence, Union

import geoalchemy2
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- extension --------------------------------------------------------
    # IF NOT EXISTS: docker-compose's init script already enables it on a fresh
    # volume, but a database created by hand will not have it. Idempotent either way.
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    # --- api_keys ---------------------------------------------------------
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("key_prefix", sa.String(length=20), nullable=False),
        # Only the SHA-256 hash is stored; the plaintext key is unrecoverable.
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("scopes", postgresql.ARRAY(sa.String(length=50)), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False,
                  server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_api_keys"),
        # Unique + indexed: authentication is a lookup on this column for every
        # single request, including the drone's ingest stream.
        sa.UniqueConstraint("key_hash", name="uq_api_keys_key_hash"),
    )
    op.create_index("ix_api_keys_is_active", "api_keys", ["is_active"])

    # --- missions ---------------------------------------------------------
    op.create_table(
        "missions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False,
                  server_default=sa.text("'active'")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id", name="pk_missions"),
        # Unique name is what makes the drone's get-or-create-by-name work, so a
        # reboot mid-flight rejoins the mission instead of forking it.
        sa.UniqueConstraint("name", name="uq_missions_name"),
        sa.CheckConstraint(
            "status IN ('active', 'completed', 'aborted')",
            name="ck_missions_mission_status_valid",
        ),
    )
    op.create_index("ix_missions_status", "missions", ["status"])
    op.create_index("ix_missions_started_at", "missions", ["started_at"])

    # --- detections -------------------------------------------------------
    op.create_table(
        "detections",
        sa.Column("id", sa.Integer(), nullable=False),
        # Idempotency key generated on the drone. Unique, so a spool replay after a
        # dropped radio link cannot duplicate a detection.
        sa.Column("client_detection_id", postgresql.UUID(as_uuid=True),
                  nullable=False),
        sa.Column("mission_id", sa.Integer(), nullable=True),

        sa.Column("class_name", sa.String(length=100), nullable=False),
        sa.Column("class_id", sa.Integer(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),

        sa.Column("bbox_x1", sa.Integer(), nullable=False),
        sa.Column("bbox_y1", sa.Integer(), nullable=False),
        sa.Column("bbox_x2", sa.Integer(), nullable=False),
        sa.Column("bbox_y2", sa.Integer(), nullable=False),

        # All position columns nullable: a detection with no GPS lock is recorded
        # ungeotagged rather than dropped or defaulted to (0, 0).
        sa.Column("latitude", sa.Float(), nullable=True),
        sa.Column("longitude", sa.Float(), nullable=True),
        sa.Column("altitude_m", sa.Float(), nullable=True),
        sa.Column("relative_altitude_m", sa.Float(), nullable=True),
        sa.Column("heading_deg", sa.Float(), nullable=True),
        sa.Column("gps_fix_type", sa.Integer(), nullable=True),
        sa.Column("satellites_visible", sa.Integer(), nullable=True),
        sa.Column("horizontal_error_m", sa.Float(), nullable=True),

        # Geography, not Geometry: distances are then in METRES, so
        # ST_DWithin(geog, point, 500) means 500 m. With geometry(4326) the same
        # call means 500 degrees and silently matches the whole planet.
        sa.Column(
            "geog",
            geoalchemy2.types.Geography(
                geometry_type="POINT", srid=4326, spatial_index=False,
                from_text="ST_GeogFromText", name="geography",
            ),
            nullable=True,
        ),

        sa.Column("image_path", sa.String(length=500), nullable=True),
        sa.Column("frame_width", sa.Integer(), nullable=True),
        sa.Column("frame_height", sa.Integer(), nullable=True),

        sa.Column("inference_ms", sa.Float(), nullable=True),
        sa.Column("model_version", sa.String(length=200), nullable=True),
        sa.Column("source", sa.String(length=100), nullable=True),

        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),

        sa.PrimaryKeyConstraint("id", name="pk_detections"),
        sa.UniqueConstraint("client_detection_id",
                            name="uq_detections_client_detection_id"),
        # SET NULL, not CASCADE: deleting a mission must not silently destroy the
        # detections filed under it.
        sa.ForeignKeyConstraint(
            ["mission_id"], ["missions.id"],
            name="fk_detections_mission_id_missions", ondelete="SET NULL",
        ),
        sa.CheckConstraint("confidence >= 0.0 AND confidence <= 1.0",
                           name="ck_detections_confidence_in_range"),
        sa.CheckConstraint("latitude IS NULL OR (latitude >= -90 AND latitude <= 90)",
                           name="ck_detections_latitude_in_range"),
        sa.CheckConstraint("longitude IS NULL OR (longitude >= -180 AND longitude <= 180)",
                           name="ck_detections_longitude_in_range"),
        sa.CheckConstraint("bbox_x2 > bbox_x1 AND bbox_y2 > bbox_y1",
                           name="ck_detections_bbox_well_formed"),
        # One-sided coordinates are corrupt: most consumers would plot a bare
        # latitude on the prime meridian.
        sa.CheckConstraint("(latitude IS NULL) = (longitude IS NULL)",
                           name="ck_detections_latlon_both_or_neither"),
    )

    # GiST on the geography column. Without it, ST_DWithin is a sequential scan and
    # the Week 11 A* risk graph degrades as the dataset grows (PRD 7).
    op.create_index("ix_detections_geog", "detections", ["geog"],
                    postgresql_using="gist")

    # The dashboard's primary query: one mission's detections, newest frame first.
    op.create_index("ix_detections_mission_captured", "detections",
                    ["mission_id", "captured_at"])
    op.create_index("ix_detections_class_name", "detections", ["class_name"])
    op.create_index("ix_detections_captured_at", "detections", ["captured_at"])


def downgrade() -> None:
    op.drop_index("ix_detections_captured_at", table_name="detections")
    op.drop_index("ix_detections_class_name", table_name="detections")
    op.drop_index("ix_detections_mission_captured", table_name="detections")
    op.drop_index("ix_detections_geog", table_name="detections")
    op.drop_table("detections")

    op.drop_index("ix_missions_started_at", table_name="missions")
    op.drop_index("ix_missions_status", table_name="missions")
    op.drop_table("missions")

    op.drop_index("ix_api_keys_is_active", table_name="api_keys")
    op.drop_table("api_keys")

    # The postgis extension is deliberately NOT dropped. It is database-wide, may be
    # used by anything else in this database, and dropping it cascades into every
    # geometry column that exists. Removing our tables should not be able to break
    # something we do not own.
