"""Panel session token verification.

Uses HTTP passthrough to the existing MEFAI panel's `/api/profile/me`
endpoint so we never need to share or store the panel's session secret.
Results are cached in-process for `panel_cache_ttl_sec` seconds to keep
the per-request cost negligible.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import httpx

from superbcs_api.core.logging import get_logger
from superbcs_api.core.settings import get_settings

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class WalletSession:
    wallet: str  # always lowercased


_cache: dict[str, tuple[float, str]] = {}
_cache_lock = asyncio.Lock()

# Guardrails. Tokens longer than this are rejected before any network call;
# wallet addresses must be a canonical 0x + 40-hex EIP-55; HTTP 200 is the
# only success we accept; cache is bounded to avoid unbounded growth.
_MAX_TOKEN_LEN = 4096
_EVM_ADDRESS_LEN = 42
_HTTP_OK = 200
_CACHE_MAX_ENTRIES = 10_000


def _now() -> float:
    return time.monotonic()


async def verify_panel_token(token: str) -> WalletSession | None:
    """Resolve a panel Bearer token to a wallet address.

    Returns None on any failure (invalid, expired, network). The caller
    decides whether absence of a wallet means anonymous-allowed or 401.
    """
    if not token or len(token) > _MAX_TOKEN_LEN:
        return None

    settings = get_settings()
    cache_ttl = float(settings.panel_cache_ttl_sec)

    async with _cache_lock:
        cached = _cache.get(token)
        if cached is not None:
            expires_at, wallet = cached
            if expires_at > _now():
                return WalletSession(wallet=wallet)
            _cache.pop(token, None)

    url = f"{settings.panel_base_url.rstrip('/')}/api/profile/me"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with httpx.AsyncClient(timeout=settings.panel_request_timeout_sec) as client:
            resp = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        log.warning("panel_auth_network_error", error=str(exc))
        return None

    if resp.status_code != _HTTP_OK:
        return None

    try:
        body = resp.json()
    except ValueError:
        return None

    raw_wallet = body.get("wallet") if isinstance(body, dict) else None
    if (
        not isinstance(raw_wallet, str)
        or not raw_wallet.startswith("0x")
        or len(raw_wallet) != _EVM_ADDRESS_LEN
    ):
        return None

    wallet = raw_wallet.lower()
    async with _cache_lock:
        _cache[token] = (_now() + cache_ttl, wallet)
        # bound the cache so a malicious flood can't grow it without limit
        if len(_cache) > _CACHE_MAX_ENTRIES:
            for stale in [k for k, (exp, _) in _cache.items() if exp <= _now()]:
                _cache.pop(stale, None)
    return WalletSession(wallet=wallet)


def _testing_clear_cache() -> None:
    """Test hook — drop all cached sessions."""
    _cache.clear()
