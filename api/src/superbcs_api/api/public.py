"""Public-facing endpoints (user submissions, status polls, history, media)."""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from superbcs_api.api.deps import OptionalWalletDep, RequiredWalletDep, SessionDep
from superbcs_api.core.logging import get_logger
from superbcs_api.core.security import client_ip, verify_turnstile
from superbcs_api.core.settings import get_settings
from superbcs_api.db.models import Job, JobStatus, Media
from superbcs_api.schemas.jobs import (
    MOTION_PRESETS,
    HistoryItem,
    HistoryOut,
    JobCreated,
    JobStatusOut,
    TierStatusOut,
)
from superbcs_api.services import safety, storage
from superbcs_api.services.auth import WalletSession
from superbcs_api.services.jobs import queue_position
from superbcs_api.services.quota import daily_quota_state, quota_limit_for_tier
from superbcs_api.services.rate_limit import check_and_increment, hash_ip
from superbcs_api.services.tiers import ANON_TIER, get_tier_for_wallet

router = APIRouter(prefix="/api/superbcs", tags=["public"])
log = get_logger(__name__)


_MEDIA_SIG_LABEL = b"media-signing-v1"
_MEDIA_SIG_TTL_SEC = 24 * 60 * 60  # 24h — generous for renders, cache-friendly


def _sign_media(media_id: UUID, *, exp: int) -> str:
    """Deterministic HMAC over (media_id, exp). Truncated to 128 bits.

    Uses a dedicated `media_signing_key` (falls back to worker_token if the
    dedicated key is unset, for back-compat). Separating these keys means a
    leak of the worker bearer does not automatically let an attacker mint
    signed media URLs, and vice versa.
    """
    key = get_settings().media_hmac_key
    msg = _MEDIA_SIG_LABEL + b":" + str(media_id).encode() + b":" + str(exp).encode()
    return hmac.new(key, msg, hashlib.sha256).hexdigest()[:32]


def _verify_media_sig(media_id: UUID, *, exp: int, sig: str) -> bool:
    """Verify a signed media URL.

    Accepts either the current media_signing_key *or* the worker_token — the
    latter covers URLs issued before the key split rollout so they stay valid
    for their remaining TTL (24h). After that window, only the dedicated
    media_signing_key signs and verifies.
    """
    if exp < int(datetime.now(UTC).timestamp()):
        return False
    msg = _MEDIA_SIG_LABEL + b":" + str(media_id).encode() + b":" + str(exp).encode()
    settings = get_settings()
    keys: list[bytes] = [settings.media_hmac_key]
    legacy = settings.worker_token.get_secret_value().encode()
    if legacy != settings.media_hmac_key:
        keys.append(legacy)
    for key in keys:
        expected = hmac.new(key, msg, hashlib.sha256).hexdigest()[:32]
        if hmac.compare_digest(expected, sig):
            return True
    return False


def _media_url(media_id: UUID) -> str:
    """Return a signed, time-limited URL for media_id.

    Uses a neutral `/v/{id}` path so shared links do not expose internal
    API structure. Nginx rewrites `/v/{id}` back to the real media route.
    """
    exp = int(datetime.now(UTC).timestamp()) + _MEDIA_SIG_TTL_SEC
    sig = _sign_media(media_id, exp=exp)
    base = get_settings().public_base_url
    return f"{base}/v/{media_id}?exp={exp}&sig={sig}"


def _all_media_urls(job: Job) -> list[str]:
    urls: list[str] = []
    if job.output_media_id is not None:
        urls.append(_media_url(job.output_media_id))
    for raw in job.extra_output_media_ids or []:
        try:
            urls.append(_media_url(UUID(str(raw))))
        except (ValueError, AttributeError):
            continue
    return urls


