# Security notes

Every defense in this pipeline addresses a specific, demonstrable threat. The
goal is not a checklist — it is *what happens if an attacker reaches this
layer and all previous ones failed open.*

## 1. Bot / abuse protection — Cloudflare Turnstile

**Threat:** a script submits thousands of jobs to drain GPU budget or crowd
legitimate users out of the queue.

**Defense:** every `POST /jobs` requires a short-lived Turnstile token.
The server calls Turnstile `siteverify` before the job row is written; if
verification fails the request is rejected with `400` and never reaches the
quota layer. The widget is rendered in managed mode, so normal users rarely
see an interactive challenge and bots still hit the same gate.

## 2. Request rate limiting — HMAC-hashed IP buckets

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

## 3. Per-wallet quotas — transactional `FOR UPDATE`

**Threat:** burst concurrency (open ten tabs, press Generate simultaneously)
races past the daily quota check.

**Defense:** the quota counter and the job insert live inside the same
`BEGIN ... COMMIT` block with `SELECT ... FOR UPDATE` on the quota row. A
concurrent submit blocks on the row lock instead of reading a stale count,
so the quota is exact even under contention.

## 4. IDOR on job retrieval

**Threat:** an attacker guesses a job UUID and reads a stranger's clip.

**Defense:** `GET /jobs/{id}` and `DELETE /jobs/{id}` both include
`AND wallet_address = :caller_wallet` in the `WHERE` clause. If the caller
does not own the job the query returns zero rows and the endpoint returns
`404` (not `403`) to avoid confirming existence.

Test: `tests/integration/test_idor.py`.

## 5. Signed media URLs

**Threat:** an attacker captures a public media URL (e.g. from a share link)
and continues to serve it to third parties after the user's session ends.

**Defense:** media URLs carry a `sig=<hex>&exp=<unix>` query. Serving the
file computes `HMAC_SHA256(SUPERBCS_MEDIA_SIGNING_KEY, media_id || exp)` in
constant time and checks `now < exp`. A leaked URL stops working after its
window closes (default: one hour). A tampered signature returns `403`
without even a timing oracle.

Test: `tests/test_media_sig.py`.

## 6. Worker authentication — Bearer + optional CIDR allowlist

**Threat:** someone discovers the `/worker/*` endpoints and tries to claim
or complete jobs on behalf of the real worker.

**Defense:** two independent checks.

- **Bearer:** the worker presents `Authorization: Bearer <worker_token>`;
  the API compares in constant time against the secret from env.
- **CIDR:** if `SUPERBCS_WORKER_IP_ALLOWLIST` is set, the request must also
  originate from a CIDR in that list. The allowlist defaults to empty in
  dev/tests to avoid surprising local contributors.

Test: `tests/test_worker_bearer.py`.

## 7. Input size caps

**Threat:** huge image uploads consume memory or stall workers.

**Defense:** `SUPERBCS_MAX_INPUT_BYTES` (default 8 MiB) is enforced before
the file is fully read into memory. Content-Type sniffing plus a tiny
header-only validator rejects non-images before any decoding happens.

## 8. Request-id propagation

Every request gets a `X-Request-ID` (generated if the client didn't send
one) and it flows into every log line and downstream call. This means an
abuse investigation or a user-reported failure can be traced end-to-end
without ever correlating on IP or wallet.

Test: `tests/test_request_id.py`.

## Threat model explicitly *not* addressed here

- **Prompt injection against the image model.** Safety-prompting and output
  moderation are out of scope for the showcase; the production deployment
  runs a separate moderator before workers pick up a job.
- **DoS at the network layer.** Cloudflare sits in front of the API and
  handles L3/L4 absorption.
- **Abuse of the share links.** The signed URL stops replay after the
  expiry window; distribution of the image itself is intentionally allowed
  (that is the product).
