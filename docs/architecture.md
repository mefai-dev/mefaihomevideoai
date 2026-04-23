# Architecture

The pipeline has three independent processes connected by two trust boundaries:

```
+--------------------+   HTTPS   +--------------------+   HTTPS (outbound)   +---------------------+
|   Browser (React)  | --------> |    Cloud API       | <------------------- |    Home GPU worker  |
|                    |           |    (FastAPI)       |                      |    (ComfyUI + FLUX) |
+--------------------+           +--------------------+                      +---------------------+
          |                                 |
          v                                 v
   signed media URL                   Postgres jobs table
```

## Sequence — submit → render → deliver

```mermaid
sequenceDiagram
    participant U as Browser
    participant T as Turnstile
    participant A as Cloud API
    participant P as Panel (SIWE)
    participant D as Postgres
    participant W as Home GPU worker
    participant S as Signed media store

    U->>T: render widget
    T-->>U: token
    U->>A: POST /jobs  (Bearer + Turnstile token + prompt)
    A->>T: verify token
    T-->>A: ok
    A->>P: GET /profile/me  (passthrough)
    P-->>A: wallet info
    A->>D: read 24h wallet count · INSERT job (queued)
    A-->>U: 202 {job_id}
    loop every 2s
        U->>A: GET /jobs/{id}
        A-->>U: status
    end
    W->>A: GET /worker/claim (Bearer worker-token)
    A->>D: SELECT ... FOR UPDATE SKIP LOCKED; UPDATE claimed
    A-->>W: job payload
    W->>W: ComfyUI render
    W->>A: POST /worker/result (media bytes)
    A->>S: write + sign
    A->>D: UPDATE done, media_sig
    U->>A: GET /jobs/{id}
    A-->>U: done + signed URL
    U->>S: GET media (sig verified, expiry enforced)
```

## Why this shape

### The GPU lives at home

Cloud GPU rentals dominate the cost of creative-AI products. By running the
render on a single home-owned accelerator and exposing it only *outbound*, the
marginal cost per job drops to electricity. The trade-off is throughput — a
single worker can't absorb infinite concurrency — which is handled by the
queue and quota layers.

### The worker pulls, the API doesn't push

A push model would require the worker to expose a listener, which means port
forwarding or a tunnel. Both widen the home network's attack surface. Pulling
lets the worker sit behind a residential NAT indefinitely without opening
anything. The cost is a little latency (poll interval) which is negligible
against the render time.

### The API is stateless on GPU state

Nothing in the cloud tracks "which worker holds which job in memory." The
`claimed` row in Postgres is the entire shared state. If a worker dies
mid-render the job can be re-claimed by another (future) worker via a
`claimed_at + heartbeat_interval` expiry. This makes the system trivially
horizontal when more than one home worker is eventually added.

### SIWE auth is delegated

Wallet authentication runs in a separate "panel" application that owns the
SIWE handshake, issues a Bearer token, and is the authoritative user store.
The SUPER BCS API does not manage users — it verifies incoming Bearer tokens
against the panel's `/profile/me` endpoint with a 5-minute cache. This keeps
the image-gen service small and lets it reuse any existing user database.

## Trust boundaries

| Boundary                | What crosses it                      | Verification                |
|-------------------------|--------------------------------------|-----------------------------|
| Browser → API           | Turnstile token + Bearer session     | CF siteverify + panel cache |
| API → Panel             | Bearer session                       | HTTPS + 5-min cache         |
| Worker → API            | Bearer worker-token + optional IP    | shared-secret + CIDR list   |
| Signed-URL request      | HMAC signature + expiry              | constant-time compare       |

Every crossing is defense-in-depth — if one layer fails open, the next still
holds. See [`security.md`](security.md) for each defense in more detail.
