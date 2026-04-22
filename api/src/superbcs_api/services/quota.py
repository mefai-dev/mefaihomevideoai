"""Tier-aware daily quota for image / video submissions.

For authenticated users we count jobs on `wallet_address` over the last
24h. For anonymous traffic the existing IP-window rate limiter
(`services.rate_limit`) is the cap, so this module is a no-op.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from superbcs_api.core.settings import get_settings
from superbcs_api.db.models import Job
from superbcs_api.services.tiers import Tier


@dataclass(frozen=True, slots=True)
class QuotaState:
    used: int
    limit: int

    @property
    def remaining(self) -> int:
        return max(self.limit - self.used, 0)

    @property
    def exceeded(self) -> bool:
        return self.used >= self.limit


def quota_limit_for_tier(tier: Tier) -> int:
    settings = get_settings()
    if tier is Tier.PRIME:
        return settings.quota_prime_per_day
    if tier is Tier.PRO:
        return settings.quota_pro_per_day
    return settings.quota_free_per_day


async def daily_quota_state(
    session: AsyncSession,
    *,
    wallet: str,
    tier: Tier,
) -> QuotaState:
    """Count this wallet's jobs in the last 24h."""
    cutoff = datetime.now(UTC) - timedelta(hours=24)
    stmt = select(func.count()).where(
        Job.wallet_address == wallet.lower(),
        Job.created_at >= cutoff,
    )
    used = int((await session.execute(stmt)).scalar_one())
    return QuotaState(used=used, limit=quota_limit_for_tier(tier))
