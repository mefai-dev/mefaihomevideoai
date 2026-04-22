"""Auth, IP allowlisting, Turnstile verification. Constant-time comparisons."""

from __future__ import annotations

import hmac
from ipaddress import ip_address, ip_network

import httpx
from fastapi import Header, HTTPException, Request, status

from superbcs_api.core.logging import get_logger
from superbcs_api.core.settings import Settings, get_settings

log = get_logger(__name__)

_TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def client_ip(request: Request) -> str:
    """Resolve trusted client IP.

    Prefers `CF-Connecting-IP` (Cloudflare-set, cannot be forged by the
    caller when traffic comes through CF edge). Falls back to the first
    entry of X-Forwarded-For (nginx-trusted), then to the raw socket
    address. This ordering prevents IP-allowlist bypass via a forged
    X-Forwarded-For header.
    """
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client is None:
        return "0.0.0.0"  # noqa: S104 — sentinel only, never bound to.
    return request.client.host


def require_worker_bearer(
    request: Request,
    authorization: str | None = Header(default=None),
) -> None:
    settings = get_settings()
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    presented = authorization.split(" ", 1)[1].strip()
    expected = settings.worker_token.get_secret_value()
    if not hmac.compare_digest(presented, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid bearer token")
    _enforce_ip_allowlist(client_ip(request), settings)


def _enforce_ip_allowlist(ip: str, settings: Settings) -> None:
    cidrs = settings.worker_allow_cidrs
    if not cidrs:
        return
    addr = ip_address(ip)
    for cidr in cidrs:
        if addr in ip_network(cidr, strict=False):
            return
    log.warning("worker_ip_blocked", ip=ip)
    raise HTTPException(status.HTTP_403_FORBIDDEN, "worker ip not allowed")


async def verify_turnstile(token: str, *, remote_ip: str) -> bool:
    settings = get_settings()
    secret = settings.turnstile_secret.get_secret_value()
    if not secret:
        # Turnstile disabled (dev only). Production requires a key.
        if settings.env == "production":
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "turnstile not configured",
            )
        return True
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                _TURNSTILE_VERIFY_URL,
                data={"secret": secret, "response": token, "remoteip": remote_ip},
            )
        payload = resp.json()
    except httpx.HTTPError:
        log.exception("turnstile_request_failed")
        return False
    if not bool(payload.get("success")):
        log.info("turnstile_failed", codes=payload.get("error-codes"))
        return False
    return True
