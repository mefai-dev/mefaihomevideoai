"""HMAC media signing tests — validate sign/verify, TTL expiry, tamper
detection, and the dual-key transitional verify path that keeps URLs
signed with the old worker_token valid after the media_signing_key rollout.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime
from unittest.mock import patch
from uuid import uuid4

import pytest
from pydantic import SecretStr

from superbcs_api.api.public import _MEDIA_SIG_LABEL, _sign_media, _verify_media_sig
from superbcs_api.core.settings import Settings, get_settings


def _future_exp(delta_seconds: int = 3600) -> int:
    return int(datetime.now(UTC).timestamp()) + delta_seconds


def test_sign_verify_roundtrip() -> None:
    mid = uuid4()
    exp = _future_exp()
    sig = _sign_media(mid, exp=exp)
    assert len(sig) == 32
    assert all(c in "0123456789abcdef" for c in sig)
    assert _verify_media_sig(mid, exp=exp, sig=sig) is True


def test_sign_is_deterministic() -> None:
    mid = uuid4()
    exp = _future_exp()
    assert _sign_media(mid, exp=exp) == _sign_media(mid, exp=exp)


def test_verify_rejects_expired() -> None:
    mid = uuid4()
    exp = int(datetime.now(UTC).timestamp()) - 1
    sig = _sign_media(mid, exp=exp)
    assert _verify_media_sig(mid, exp=exp, sig=sig) is False


def test_verify_rejects_tampered_media_id() -> None:
    mid_a = uuid4()
    mid_b = uuid4()
    exp = _future_exp()
    sig = _sign_media(mid_a, exp=exp)
    assert _verify_media_sig(mid_b, exp=exp, sig=sig) is False


def test_verify_rejects_tampered_exp() -> None:
    mid = uuid4()
    exp = _future_exp()
    sig = _sign_media(mid, exp=exp)
    assert _verify_media_sig(mid, exp=exp + 1, sig=sig) is False


def test_verify_rejects_wrong_sig() -> None:
    mid = uuid4()
    exp = _future_exp()
    assert _verify_media_sig(mid, exp=exp, sig="0" * 32) is False


def test_dual_key_verify_legacy_worker_token() -> None:
    """A URL signed with the old worker_token (before key split) must still
    verify while media_signing_key is set to a different value.
    """
    settings = get_settings()
    # Build a "legacy" sig using worker_token directly
    mid = uuid4()
    exp = _future_exp()
    legacy_key = settings.worker_token.get_secret_value().encode()
    msg = _MEDIA_SIG_LABEL + b":" + str(mid).encode() + b":" + str(exp).encode()
    legacy_sig = hmac.new(legacy_key, msg, hashlib.sha256).hexdigest()[:32]

    # Simulate rollout: override media_signing_key to something distinct
    new_key = SecretStr("brand-new-media-key-xyz")
    test_settings = Settings(
        db_dsn=settings.db_dsn,
        worker_token=settings.worker_token,
        public_base_url=settings.public_base_url,
        env=settings.env,
        media_signing_key=new_key,
    )
    with patch("superbcs_api.api.public.get_settings", return_value=test_settings):
        # Current-key signed URL: valid
        assert _verify_media_sig(mid, exp=exp, sig=_sign_media(mid, exp=exp)) is True
        # Legacy worker_token-signed URL: also valid (transitional)
        assert _verify_media_sig(mid, exp=exp, sig=legacy_sig) is True


def test_dual_key_verify_rejects_completely_unknown_key() -> None:
    mid = uuid4()
    exp = _future_exp()
    bogus_key = b"attacker-guess"
    msg = _MEDIA_SIG_LABEL + b":" + str(mid).encode() + b":" + str(exp).encode()
    bogus_sig = hmac.new(bogus_key, msg, hashlib.sha256).hexdigest()[:32]
    assert _verify_media_sig(mid, exp=exp, sig=bogus_sig) is False


@pytest.mark.parametrize("bad_sig", ["", "zz", "g" * 32, "a" * 31, "a" * 33])
def test_verify_rejects_malformed_sig(bad_sig: str) -> None:
    mid = uuid4()
    exp = _future_exp()
    assert _verify_media_sig(mid, exp=exp, sig=bad_sig) is False
