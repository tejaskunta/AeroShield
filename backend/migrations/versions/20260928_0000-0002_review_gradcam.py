"""review adjudication + gradcam evidence columns on detections

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-28

Week 11's schema delta. Two features land at once because both add columns to
`detections` and neither is worth a migration on its own:

  * review_state / review_reason / reviewed_by / reviewed_at
      The human-adjudication workflow (PRD 5.1): a detection is confirmed,
      dismissed, or flagged by an operator, and the mission report tallies those
      decisions. The CHECK constraint enumerates the states so a buggy client
      cannot store a value the dashboard's colouring does not know.

  * gradcam_path
      Where the edge device stored the Grad-CAM heatmap for this frame, so the
      detection card can show *why* the model fired (PRD 5.1, explainability).

All columns are nullable with no server default: existing rows simply have no
review and no heatmap, which is the truth for data ingested before this feature
existed. Backfilling 'unreviewed' would manufacture a timestamp-free decision
that was never made.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "detections",
        sa.Column("gradcam_path", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "detections",
        sa.Column("review_state", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "detections",
        sa.Column("review_reason", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "detections",
        sa.Column("reviewed_by", sa.String(length=100), nullable=True),
    )
    op.add_column(
        "detections",
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "review_state_valid",
        "detections",
        "review_state IS NULL OR review_state IN "
        "('unreviewed', 'confirmed', 'dismissed', 'flagged')",
    )


def downgrade() -> None:
    op.drop_constraint("review_state_valid", "detections", type_="check")
    op.drop_column("detections", "reviewed_at")
    op.drop_column("detections", "reviewed_by")
    op.drop_column("detections", "review_reason")
    op.drop_column("detections", "review_state")
    op.drop_column("detections", "gradcam_path")
