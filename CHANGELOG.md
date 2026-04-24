# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-24

Initial public release of the SUPER BCS image-to-video showcase.

### Added
- FastAPI service covering public submission, status polling, history,
  signed media delivery, worker claim/complete, and operator health.
- Cloudflare Turnstile server-side verification on `POST /jobs`.
- HMAC-hashed per-IP rate limiting keyed on the worker secret, so raw
  IPs never appear in counters, logs, or the database.
- Fail-closed forwarded-header resolver · `CF-Connecting-IP` /
  `X-Forwarded-For` are trusted only when the API is configured with
  `SUPERBCS_TRUST_FORWARDED_HEADERS=true` and the direct peer is inside
  `SUPERBCS_TRUSTED_PROXY_CIDRS`.
- Signed, short-lived media URLs · `HMAC(media_signing_key, label ||
  media_id || exp)`, constant-time verification, 24h TTL, tampered or
  expired signatures return `404`.
- Worker Bearer authentication with optional CIDR allowlist, applied
  symmetrically to `/worker/*` and the `/media/{id}` Bearer fallback.
- IDOR guard on `GET` and `DELETE /jobs/{id}` · mismatched wallet
  returns `404` to avoid confirming existence.
- Layered quota enforcement · per-wallet 24h rolling count plus per-IP
  hourly bucket.
- Request-ID propagation middleware with length + character-set
  allowlist on inbound `X-Request-ID` values.
- Response hardening middleware · `X-Content-Type-Options`,
  `Referrer-Policy`, and `Strict-Transport-Security` in production.
- Structured JSON logging via `structlog` with token/auth redaction and
  wallet shortening in log output.
- React + Vite frontend covering wallet sign-in (SIWE), Turnstile
  widget, job submission, status polling, and history grid.
- CI workflow · `ruff`, `mypy`, DB-free pytest subset, frontend `tsc`,
  and `gitleaks` secret scan.
- Dependabot watches pip (weekly), npm (weekly), and GitHub Actions
  (monthly).
- `SECURITY.md` private disclosure policy.

### Notes
- The GPU worker daemon (ComfyUI + FLUX) is not part of this release;
  it will follow once the home-side setup is polished.
- `SUPERBCS_MEDIA_SIGNING_KEY` falls back to the worker token when
  unset. Production deployments should configure a distinct key so a
  worker-token leak does not also compromise signed media URLs.

[0.1.0]: https://github.com/mefai-dev/mefaihomevideoai/releases/tag/v0.1.0
