"""DB-bound IDOR integration tests.

Exercises the real SQLAlchemy path against a disposable Postgres and the
real FastAPI routers to confirm that:

  * a wallet-owned job is invisible to other wallets (GET -> 404),
  * the owning wallet can read its own job,
  * anonymous-owned jobs remain UUID-gated (readable without auth),
  * deletion is owner-only (cross-wallet DELETE -> 403, unauth -> 401),
  * /history only returns the caller's own jobs and requires auth.
"""

from __future__ import annotations


async def test_get_job_cross_wallet_is_404(seeded_jobs, client_factory):  # type: ignore[no-untyped-def]
    async with client_factory(seeded_jobs["bob_wallet"]) as c:
        r = await c.get(f"/api/superbcs/jobs/{seeded_jobs['alice_job_id']}")
    assert r.status_code == 404
    assert r.json()["detail"] == "job not found"


async def test_get_job_owner_can_read(seeded_jobs, client_factory):  # type: ignore[no-untyped-def]
    async with client_factory(seeded_jobs["alice_wallet"]) as c:
        r = await c.get(f"/api/superbcs/jobs/{seeded_jobs['alice_job_id']}")
    assert r.status_code == 200
    assert r.json()["job_id"] == seeded_jobs["alice_job_id"]


async def test_get_job_anon_readable_by_uuid(seeded_jobs, client_factory):  # type: ignore[no-untyped-def]
    """Anon-owned jobs (wallet_address IS NULL) remain readable to any caller
    holding the unguessable UUID. Regression guard — the IDOR check only
    fires when job.wallet_address is set."""
    async with client_factory(None) as c:
        r = await c.get(f"/api/superbcs/jobs/{seeded_jobs['anon_job_id']}")
    assert r.status_code == 200
    assert r.json()["job_id"] == seeded_jobs["anon_job_id"]


async def test_delete_cross_wallet_is_403(seeded_jobs, client_factory):  # type: ignore[no-untyped-def]
    async with client_factory(seeded_jobs["bob_wallet"]) as c:
        r = await c.delete(f"/api/superbcs/jobs/{seeded_jobs['alice_job_id']}")
    assert r.status_code == 403
    assert r.json()["detail"] == "not your job"


async def test_delete_unauthenticated_is_401(seeded_jobs, client_factory):  # type: ignore[no-untyped-def]
    async with client_factory(None) as c:
        r = await c.delete(f"/api/superbcs/jobs/{seeded_jobs['alice_job_id']}")
    assert r.status_code == 401


async def test_history_only_returns_own_jobs(seeded_jobs, client_factory):  # type: ignore[no-untyped-def]
    async with client_factory(seeded_jobs["bob_wallet"]) as c:
        r = await c.get("/api/superbcs/history?limit=50")
    assert r.status_code == 200
    body = r.json()
    ids = {item["job_id"] for item in body["items"]}
    assert seeded_jobs["bob_job_id"] in ids
    assert seeded_jobs["alice_job_id"] not in ids
    assert seeded_jobs["anon_job_id"] not in ids  # anon jobs never appear in history


async def test_history_requires_auth(client_factory):  # type: ignore[no-untyped-def]
    async with client_factory(None) as c:
        r = await c.get("/api/superbcs/history")
    assert r.status_code == 401
