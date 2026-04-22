"""Add wallet/tier columns + video config + soft delete to superbcs_jobs.

Revision ID: 0002_wallet_video
Revises: 0001_init
Create Date: 2026-04-20
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_wallet_video"
down_revision: str | None = "0001_init"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "superbcs_jobs",
        sa.Column("wallet_address", sa.String(42), nullable=True),
    )
    op.add_column(
        "superbcs_jobs",
        sa.Column("tier", sa.String(16), nullable=True),
    )
    op.add_column(
        "superbcs_jobs",
        sa.Column(
            "duration_sec",
            sa.BigInteger,
            nullable=False,
            server_default="3",
        ),
    )
    op.add_column(
        "superbcs_jobs",
        sa.Column(
            "num_variants",
            sa.BigInteger,
            nullable=False,
            server_default="2",
        ),
    )
    op.add_column(
        "superbcs_jobs",
        sa.Column(
            "extra_output_media_ids",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "superbcs_jobs",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_superbcs_jobs_wallet_created",
        "superbcs_jobs",
        ["wallet_address", "created_at"],
    )
    op.create_check_constraint(
        "ck_superbcs_jobs_duration_pos",
        "superbcs_jobs",
        "duration_sec > 0",
    )
    op.create_check_constraint(
        "ck_superbcs_jobs_variants_pos",
        "superbcs_jobs",
        "num_variants > 0",
    )


def downgrade() -> None:
    op.drop_constraint("ck_superbcs_jobs_variants_pos", "superbcs_jobs", type_="check")
    op.drop_constraint("ck_superbcs_jobs_duration_pos", "superbcs_jobs", type_="check")
    op.drop_index("ix_superbcs_jobs_wallet_created", table_name="superbcs_jobs")
    op.drop_column("superbcs_jobs", "deleted_at")
    op.drop_column("superbcs_jobs", "extra_output_media_ids")
    op.drop_column("superbcs_jobs", "num_variants")
    op.drop_column("superbcs_jobs", "duration_sec")
    op.drop_column("superbcs_jobs", "tier")
    op.drop_column("superbcs_jobs", "wallet_address")
