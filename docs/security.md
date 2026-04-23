# Security notes

Every defense in this pipeline addresses a specific, demonstrable threat. The
goal is not a checklist, it is *what happens if an attacker reaches this
layer and all previous ones failed open.*

## 1. Bot / abuse protection · Cloudflare Turnstile

**Threat:** a script submits thousands of jobs to drain GPU budget or crowd
legitimate users out of the queue.

**Defense:** every `POST /jobs` requires a short-lived Turnstile token.
The server calls Turnstile `siteverify` before the job row is written; if
verification fails the request is rejected with `403` and never reaches the
quota layer. The widget is rendered in managed mode, so normal users rarely
see an interactive challenge and bots still hit the same gate.

## 2. Request rate limiting · HMAC-hashed IP buckets

**Threat:** a single client submits jobs at machine speed and bypasses the
quota by cycling session tokens.

**Defense:** rate-limit counters are keyed on
`HMAC_SHA256(SUPERBCS_WORKER_TOKEN, client_ip)`. This means:

- The raw IP never appears in memory keys, logs, or the database.
- A leaked rate-limit snapshot is a set of opaque hashes an attacker cannot
  reverse without the worker secret.
- Key rotation (rotating `SUPERBCS_WORKER_TOKEN`) invalidates all historical
  counters cleanly.

See `src/superbcs_api/services/rate_limit.py`.

## 3. Trusted client IP

**Threat:** an attacker sets a forged `CF-Connecting-IP` or `X-Forwarded-For`
header to impersonate a different source and slip past the per-IP rate
limiter or the worker CIDR allowlist.

**Defense:** forwarded headers are only trusted when BOTH
`SUPERBCS_TRUST_FORWARDED_HEADERS=true` AND the direct TCP peer is inside
`SUPERBCS_TRUSTED_PROXY_CIDRS`. Default is closed: if the API is reachable
directly, `request.client.host` is the only IP source, so a forged header
cannot rewrite which bucket a request belongs to.

See `src/superbcs_api/core/security.py::client_ip`.

## 4. Per-wallet daily quotas

**Threat:** burst concurrency (open ten tabs, press Generate simultaneously)
races past the daily quota check.

**Defense:** each wallet's 24-hour job count is read immediately before the
insert and the job is created in the same async session that owns the count.
The rolling-window count is tight enough that a single abusive wallet cannot
meaningfully exceed its tier under normal load; for absolute serialization
the per-IP bucket in §2 still applies on top. See
`src/superbcs_api/services/quota.py`.

## 5. IDOR on job retrieval

**Threat:** an attacker guesses a job UUID and reads a stranger's clip.

**Defense:** `GET /jobs/{id}` and `DELETE /jobs/{id}` both enforce
`wallet_address == caller_wallet` before returning. If the caller does not
own the job the endpoint returns `404` (not `403`) to avoid confirming
existence. Anonymous jobs (no wallet_address) remain readable by any caller
who holds the unguessable UUID, which is required for anonymous submitters
to poll their own just-submitted job.

Test: `tests/integration/test_idor.py`.

## 6. Signed media URLs

**Threat:** an attacker captures a public media URL (e.g. from a share
link) and continues to serve it to third parties after the user's session
ends, or guesses a media UUID they never owned.

**Defense:** media URLs carry a `sig=<32-hex>&exp=<unix>` query. Serving the
file computes `HMAC_SHA256(SUPERBCS_MEDIA_SIGNING_KEY, label || media_id || exp)`
in constant time and checks `now < exp`. URL TTL is 24 hours. A leaked URL
stops working after its window closes. A tampered signature (or a missing
`sig`/`exp`) returns `404`, matching the shape of a miss so there is no
signing oracle.

Test: `tests/test_media_sig.py`.

## 7. Worker authentication · Bearer + optional CIDR allowlist

**Threat:** someone discovers the `/worker/*` endpoints and tries to claim
or complete jobs on behalf of the real worker.

**Defense:** two independent checks.

- **Bearer:** the worker presents `Authorization: Bearer <worker_token>`;
  the API compares in constant time against the secret from env.
- **CIDR:** if `SUPERBCS_WORKER_IP_ALLOWLIST` is set, the request must also
  originate from a CIDR in that list. The allowlist defaults to empty in
  dev/tests to avoid surprising local contributors. The CIDR check is built
  on the hardened `client_ip` resolver in §3, so a forged forwarded header
  cannot smuggle a request into the allowlist.

Test: `tests/test_worker_bearer.py`.

## 8. Input size caps

**Threat:** huge image uploads consume memory or stall workers.

**Defense:** `SUPERBCS_MAX_INPUT_BYTES` (default 8 MiB) is enforced before
the file is fully read into memory. Content-Type sniffing plus a tiny
header-only validator rejects non-images before any decoding happens.

## 9. Request-id propagation

Every request gets an `X-Request-ID` (generated if the client didn't send
one, and filtered through a length + character-set allowlist if they did).
It flows into every log line and downstream call so an abuse investigation
or a user-reported failure can be traced end-to-end without ever correlating
on IP or wallet.

Test: `tests/test_request_id.py`.

## 10. Response hardening headers

Every response gets `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`. In production environments the middleware
additionally sets `Strict-Transport-Security` (2 years, include subdomains)
as a belt-and-braces measure on top of whatever the edge proxy emits.
Validation errors return only the names of failing fields, never a raw
pydantic error tree, to avoid leaking schema internals.

## Threat model explicitly *not* addressed here

- **Prompt injection against the image model.** Safety-prompting and output
  moderation are out of scope for the showcase; the production deployment
  runs a separate moderator before workers pick up a job.
- **DoS at the network layer.** Cloudflare sits in front of the API and
  handles L3/L4 absorption.
- **Abuse of the share links.** The signed URL stops replay after the
  expiry window; distribution of the image itself is intentionally allowed
  (that is the product).