@router.post("/jobs", response_model=JobCreated, status_code=status.HTTP_202_ACCEPTED)
async def submit_job(
    request: Request,
    # Cap raised to 2000 — cinematic presets + QUALITY_SUFFIX routinely land
    # around 680 chars, previously blocked by the old 500 cap.
    prompt: Annotated[str, Form(min_length=3, max_length=2000)],
    motion_preset: Annotated[str, Form()],
    token_symbol: Annotated[str, Form(pattern=r"^[A-Z0-9]{2,12}$")],
    turnstile_token: Annotated[str, Form()],
    session: Annotated[AsyncSession, SessionDep],
    wallet_session: Annotated[WalletSession | None, OptionalWalletDep],
    seed: Annotated[int | None, Form()] = None,
    duration_sec: Annotated[int | None, Form(ge=1, le=10)] = None,
    num_variants: Annotated[int | None, Form(ge=1, le=4)] = None,
    input_image: Annotated[UploadFile | None, File()] = None,
) -> JobCreated:
    settings = get_settings()
    ip = client_ip(request)

    if motion_preset not in MOTION_PRESETS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unknown motion preset")

    cleaned_prompt = safety.normalize_prompt(prompt)
    if not safety.is_prompt_safe(cleaned_prompt):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "prompt rejected")

    if not await verify_turnstile(turnstile_token, remote_ip=ip):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "turnstile verification failed")

    # Resolve tier (anonymous traffic is implicit FREE)
    if wallet_session is not None:
        tier_info = await get_tier_for_wallet(wallet_session.wallet)
    else:
        tier_info = ANON_TIER

    # IP-window throttle still applies as a coarse anti-abuse net
    allowed, current = await check_and_increment(session, ip)
    if not allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"hourly limit reached ({current}/{settings.rate_limit_per_hour})",
        )

    # Wallet-scoped daily quota (only meaningful when authenticated)
    quota_state_used = 0
    quota_state_limit = quota_limit_for_tier(tier_info.tier)
    if wallet_session is not None:
        quota_state = await daily_quota_state(
            session, wallet=wallet_session.wallet, tier=tier_info.tier
        )
        quota_state_used = quota_state.used
        quota_state_limit = quota_state.limit
        if quota_state.exceeded:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                f"daily {tier_info.tier.value} quota reached "
                f"({quota_state.used}/{quota_state.limit})",
            )

    input_media_id: UUID | None = None
    if input_image is not None:
        data = await input_image.read()
        if len(data) > settings.max_input_bytes:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "image too large")
        try:
            fmt, _, _ = safety.validate_image_bytes(data)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        input_media_id, rel, sha = storage.write_media(data, image_format=fmt)
        session.add(
            Media(
                id=input_media_id,
                relative_path=rel,
                content_type=f"image/{fmt.lower()}",
                sha256=sha,
                size_bytes=len(data),
                role="input",
                safety_passed=True,
            )
        )

    job = Job(
        id=uuid4(),
        status=JobStatus.QUEUED,
        prompt={
            "text": cleaned_prompt,
            "motion_preset": motion_preset,
            "token_symbol": token_symbol,
            "seed": seed,
        },
        input_media_id=input_media_id,
        ip_hash=hash_ip(ip),
        wallet_address=wallet_session.wallet if wallet_session else None,
        tier=tier_info.tier.value,
        duration_sec=duration_sec or settings.video_duration_sec,
        num_variants=num_variants or settings.video_variants,
        extra_output_media_ids=[],
    )
    session.add(job)
    await session.commit()

    pos = await queue_position(session, job.id)
    log.info(
        "job_submitted",
        job_id=str(job.id),
        queue_position=pos,
        motion=motion_preset,
        tier=tier_info.tier.value,
        wallet=wallet_session.wallet if wallet_session else None,
    )
    return JobCreated(
        job_id=job.id,
        queue_position=max(pos, 1),
        tier=tier_info.tier.value,
        quota_used=quota_state_used + 1 if wallet_session else None,
        quota_limit=quota_state_limit if wallet_session else None,
    )


@router.get("/jobs/{job_id}", response_model=JobStatusOut)
async def get_job(
    job_id: UUID,
    session: Annotated[AsyncSession, SessionDep],
    wallet_session: Annotated[WalletSession | None, OptionalWalletDep],
) -> JobStatusOut:
    job = await session.get(Job, job_id)
    if job is None or job.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")

    # IDOR guard: if job belongs to a wallet, only that wallet can read it.
    # Anon jobs (wallet_address IS NULL) remain readable by anyone who holds
    # the unguessable UUID (required for anon poll of a just-submitted job).
    if job.wallet_address:
        owner = job.wallet_address.lower()
        if wallet_session is None or wallet_session.wallet.lower() != owner:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")

    media_urls = _all_media_urls(job)
    return JobStatusOut(
        job_id=job.id,
        status=job.status.value,
        media_url=media_urls[0] if media_urls else None,
        media_id=job.output_media_id,
        media_urls=media_urls,
        error_text=job.error_text,
        duration_ms=job.duration_ms,
        created_at=job.created_at,
        completed_at=job.completed_at,
    )


