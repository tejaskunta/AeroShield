"""telemetry: aircraft position track

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-24

The aircraft's own position log, separate from `detections`.

NOTE ON THE NUMBER: this was written as 0002 and chained off 0001, but a
review_gradcam migration from 2026-09-28 had already claimed 0002 in a branch
this work did not see. Two revisions sharing an id and a parent is a fork, and
Alembic refuses to resolve 'head' across a fork - correctly, since it cannot
guess an order. This is renumbered to 0003 and re-chained onto the other 0002,
which is what really happened: review_gradcam shipped first and is already
applied in every database that has run migrations.

Motivation: the dashboard's drone marker was driven by the client-side
simulator, and the only real drone-sourced positions in the database were the
per-detection geotags. Those cannot answer "where is the drone now" - they are
silent before the first find, during every stretch of empty ground, and for the
entire return leg. This table is the missing stream.

SAME TWO-REPRESENTATION POSITION AS `detections`:
    latitude / longitude    floats, what the drone sent and the API returns
    geog                    Geography(POINT, 4326), what PostGIS queries

Both are written together in telemetry_repository.create and nowhere else, so
they cannot drift. Geography rather than Geometry for the same reason as in
0001: geography measures in metres on a spheroid, so ST_DWithin(geog, p, 500)
means 500 m. With Geometry(4326) it would mean 500 degrees.

ON DELETE CASCADE, unlike detections' ON DELETE SET NULL. A detection is
evidence and outlives its mission row; a telemetry frame is the flight's own
track and means nothing without the flight.

The CHECK constraints restate the ingest schema's bounds at the database
boundary. Pydantic rejects a bad frame at the edge, but the drone is one client
among several to come and the constraint holds for all of them.

No data migration: this table starts empty, and the simulator that previously
supplied the dashboard's positions is not real flight data that anyone should
inherit.
"""

from typing import Sequence, Union

import geoalchemy2
import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # PostGIS is already installed by 0001; not repeated here. A revision that
    # can only run after another should not silently also be runnable before it.
    op.create_table(
        "telemetry",
        sa.Column("id", sa.Integer(), nullable=False),

        # CASCADE, not SET NULL: see the module docstring.
        sa.Column("mission_id", sa.Integer(), nullable=False),

        # Position, twice.
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column(
            "geog",
            geoalchemy2.types.Geography(
                geometry_type="POINT", srid=4326, spatial_index=False
            ),
            nullable=True,
        ),

        # Attitude and motion. altitude_m is above MSL, relative_altitude_m is
        # above the launch point - the latter is what the geotag error budget
        # uses, so they are stored apart rather than as one "altitude".
        sa.Column("altitude_m", sa.Float(), nullable=True),
        sa.Column("relative_altitude_m", sa.Float(), nullable=True),
        sa.Column("heading_deg", sa.Float(), nullable=True),
        sa.Column("ground_speed_ms", sa.Float(), nullable=True),

        # Fix quality. A position logged under a 2D fix has a known-worse error;
        # keeping the fix type records which frames those were.
        sa.Column("gps_fix_type", sa.Integer(), nullable=True),
        sa.Column("satellites_visible", sa.Integer(), nullable=True),

        # Aircraft state, all optional - a frame with a position and no battery
        # reading is still a position, and the ingest schema accepts it.
        sa.Column("battery_pct", sa.Integer(), nullable=True),
        sa.Column("battery_volts", sa.Float(), nullable=True),
        sa.Column("link_pct", sa.Integer(), nullable=True),
        sa.Column("flight_mode", sa.String(length=20), nullable=True),
        sa.Column("armed", sa.Boolean(), nullable=True),

        # captured_at is the drone's clock at the fix; created_at is arrival. A
        # spooled replay can put hours between them, so ordering and ageing must
        # use captured_at.
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.text("now()"),
        ),

        sa.ForeignKeyConstraint(
            ["mission_id"], ["missions.id"],
            name="fk_telemetry_mission_id_missions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_telemetry"),

        # Restating the ingest bounds at the database boundary. Full names here,
        # not the short form the model uses: op.create_table builds its own
        # MetaData without the naming convention, so nothing prefixes these.
        # Same style as 0001.
        sa.CheckConstraint(
            "latitude >= -90 AND latitude <= 90", name="ck_telemetry_latitude_in_range"
        ),
        sa.CheckConstraint(
            "longitude >= -180 AND longitude <= 180", name="ck_telemetry_longitude_in_range"
        ),
        sa.CheckConstraint(
            "battery_pct IS NULL OR (battery_pct >= 0 AND battery_pct <= 100)",
            name="ck_telemetry_battery_in_range",
        ),
        sa.CheckConstraint(
            "link_pct IS NULL OR (link_pct >= 0 AND link_pct <= 100)",
            name="ck_telemetry_link_in_range",
        ),
        sa.CheckConstraint(
            "heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)",
            name="ck_telemetry_heading_in_range",
        ),
    )

    # The dashboard's query, newest-first within a mission. Ascending, matching
    # ix_detections_mission_captured: Postgres scans an index backwards as cheaply
    # as forwards, so ORDER BY captured_at DESC LIMIT 1 uses this without a DESC
    # index. This is the query that runs at ~1 Hz per open dashboard.
    op.create_index(
        "ix_telemetry_mission_captured",
        "telemetry",
        ["mission_id", "captured_at"],
    )

    # PostGIS proximity. Same reasoning as ix_detections_geog: without GiST,
    # ST_DWithin is a full scan and "what was the aircraft near when X happened"
    # degrades as the table grows.
    op.create_index(
        "ix_telemetry_geog", "telemetry", ["geog"], postgresql_using="gist"
    )


def downgrade() -> None:
    # Indexes go with the table, but dropped explicitly so the intent survives a
    # partial failure and the downgrade is readable on its own.
    op.drop_index("ix_telemetry_geog", table_name="telemetry")
    op.drop_index("ix_telemetry_mission_captured", table_name="telemetry")
    op.drop_table("telemetry")
