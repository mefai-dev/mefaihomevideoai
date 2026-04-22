"""DB-backed per-IP rate limit. Hourly buckets keyed by sha256(ip)."""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from superbcs_api.core.settings import get_settings
from superbcs_api.db.models import RateLimitBucket


def hash_ip(ip: str) -> str:
    """Salt with worker_token so DB leak alone can't reverse the IP via rainbow."""
    salt = get_settings().worker_token.get_secret_value().encode()
    return hmac.new(salt, ip.encode(), hashlib.sha256).hexdigest()


def _hour_window(now: datetime | None = None) -> datetime:
    n = (now or datetime.now(UTC)).replace(minute=0, second=0, microsecond=0)
    return n


async def check_and_increment(session: AsyncSession, ip: str) -> tuple[bool, int]:
    """Returns (allowed, current_count). Atomic upsert."""
    settings = get_settings()
    if settings.rate_limit_per_hour <= 0:
        return True, 0

    ip_h = hash_ip(ip)
    window = _hour_window()

    stmt = (
        pg_insert(RateLimitBucket)
        .values(ip_hash=ip_h, window_start=window, count=1)
        .on_conflict_do_update(
            index_elements=["ip_hash", "window_start"],
            set_={"count": RateLimitBucket.count + 1},
        )
        .returning(RateLimitBucket.count)
    )
    result = await session.execute(stmt)
    current = int(result.scalar_one())
    allowed = current <= settings.rate_limit_per_hour
    return allowed, current