@router.delete("/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_job(
    job_id: UUID,
    session: Annotated[AsyncSession, SessionDep],
    wallet_session: Annotated[WalletSession, RequiredWalletDep],
) -> Response:
    job = await session.get(Job, job_id)
    if job is None or job.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
    if (job.wallet_address or "").lower() != wallet_session.wallet:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not your job")
    job.deleted_at = datetime.now(UTC)
    await session.commit()
    log.info("job_deleted", job_id=str(job.id), wallet=wallet_session.wallet)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/history", response_model=HistoryOut)
async def history(
    session: Annotated[AsyncSession, SessionDep],
    wallet_session: Annotated[WalletSession, RequiredWalletDep],
    limit: Annotated[int, Query(ge=1, le=100)] = 24,
    before: Annotated[datetime | None, Query()] = None,
) -> HistoryOut:
    stmt = (
        select(Job)
        .where(
            Job.wallet_address == wallet_session.wallet,
            Job.deleted_at.is_(None),
        )
        .order_by(desc(Job.created_at))
        .limit(limit + 1)
    )
    if before is not None:
        stmt = stmt.where(Job.created_at < before)
    rows = (await session.execute(stmt)).scalars().all()

    has_more = len(rows) > limit
    rows = rows[:limit]

    items: list[HistoryItem] = []
    for job in rows:
        media_urls = _all_media_urls(job)
        prompt_text = ""
        motion = ""
        token_sym = ""
        if isinstance(job.prompt, dict):
            prompt_text = str(job.prompt.get("text", ""))
            motion = str(job.prompt.get("motion_preset", ""))
            token_sym = str(job.prompt.get("token_symbol", ""))
        items.append(
            HistoryItem(
                job_id=job.id,
                status=job.status.value,
                prompt_text=prompt_text,
                motion_preset=motion,
                token_symbol=token_sym,
                media_url=media_urls[0] if media_urls else None,
                media_urls=media_urls,
                duration_ms=job.duration_ms,
                created_at=job.created_at,
                completed_at=job.completed_at,
            )
        )

    tier_info = await get_tier_for_wallet(wallet_session.wallet)
    quota_state = await daily_quota_state(
        session, wallet=wallet_session.wallet, tier=tier_info.tier
    )
    next_cursor = items[-1].created_at.isoformat() if (items and has_more) else None
    return HistoryOut(
        items=items,
        next_cursor=next_cursor,
        quota_used=quota_state.used,
        quota_limit=quota_state.limit,
        tier=tier_info.tier.value,
    )


@router.get("/me", response_model=TierStatusOut)
async def me(
    session: Annotated[AsyncSession, SessionDep],
    wallet_session: Annotated[WalletSession, RequiredWalletDep],
) -> TierStatusOut:
    tier_info = await get_tier_for_wallet(wallet_session.wallet)
    quota_state = await daily_quota_state(
        session, wallet=wallet_session.wallet, tier=tier_info.tier
    )
    return TierStatusOut(
        wallet=wallet_session.wallet,
        tier=tier_info.tier.value,
        source=tier_info.source,
        quota_used=quota_state.used,
        quota_limit=quota_state.limit,
    )


@router.get("/media/{media_id}")
async def get_media(
    media_id: UUID,
    request: Request,
    session: Annotated[AsyncSession, SessionDep],
    exp: Annotated[int | None, Query(ge=0)] = None,
    sig: Annotated[
        str | None, Query(min_length=32, max_length=32, pattern=r"^[a-f0-9]{32}$")
    ] = None,
) -> Response:
    media = await session.get(Media, media_id)
    if media is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "media not found")

    # Accept either a valid signed URL (exp+sig) or a worker Bearer token.
    # Signed URLs are the primary channel — emitted for every media_url in API
    # responses — so native <video> tags stream without any header trick.
    # Worker Bearer stays as a zero-trust fallback for internal calls.
    authorized = False
    if exp is not None and sig is not None and _verify_media_sig(media_id, exp=exp, sig=sig):
        authorized = True
    if not authorized:
        auth_header = request.headers.get("authorization") or ""
        if auth_header.lower().startswith("bearer "):
            presented = auth_header.split(" ", 1)[1].strip()
            expected = get_settings().worker_token.get_secret_value()
            if hmac.compare_digest(presented, expected):
                authorized = True
    if not authorized:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "media not found")

    try:
        data = storage.read_media(media.relative_path)
    except (FileNotFoundError, PermissionError) as exc:
        log.exception("media_read_failed", media_id=str(media_id))
        raise HTTPException(status.HTTP_404_NOT_FOUND, "media not found") from exc
    return Response(
        content=data,
        media_type=media.content_type,
        headers={
            "Cache-Control": "public, max-age=86400, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )
