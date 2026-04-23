# MEFAI Home Video AI

> A production-ready, end-to-end **image-to-video AI pipeline** that connects a
> home GPU to a public web app through a tiny cloud API — with bot protection,
> signed media URLs, rate-limited quotas, and HMAC-hashed IP privacy baked in.

This repository is the open showcase of the SUPER BCS pipeline: how a browser
user clicks *Generate*, how a Cloudflare Turnstile challenge is enforced, how
the cloud API queues a job without ever holding a GPU, how a home worker claims
that job over an outbound-only connection, and how the final clip is delivered
through a time-limited signed URL.

## Why this exists

People ask how we run a creative AI product without renting expensive GPUs.
The answer is a **pull-based worker architecture**: the GPU lives at home, the
API lives in the cloud, and no inbound port is ever opened. This repo shows
both halves of that system in real, runnable code.

## Architecture at a glance

```
┌───────────┐   Turnstile    ┌───────────┐   Bearer    ┌───────────────┐
│  Browser  │ ───────────▶   │   API     │ ──────────▶ │ Parent panel  │
│ (React)   │                │ (FastAPI) │  passthru   │ (SIWE auth)   │
└─────┬─────┘                └─────┬─────┘             └───────────────┘
      │ signed media URL           │ job row (queued)
      │                            ▼
      │                      ┌───────────┐
      │                      │ Postgres  │
      │                      └─────┬─────┘
      │                            │  /worker/claim  (outbound HTTPS only)
      │                            ▼
      │                      ┌───────────┐
      └────── signed URL ◀── │  Home PC  │
                             │ ComfyUI + │
                             │  FLUX     │
                             └───────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for the full sequence
diagram.

## What makes this interesting

- **No inbound ports at home** · the worker polls outward, so the home network
  is never exposed. No tunnels, no reverse proxies, no port-forwarding.
- **Turnstile-gated submissions** · every job creation carries a fresh
  Cloudflare Turnstile token verified server-side before the job row is ever
  written.
- **HMAC-hashed IP rate limiting** · raw client IPs are never persisted. Every
  rate-limit counter is keyed on `HMAC_SHA256(worker_secret, ip)` so a leaked
  database reveals nothing about who submitted what.
- **Signed, short-lived media URLs** · generated artifacts are served behind
  a `HMAC + expiry` signature. A tampered or expired URL returns `404` (same
  shape as a miss, so there is no signing oracle). IDOR across wallets is
  blocked separately at the query layer.
- **Mood/detail prompt engineering** · each preset is structured as a
  ≤15-word **mood** (front-loaded for model-token weight) followed by a
  cinematography **detail** line. See
  [`docs/prompt-engineering.md`](docs/prompt-engineering.md).
- **Layered quotas** · tiered by wallet (free / pro / prime), enforced by
  counting the wallet's last 24 hours of submissions on every job-create.
  The per-IP hourly bucket in the rate-limit layer catches burst concurrency
  on top.
- **Forwarded-header hardening** · `CF-Connecting-IP` / `X-Forwarded-For`
  are only trusted when the API is explicitly configured to sit behind a
  named proxy. Direct clients cannot forge a header to bypass IP rate
  limiting or the worker CIDR allowlist.

## Repo layout

| Path             | What's in it                                             |
|------------------|----------------------------------------------------------|
| [`frontend/`](frontend/) | React + Vite UI: Turnstile wrapper, wallet session, job submit + poll, history grid |
| [`api/`](api/)           | FastAPI service: public endpoints, worker endpoints, signed media, rate limiter |
| [`docs/`](docs/)         | Architecture, security, prompt engineering notes         |

The GPU worker daemon itself (ComfyUI + FLUX in Docker, polling `/worker/claim`)
will be added in a follow-up release once the home-side setup is polished.

## Quick start

### API (`api/`)

```bash
cd api
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
cp .env.example .env
# fill in CHANGE_ME values
alembic upgrade head
uvicorn superbcs_api.main:app --reload
```

### Frontend (`frontend/`)

```bash
cd frontend
npm install
cp .env.example .env
# point VITE_SUPERBCS_API_BASE at your running API
npm run dev
```

## Running the test suite

```bash
cd api && pytest -q
```

Integration tests cover IDOR protection, signed-media tampering, request-id
propagation, and worker bearer-auth paths.

## License

Apache-2.0 — see [`LICENSE`](LICENSE). Model weights (FLUX.1-schnell) carry
their own Apache-2.0 license from their upstream publisher.
