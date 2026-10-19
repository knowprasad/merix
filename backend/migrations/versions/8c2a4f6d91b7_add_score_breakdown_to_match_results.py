"""add deterministic score breakdown to match results

Revision ID: 8c2a4f6d91b7
Revises: c41f9a7de208
Create Date: 2026-10-19

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "8c2a4f6d91b7"
down_revision: str | None = "c41f9a7de208"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "match_results",
        sa.Column("score_breakdown", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("match_results", "score_breakdown")
