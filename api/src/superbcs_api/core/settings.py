"""Runtime configuration. All values come from environment / .env, never hard-coded."""

from __future__ import annotations

from functools import lru_cache
from ipaddress import ip_network
from pathlib import Path
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="SUPERBCS_",
        case_sensitive=False,
        extra="ignore",
    )

    env: Literal["production", "staging", "dev"] = "production"
    debug: bool = False

    db_dsn: SecretStr
    media_dir: Path = Path("./data/media")
    log_dir: Path = Path("./logs")

    bind_host: str = "127.0.0.1"
    bind_port: int = 8210
    public_base_url: str

    rate_limit_per_hour: int = 5
    max_input_bytes: int = 8 * 1024 * 1024
    job_timeout_seconds: int = 180

    worker_token: SecretStr
    worker_ip_allowlist: str = ""

    # Forwarded-header trust. When False (default) the API never reads
    # CF-Connecting-IP / X-Forwarded-For — it uses the direct TCP peer.
    # Enable only behind a reverse proxy you control, and list the proxy's
    # source IPs in `trusted_proxy_cidrs`. Without both, a direct client
    # could forge a header and bypass IP rate limiting + worker allowlist.
    trust_forwarded_headers: bool = False
    trusted_proxy_cidrs: str = ""

    # Dedicated HMAC key for signed /v/{uuid} media URLs. Kept separate from
    # worker_token so a leak of one does not compromise the other. Required
    # in production; dev/staging may leave it empty to fall back to
    # worker_token for local-run convenience.
    media_signing_key: SecretStr = SecretStr("")

    @property
    def media_hmac_key(self) -> bytes:
        key = self.media_signing_key.get_secret_value()
        if not key:
            if self.env == "production":
                raise RuntimeError(
                    "SUPERBCS_MEDIA_SIGNING_KEY is required in production. "
                    "Generate a dedicated key (e.g. `openssl rand -hex 32`); "
                    "do not reuse worker_token."
                )
            key = self.worker_token.get_secret_value()
        return key.encode()

    turnstile_site_key: str = ""
    turnstile_secret: SecretStr = SecretStr("")

    request_id_header: str = "X-Request-ID"
    cors_origins: str = ""

    # MEFAI panel integration (HTTP passthrough; no shared secret needed)
    panel_base_url: str = "http://127.0.0.1:8000"
    panel_request_timeout_sec: float = 5.0
    panel_cache_ttl_sec: int = 300

    # Tier-aware daily quotas (jobs / 24h)
    quota_free_per_day: int = 1
    quota_pro_per_day: int = 5
    quota_prime_per_day: int = 15

    # Video generation defaults
    video_duration_sec: int = 3
    video_variants: int = 2

    @field_validator("worker_ip_allowlist", "trusted_proxy_cidrs")
    @classmethod
    def _validate_cidrs(cls, value: str) -> str:
        if not value:
            return value
        for entry in (e.strip() for e in value.split(",") if e.strip()):
            ip_network(entry, strict=False)
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def worker_allow_cidrs(self) -> list[str]:
        return [c.strip() for c in self.worker_ip_allowlist.split(",") if c.strip()]

    @property
    def trusted_proxy_cidr_list(self) -> list[str]:
        return [c.strip() for c in self.trusted_proxy_cidrs.split(",") if c.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
