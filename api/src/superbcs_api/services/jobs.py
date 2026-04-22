"""Job lifecycle helpers: create, claim atomically, finalize."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from superbcs_api.core.settings import get_settings
from superbcs_api.db.models import Job, JobStatus, Worker


async def queue_position(session: AsyncSession, job_id: UUID) -> int:
    """Return 1-based position in the queued list."""
    target = await session.get(Job, job_id)
    if target is None:
        return 0
    stmt = select(func.count()).where(
        Job.status == JobStatus.QUEUED,
        Job.created_at <= target.created_at,
    )
    return int((await session.execute(stmt)).scalar_one())


async def claim_next(session: AsyncSession, worker_id: str, worker_ip: str) -> Job | None:
    """Atomically claim the oldest queued job for `worker_id`."""
    settings = get_settings()
    deadline = datetime.now(UTC) - timedelta(seconds=settings.job_timeout_seconds)

    # Reclaim any job stuck in claimed/running past the deadline.
    await session.execute(
        update(Job)
        .where(
            Job.status.in_([JobStatus.CLAIMED, JobStatus.RUNNING]),
            Job.claimed_at < deadline,
        )
        .values(status=JobStatus.QUEUED, worker_id=None, claimed_at=None)
    )

    cte = (
        select(Job.id)
        .where(Job.status == JobStatus.QUEUED)
        .order_by(Job.created_at.asc())
        .with_for_update(skip_locked=True)
        .limit(1)
        .scalar_subquery()
    )
    stmt = (
        update(Job)
        .where(Job.id == cte)
        .values(
            status=JobStatus.CLAIMED,
            worker_id=worker_id,
            claimed_at=datetime.now(UTC),
        )
        .returning(Job)
    )
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        return None

    # Upsert worker registry row.
    worker = await session.get(Worker, worker_id)
    if worker is None:
        session.add(
            Worker(
                id=worker_id,
                last_heartbeat_at=datetime.now(UTC),
                last_ip=worker_ip,
                total_jobs=1,
            )
        )
    else:
        worker.last_heartbeat_at = datetime.now(UTC)
        worker.last_ip = worker_ip
        worker.total_jobs += 1
    return row


async def finalize_success(
    session: AsyncSession,
    job: Job,
    *,
    output_media_id: UUID,
    duration_ms: int,
    vram_peak_mb: int | None,
) -> None:
    job.status = JobStatus.DONE
    job.output_media_id = output_media_id
    job.completed_at = datetime.now(UTC)
    job.duration_ms = duration_ms
    job.vram_peak_mb = vram_peak_mb


async def finalize_variant(
    session: AsyncSession,
    job: Job,
    *,
    media_id: UUID,
    variant_index: int,
    duration_ms: int,
    vram_peak_mb: int | None,
) -> None:
    """Variant-aware finalize.

    variant_index == 0 promotes the job to DONE and sets output_media_id.
    variant_index > 0 appends to extra_output_media_ids without changing
    job status (primary variant will move it to DONE on its own POST).
    """
    if variant_index == 0:
        job.status = JobStatus.DONE
        job.output_media_id = media_id
        job.completed_at = datetime.now(UTC)
        job.duration_ms = duration_ms
        job.vram_peak_mb = vram_peak_mb
    else:
        extras = list(job.extra_output_media_ids or [])
        media_str = str(media_id)
        if media_str not in extras:
            extras.append(media_str)
        job.extra_output_media_ids = extras


async def finalize_failure(session: AsyncSession, job: Job, *, error_text: str) -> None:
    job.status = JobStatus.ERROR
    job.error_text = error_text[:1000]
    job.completed_at = datetime.now(UTC)


async def heartbeat(
    session: AsyncSession,
    *,
    worker_id: str,
    worker_ip: str,
    vram_free_mb: int,
    queue_capacity: int,
    version: str | None,
) -> None:
    worker = await session.get(Worker, worker_id)
    now = datetime.now(UTC)
    if worker is None:
        session.add(
            Worker(
                id=worker_id,
                last_heartbeat_at=now,
                last_ip=worker_ip,
                vram_free_mb=vram_free_mb,
                queue_capacity=queue_capacity,
                version=version,
            )
        )
    else:
        worker.last_heartbeat_at = now
        worker.last_ip = worker_ip
        worker.vram_free_mb = vram_free_mb
        worker.queue_capacity = queue_capacity
        worker.version = version
