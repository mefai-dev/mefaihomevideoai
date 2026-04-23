"""Worker-facing endpoints. Bearer-only, IP-allowlisted."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from superbcs_api.api.deps import SessionDep
from superbcs_api.api.public import _media_url as _signed_media_url
from superbcs_api.core.logging import get_logger
from superbcs_api.core.security import client_ip, require_worker_bearer
from superbcs_api.core.settings import get_settings
from superbcs_api.db.models import Job, JobStatus, Media
from superbcs_api.schemas.jobs import HeartbeatIn, JobStatusOut, WorkerJobOut
from superbcs_api.services import safety, storage
from superbcs_api.services.jobs import (
    claim_next,
    finalize_failure,
    finalize_variant,
    heartbeat,
)

router = APIRouter(
    prefix="/api/superbcs/worker",
    tags=["worker"],
    dependencies=[Depends(require_worker_bearer)],
)
log = get_logger(__name__)


def _media_url(media_id: UUID | None) -> str | None:
    if media_id is None:
        return None
    return _signed_media_url(media_id)


@router.get("/claim")
async def claim(
    request: Request,
    session: Annotated[AsyncSession, SessionDep],
) -> Response:
    settings = get_settings()
    worker_id = request.headers.get("x-worker-id") or "anonymous"
    job = await claim_next(session, worker_id=worker_id, worker_ip=client_ip(request))
    if job is None:
        await session.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    deadline = datetime.now(UTC) + timedelta(seconds=settings.job_timeout_seconds)
    payload = WorkerJobOut(
        job_id=job.id,
        prompt=str(job.prompt.get("text", "")),
        motion_preset=str(job.prompt.get("motion_preset", "")),
        token_symbol=str(job.prompt.get("token_symbol", "")),
        seed=job.prompt.get("seed") if isinstance(job.prompt.get("seed"), int) else None,
        input_image_url=_media_url(job.input_media_id),
        deadline_at=deadline,
        duration_sec=int(job.duration_sec or 3),
        num_variants=int(job.num_variants or 2),
        aspect_ratio="9:16",
        width=480,
        height=832,
        fps=24,
    )
    await session.commit()
    log.info("job_claimed", job_id=str(job.id), worker_id=worker_id)
    return Response(
        content=payload.model_dump_json(),
        media_type="application/json",
    )


@router.post("/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def post_heartbeat(
    request: Request,
    body: HeartbeatIn,
    session: Annotated[AsyncSession, SessionDep],
) -> Response:
    await heartbeat(
        session,
        worker_id=body.worker_id,
        worker_ip=client_ip(request),
        vram_free_mb=body.vram_free_mb,
        queue_capacity=body.queue_capacity,
        version=body.version,
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


_VIDEO_CONTENT_TYPES = {"MP4": "video/mp4", "WEBM": "video/webm"}
_IMAGE_CONTENT_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


@router.post("/result", response_model=JobStatusOut)
async def post_result(
    job_id: Annotated[UUID, Form()],
    status_value: Annotated[str, Form(alias="status", pattern=r"^(done|error)$")],
    duration_ms: Annotated[int, Form(ge=0)],
    session: Annotated[AsyncSession, SessionDep],
    # New canonical fields (video-capable)
    file_sha256: Annotated[str | None, Form(pattern=r"^[a-f0-9]{64}$")] = None,
    file: Annotated[UploadFile | None, File()] = None,
    media_kind: Annotated[str, Form(pattern=r"^(image|video)$")] = "image",
    variant_index: Annotated[int, Form(ge=0, le=3)] = 0,
    # Legacy aliases (old SDXL worker)
    image_sha256: Annotated[str | None, Form(pattern=r"^[a-f0-9]{64}$")] = None,
    image: Annotated[UploadFile | None, File()] = None,
    error_text: Annotated[str | None, Form()] = None,
    vram_peak_mb: Annotated[int | None, Form(ge=0)] = None,
) -> JobStatusOut:
    job = await session.get(Job, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")

    # Variant index 0 (primary) may only be posted while CLAIMED/RUNNING.
    # Variant index > 0 (extras) may arrive either before or after the primary
    # promotes the job to DONE — allow DONE in that case only.
    allowed_states = {JobStatus.CLAIMED, JobStatus.RUNNING}
    if variant_index > 0:
        allowed_states = allowed_states | {JobStatus.DONE}
    if job.status not in allowed_states:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"unexpected job state: {job.status.value}",
        )

    if status_value == "error":
        await finalize_failure(session, job, error_text=error_text or "worker reported error")
        await session.commit()
    else:
        upload = file if file is not None else image
        declared_sha = file_sha256 if file_sha256 is not None else image_sha256
        if upload is None or declared_sha is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "file (or legacy image) + file_sha256 are required for done",
            )

        data = await upload.read()
        import hashlib

        actual = hashlib.sha256(data).hexdigest()
        if actual != declared_sha:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "sha256 mismatch")

        # Infer kind if legacy image field was used without media_kind hint.
        effective_kind = media_kind
        if file is None and image is not None and media_kind == "image":
            effective_kind = "image"

        try:
            if effective_kind == "video":
                fmt, _, _, _, _ = safety.validate_video_bytes(data)
                content_type = _VIDEO_CONTENT_TYPES.get(fmt, "application/octet-stream")
            else:
                fmt, _, _ = safety.validate_image_bytes(data)
                content_type = _IMAGE_CONTENT_TYPES.get(fmt, f"image/{fmt.lower()}")
        except ValueError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

        media_id, rel, sha = storage.write_media(data, image_format=fmt)
        session.add(
            Media(
                id=media_id,
                relative_path=rel,
                content_type=content_type,
                sha256=sha,
                size_bytes=len(data),
                role="output",
                safety_passed=True,
            )
        )
        await finalize_variant(
            session,
            job,
            media_id=media_id,
            variant_index=variant_index,
            duration_ms=duration_ms,
            vram_peak_mb=vram_peak_mb,
        )
        await session.commit()

    log.info(
        "job_finalized",
        job_id=str(job.id),
        outcome=status_value,
        duration_ms=duration_ms,
        variant_index=variant_index,
        kind=media_kind,
    )

    extras = [_media_url(UUID(m)) for m in (job.extra_output_media_ids or []) if m]
    return JobStatusOut(
        job_id=job.id,
        status=job.status.value,
        media_url=_media_url(job.output_media_id),
        media_id=job.output_media_id,
        media_urls=[u for u in extras if u is not None],
        error_text=job.error_text,
        duration_ms=job.duration_ms,
        created_at=job.created_at,
        completed_at=job.completed_at,
    )
