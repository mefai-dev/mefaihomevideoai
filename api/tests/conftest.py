"""Shared test fixtures.

Sets minimal environment variables required for Settings() to instantiate
(Settings has required fields db_dsn / worker_token / public_base_url). All
values are fake and never used outside of unit tests since the tests avoid
touching the real DB / network.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPERBCS_DB_DSN", "postgresql+asyncpg://test:test@127.0.0.1/test")
os.environ.setdefault("SUPERBCS_WORKER_TOKEN", "worker-test-token-0123456789")
os.environ.setdefault("SUPERBCS_PUBLIC_BASE_URL", "https://api.example.com")
os.environ.setdefault("SUPERBCS_ENV", "dev")
os.environ.setdefault("SUPERBCS_TURNSTILE_SECRET", "")
# Overwrite any allowlist that the real deployment .env might set,
# so tests default to "no allowlist = permit all".
os.environ["SUPERBCS_WORKER_IP_ALLOWLIST"] = ""

from superbcs_api.core.settings import get_settings

# Warm + clear LRU cache so each test module sees fresh Settings
get_settings.cache_clear()
