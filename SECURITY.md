# Security policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for suspected vulnerabilities.

Instead, report privately through GitHub's built-in advisory flow:

1. Go to https://github.com/mefai-dev/mefaihomevideoai/security/advisories/new
2. Describe the issue, the affected file / endpoint, and a minimal reproduction.
3. We will acknowledge receipt within 5 business days and aim to ship a
   fix or mitigation within 30 days, depending on severity.

Please include:

- The version / commit SHA you tested against.
- Steps to reproduce, including any required inputs and configuration.
- Impact assessment (what an attacker gains).
- Any suggested mitigation, if you have one.

## Scope

In scope:

- Anything in this repository (`api/`, `frontend/`, `docs/`).
- The HTTP surface of a default-configured deployment.

Out of scope:

- Issues requiring physical access to the home GPU / worker machine.
- DoS at the network layer (absorbed by the upstream CDN in production).
- Prompt injection against the image model itself — a separate moderator
  runs in production and is out of scope for this showcase.
- Issues that require an attacker to already hold the operator's
  `SUPERBCS_WORKER_TOKEN` or panel database.

## Coordinated disclosure

We prefer coordinated disclosure. If you plan to publish a write-up or CVE,
please give us the opportunity to ship a fix first. We are happy to credit
researchers in the release notes of the patched version.

## Hall of fame

Names of researchers who responsibly disclosed accepted reports will be
listed in the release notes of the fix commit.
