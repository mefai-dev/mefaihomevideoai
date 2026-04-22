"""Worker auth tests — require_worker_bearer + IP allowlist enforcement."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import SecretStr

from superbcs_api.core.security import _enforce_ip_allowlist, client_ip, require_worker_bearer
from superbcs_api.core.settings import Settings, get_settings


def _fake_request(
    *, cf_ip: str | None = None, xff: str | None = None, client_host: str = "127.0.0.1"
) -> MagicMock:
    req = MagicMock()
    headers: dict[str, str] = {}
    if cf_ip is not None:
        headers["cf-connecting-ip"] = cf_ip
    if xff is not None:
        headers["x-forwarded-for"] = xff
    req.headers = headers
    req.client = MagicMock()
    req.client.host = client_host
    return req


def test_client_ip_prefers_cf_connecting_ip() -> None:
    req = _fake_request(cf_ip="1.2.3.4", xff="9.9.9.9, 8.8.8.8", client_host="10.0.0.1")
    assert client_ip(req) == "1.2.3.4"


def test_client_ip_falls_back_to_first_xff() -> None:
    req = _fake_request(xff="9.9.9.9, 8.8.8.8", client_host="10.0.0.1")
    assert client_ip(req) == "9.9.9.9"


def test_client_ip_falls_back_to_socket() -> None:
    req = _fake_request(client_host="10.0.0.1")
    assert client_ip(req) == "10.0.0.1"


def test_client_ip_handles_missing_client() -> None:
    req = _fake_request()
    req.client = None
    assert client_ip(req) == "0.0.0.0"


def test_bearer_missing_raises_401() -> None:
    req = _fake_request()
    with pytest.raises(HTTPException) as exc:
        require_worker_bearer(req, authorization=None)
    assert exc.value.status_code == 401
    assert "missing" in str(exc.value.detail).lower()


def test_bearer_wrong_scheme_raises_401() -> None:
    req = _fake_request()
    with pytest.raises(HTTPException) as exc:
        require_worker_bearer(req, authorization="Basic abcdef")
    assert exc.value.status_code == 401


def test_bearer_wrong_token_raises_401() -> None:
    req = _fake_request()
    with pytest.raises(HTTPException) as exc:
        require_worker_bearer(req, authorization="Bearer wrong-token")
    assert exc.value.status_code == 401
    assert "invalid" in str(exc.value.detail).lower()


def test_bearer_correct_token_passes() -> None:
    req = _fake_request()
    token = get_settings().worker_token.get_secret_value()
    # No allowlist configured → should return None (success)
    require_worker_bearer(req, authorization=f"Bearer {token}")


def test_bearer_uses_constant_time_comparison() -> None:
    """Flip a single char — must still fail with 401."""
    req = _fake_request()
    token = get_settings().worker_token.get_secret_value()
    mutated = "X" + token[1:]
    with pytest.raises(HTTPException) as exc:
        require_worker_bearer(req, authorization=f"Bearer {mutated}")
    assert exc.value.status_code == 401


def test_allowlist_empty_permits_all() -> None:
    settings = get_settings()
    _enforce_ip_allowlist("203.0.113.1", settings)  # no raise


def test_allowlist_blocks_outside_cidr() -> None:
    base = get_settings()
    s = Settings(
        db_dsn=base.db_dsn,
        worker_token=base.worker_token,
        public_base_url=base.public_base_url,
        env=base.env,
        worker_ip_allowlist="10.0.0.0/8",
    )
    with pytest.raises(HTTPException) as exc:
        _enforce_ip_allowlist("203.0.113.1", s)
    assert exc.value.status_code == 403


def test_allowlist_permits_inside_cidr() -> None:
    base = get_settings()
    s = Settings(
        db_dsn=base.db_dsn,
        worker_token=base.worker_token,
        public_base_url=base.public_base_url,
        env=base.env,
        worker_ip_allowlist="10.0.0.0/8,172.16.0.0/12",
    )
    _enforce_ip_allowlist("10.5.6.7", s)
    _enforce_ip_allowlist("172.16.1.1", s)


def test_bearer_with_allowlist_blocks_outside_ip() -> None:
    """Integration-ish: full require_worker_bearer path with allowlist."""
    base = get_settings()
    restricted = Settings(
        db_dsn=base.db_dsn,
        worker_token=base.worker_token,
        public_base_url=base.public_base_url,
        env=base.env,
        worker_ip_allowlist="10.0.0.0/8",
    )
    req = _fake_request(cf_ip="203.0.113.1")
    token = restricted.worker_token.get_secret_value()
    with (
        patch("superbcs_api.core.security.get_settings", return_value=restricted),
        pytest.raises(HTTPException) as exc,
    ):
        require_worker_bearer(req, authorization=f"Bearer {token}")
    assert exc.value.status_code == 403


def test_turnstile_disabled_in_dev_returns_true() -> None:
    """When secret is empty and env=dev, verify_turnstile returns True
    without hitting Cloudflare.
    """
    import asyncio

    from superbcs_api.core.security import verify_turnstile

    base = get_settings()
    dev = Settings(
        db_dsn=base.db_dsn,
        worker_token=base.worker_token,
        public_base_url=base.public_base_url,
        env="dev",
        turnstile_secret=SecretStr(""),
    )
    with patch("superbcs_api.core.security.get_settings", return_value=dev):
        assert asyncio.run(verify_turnstile("any", remote_ip="1.1.1.1")) is True
