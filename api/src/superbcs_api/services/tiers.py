"""Tier resolution from the existing MEFAI panel.

Maps the panel's `access_level` (`public | starter | pro | prime`) onto
SUPER BCS tiers. Cached briefly so a busy submit endpoint does not
hammer the panel for every request.
"""

from __future__ import annotations

import asyncio
import enum
import time
from dataclasses import dataclass

import httpx

from superbcs_api.core.logging import get_logger, redact_wallet
from superbcs_api.core.settings import get_settings

log = get_logger(__name__)


class Tier(str, enum.Enum):
    FREE = "free"
    PRO = "pro"
    PRIME = "prime"


@dataclass(frozen=True, slots=True)
class TierInfo:
    tier: Tier
    source: str  # purchased | token_holding | default | anonymous


_PANEL_TO_TIER: dict[str, Tier] = {
    "public": Tier.FREE,
    "starter": Tier.FREE,
    "pro": Tier.PRO,
    "prime": Tier.PRIME,
}

_HTTP_OK = 200
_CACHE_MAX_ENTRIES = 10_000

_cache: dict[str, tuple[float, TierInfo]] = {}
_cache_lock = asyncio.Lock()


def _now() -> float:
    return time.monotonic()


ANON_TIER = TierInfo(tier=Tier.FREE, source="anonymous")


async def get_tier_for_wallet(wallet: str) -> TierInfo:
    """Return the SUPER BCS tier for the given wallet.

    Wallet must be a lowercased 0x-prefixed address. On any panel error
    we fall back to FREE so users can still submit at the lowest quota
    rather than being locked out by a transient downstream issue.
    """
    settings = get_settings()
    wallet_key = wallet.lower()
    cache_ttl = float(settings.panel_cache_ttl_sec)

    async with _cache_lock:
        cached = _cache.get(wallet_key)
        if cached is not None:
            expires_at, info = cached
            if expires_at > _now():
                return info
            _cache.pop(wallet_key, None)

    url = f"{settings.panel_base_url.rstrip('/')}/permissions/check/{wallet_key}"
    try:
        async with httpx.AsyncClient(timeout=settings.panel_request_timeout_sec) as client:
            resp = await client.get(url)
    except httpx.HTTPError as exc:
        log.warning("panel_tier_network_error", error=str(exc), wallet=redact_wallet(wallet_key))
        return TierInfo(tier=Tier.FREE, source="default")

    if resp.status_code != _HTTP_OK:
        log.info("panel_tier_non_200", status=resp.status_code, wallet=redact_wallet(wallet_key))
        return TierInfo(tier=Tier.FREE, source="default")

    try:
        body = resp.json()
    except ValueError:
        return TierInfo(tier=Tier.FREE, source="default")

    if not isinstance(body, dict):
        return TierInfo(tier=Tier.FREE, source="default")

    raw_level = str(body.get("access_level", "public")).lower()
    raw_source = str(body.get("source", "default"))
    tier = _PANEL_TO_TIER.get(raw_level, Tier.FREE)
    info = TierInfo(tier=tier, source=raw_source)

    async with _cache_lock:
        _cache[wallet_key] = (_now() + cache_ttl, info)
        if len(_cache) > _CACHE_MAX_ENTRIES:
            for stale in [k for k, (exp, _) in _cache.items() if exp <= _now()]:
                _cache.pop(stale, None)
    return info


def _testing_clear_cache() -> None:
    _cache.clear()
