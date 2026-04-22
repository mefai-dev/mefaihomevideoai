"""Integration-test fixtures backed by a disposable Postgres.

Spins up a real Postgres via `testcontainers`, rebinds the app's async
engine to that container (with `NullPool` so no connection is shared
across pytest-asyncio event loops), creates the schema from the ORM
metadata, and exposes an async httpx client with FastAPI dependency
overrides for the auth deps. Module is skipped cleanly if Docker is
unavailable.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest

try:
    from testcontainers.postgres import PostgresContainer
except Exception:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment,misc]


def _docker_ready() -> bool:
    import shutil
    import subprocess

    if not shutil.which("docker"):
        return False
    try:
        r = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        return r.returncode == 0
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    PostgresContainer is None or not _docker_ready(),
    reason="docker / testcontainers not available",
)


@pytest.fixture(scope="session")
def _pg_container() -> Iterator[Any]:
    assert PostgresContainer is not None
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture(scope="session")
def _async_dsn(_pg_container: Any) -> str:
    sync_url = _pg_container.get_connection_url()
    return sync_url.replace("postgresql+psycopg2", "postgresql+asyncpg").replace(
        "postgresql://", "postgresql+asyncpg://"
    )


@pytest.fixture(scope="session")
def _schema_ready(_async_dsn: str) -> bool:
    """Create the schema once per session on a throwaway engine."""
    from sqlalchemy.ext.asyncio import create_async_engine

    from superbcs_api.db.models import Base

    async def _run() -> None:
        eng = create_async_engine(_async_dsn)
        try:
            async with eng.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
        finally:
            await eng.dispose()

    asyncio.run(_run())
    return True


@pytest.fixture
async def session_factory(_async_dsn: str, _schema_ready: bool) -> AsyncIterator[Any]:
    """Per-test engine + session factory, bound to the running test loop.

    NullPool guarantees we never reuse connections across event loops.
    """
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from superbcs_api.db import session as db_session

    engine = create_async_engine(_async_dsn, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    # Rebind the app's module-level factory so the real dep yields from us.
    prev_engine = db_session._engine  # type: ignore[attr-defined]
    prev_factory = db_session._session_factory  # type: ignore[attr-defined]
    db_session._engine = engine  # type: ignore[attr-defined]
    db_session._session_factory = factory  # type: ignore[attr-defined]

    try:
        yield factory
    finally:
        db_session._engine = prev_engine  # type: ignore[attr-defined]
        db_session._session_factory = prev_factory  # type: ignore[attr-defined]
        await engine.dispose()


@pytest.fixture
async def seeded_jobs(session_factory: Any) -> AsyncIterator[dict[str, Any]]:
    """Insert an alice-owned, bob-owned, and anonymous job into the DB."""
    from uuid import uuid4

    from sqlalchemy import delete

    from superbcs_api.db.models import Job, JobStatus

    alice = "0x" + "a" * 40
    bob = "0x" + "b" * 40

    alice_job = Job(
        id=uuid4(),
        status=JobStatus.DONE,
        prompt={"text": "alice test", "motion_preset": "cinematic", "token_symbol": "BTC"},
        ip_hash="a" * 64,
        wallet_address=alice,
        tier="free",
        duration_sec=3,
        num_variants=2,
        extra_output_media_ids=[],
    )
    bob_job = Job(
        id=uuid4(),
        status=JobStatus.DONE,
        prompt={"text": "bob test", "motion_preset": "cinematic", "token_symbol": "ETH"},
        ip_hash="b" * 64,
        wallet_address=bob,
        tier="free",
        duration_sec=3,
        num_variants=2,
        extra_output_media_ids=[],
    )
    anon_job = Job(
        id=uuid4(),
        status=JobStatus.DONE,
        prompt={"text": "anon test", "motion_preset": "cinematic", "token_symbol": "SOL"},
        ip_hash="c" * 64,
        wallet_address=None,
        tier="free",
        duration_sec=3,
        num_variants=2,
        extra_output_media_ids=[],
    )
    async with session_factory() as s:
        s.add_all([alice_job, bob_job, anon_job])
        await s.commit()
        ids = {
            "alice_wallet": alice,
            "bob_wallet": bob,
            "alice_job_id": str(alice_job.id),
            "bob_job_id": str(bob_job.id),
            "anon_job_id": str(anon_job.id),
        }
    yield ids

    async with session_factory() as s:
        for jid in (ids["alice_job_id"], ids["bob_job_id"], ids["anon_job_id"]):
            await s.execute(delete(Job).where(Job.id == jid))
        await s.commit()


@pytest.fixture
async def client_factory(session_factory: Any) -> AsyncIterator[Any]:
    """Return a factory that builds an httpx.AsyncClient with a chosen wallet."""
    from httpx import ASGITransport, AsyncClient

    from superbcs_api.api import deps as api_deps
    from superbcs_api.main import app
    from superbcs_api.services.auth import WalletSession

    def make(wallet: str | None) -> AsyncClient:
        async def _opt() -> WalletSession | None:
            return WalletSession(wallet=wallet.lower()) if wallet else None

        async def _req() -> WalletSession:
            if wallet is None:
                from fastapi import HTTPException, status

                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wallet authentication required")
            return WalletSession(wallet=wallet.lower())

        app.dependency_overrides[api_deps.optional_wallet] = _opt
        app.dependency_overrides[api_deps.required_wallet] = _req
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")

    try:
        yield make
    finally:
        from superbcs_api.main import app as _app

        _app.dependency_overrides.clear()

    # Ensure env var is set so importing `main` at fixture time succeeds even
    # before the session-scoped DSN fixture runs — though in practice the
    # session_factory fixture already imported it.
    _ = os.environ.get("SUPERBCS_DB_DSN")
