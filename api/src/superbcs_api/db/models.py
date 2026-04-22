"""ORM models. Schema mirrors migrations/versions/0001_init.py exactly."""

from __future__ import annotations

import enum
from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class JobStatus(str, enum.Enum):
    QUEUED = "queued"
    CLAIMED = "claimed"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


class Job(Base):
    __tablename__ = "superbcs_jobs"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    status: Mapped[JobStatus] = mapped_column(
        Enum(
            JobStatus,
            name="superbcs_job_status",
            values_callable=lambda obj: [e.value for e in obj],
        ),
        nullable=False,
        default=JobStatus.QUEUED,
    )
    prompt: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    input_media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("superbcs_media.id"), nullable=True
    )
    output_media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("superbcs_media.id"), nullable=True
    )
    worker_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_text: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int | None] = mapped_column(BigInteger)
    vram_peak_mb: Mapped[int | None] = mapped_column(BigInteger)
    retry_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    wallet_address: Mapped[str | None] = mapped_column(String(42), nullable=True)
    tier: Mapped[str | None] = mapped_column(String(16), nullable=True)
    duration_sec: Mapped[int] = mapped_column(BigInteger, nullable=False, default=3)
    num_variants: Mapped[int] = mapped_column(BigInteger, nullable=False, default=2)
    extra_output_media_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    input_media: Mapped[Media | None] = relationship(foreign_keys=[input_media_id])
    output_media: Mapped[Media | None] = relationship(foreign_keys=[output_media_id])

    __table_args__ = (
        Index("ix_superbcs_jobs_status_created", "status", "created_at"),
        Index("ix_superbcs_jobs_ip_created", "ip_hash", "created_at"),
        Index("ix_superbcs_jobs_wallet_created", "wallet_address", "created_at"),
        CheckConstraint("retry_count >= 0", name="ck_superbcs_jobs_retry_nonneg"),
        CheckConstraint("duration_sec > 0", name="ck_superbcs_jobs_duration_pos"),
        CheckConstraint("num_variants > 0", name="ck_superbcs_jobs_variants_pos"),
    )


class Media(Base):
    __tablename__ = "superbcs_media"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    relative_path: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    content_type: Mapped[str] = mapped_column(String(64), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # input | output
    safety_passed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Worker(Base):
    __tablename__ = "superbcs_workers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ip: Mapped[str | None] = mapped_column(String(64))
    vram_free_mb: Mapped[int | None] = mapped_column(BigInteger)
    queue_capacity: Mapped[int | None] = mapped_column(BigInteger)
    version: Mapped[str | None] = mapped_column(String(64))
    total_jobs: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class RateLimitBucket(Base):
    __tablename__ = "superbcs_rate_limit"

    ip_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
