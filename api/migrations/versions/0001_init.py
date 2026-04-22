"""Initial schema: jobs, media, workers, rate-limit buckets.

Revision ID: 0001_init
Revises:
Create Date: 2026-04-20

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_init"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "superbcs_media",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("relative_path", sa.String(255), nullable=False, unique=True),
        sa.Column("content_type", sa.String(64), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("safety_passed", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    job_status = postgresql.ENUM(
        "queued",
        "claimed",
        "running",
        "done",
        "error",
        "cancelled",
        name="superbcs_job_status",
        create_type=True,
    )
    op.create_table(
        "superbcs_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("status", job_status, nullable=False, server_default="queued"),
        sa.Column("prompt", postgresql.JSONB, nullable=False),
        sa.Column(
            "input_media_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("superbcs_media.id"),
            nullable=True,
        ),
        sa.Column(
            "output_media_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("superbcs_media.id"),
            nullable=True,
        ),
        sa.Column("worker_id", sa.String(64), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_text", sa.Text, nullable=True),
        sa.Column("duration_ms", sa.BigInteger, nullable=True),
        sa.Column("vram_peak_mb", sa.BigInteger, nullable=True),
        sa.Column("retry_count", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("ip_hash", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("retry_count >= 0", name="ck_superbcs_jobs_retry_nonneg"),
    )
    op.create_index(
        "ix_superbcs_jobs_status_created", "superbcs_jobs", ["status", "created_at"]
    )
    op.create_index(
        "ix_superbcs_jobs_ip_created", "superbcs_jobs", ["ip_hash", "created_at"]
    )

    op.create_table(
        "superbcs_workers",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_ip", sa.String(64), nullable=True),
        sa.Column("vram_free_mb", sa.BigInteger, nullable=True),
        sa.Column("queue_capacity", sa.BigInteger, nullable=True),
        sa.Column("version", sa.String(64), nullable=True),
        sa.Column("total_jobs", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_table(
        "superbcs_rate_limit",
        sa.Column("ip_hash", sa.String(64), primary_key=True),
        sa.Column("window_start", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("count", sa.BigInteger, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("superbcs_rate_limit")
    op.drop_table("superbcs_workers")
    op.drop_index("ix_superbcs_jobs_ip_created", table_name="superbcs_jobs")
    op.drop_index("ix_superbcs_jobs_status_created", table_name="superbcs_jobs")
    op.drop_table("superbcs_jobs")
    op.drop_table("superbcs_media")
    sa.Enum(name="superbcs_job_status").drop(op.get_bind(), checkfirst=True)
