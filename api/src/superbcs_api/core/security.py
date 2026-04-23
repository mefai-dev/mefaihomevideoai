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

    Forwarded headers (`CF-Connecting-IP`, `X-Forwarded-For`) are only trusted
    when `SUPERBCS_TRUST_FORWARDED_HEADERS=true` is explicitly set AND the
    direct TCP peer is inside `SUPERBCS_TRUSTED_PROXY_CIDRS`. This fails
    closed: if the API is reachable directly (no reverse proxy in front),
    a forged `CF-Connecting-IP` cannot bypass IP-based rate limiting or the
    worker CIDR allowlist.
    """
    settings = get_settings()
    peer = request.client.host if request.client is not None else None

    if settings.trust_forwarded_headers and peer and _peer_is_trusted(peer, settings):
        cf = request.headers.get("cf-connecting-ip")
        if cf:
            return cf.strip()
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()

    if peer is None:
        return "0.0.0.0"  # noqa: S104 — sentinel only, never bound to.
    return peer


def _peer_is_trusted(peer: str, settings: Settings) -> bool:
    cidrs = settings.trusted_proxy_cidr_list
    if not cidrs:
        return False
    try:
        addr = ip_address(peer)
    except ValueError:
        return False
    for cidr in cidrs:
        try:
            if addr in ip_network(cidr, strict=False):
                return True
        except ValueError:
            continue
    return False


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
