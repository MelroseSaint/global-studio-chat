# ADR-0006: Backend-verified admin IP binding

- **Status:** Accepted
- **Date:** 2026-08-06
- **Related:** [ADR-0004](0004-harness-gated-production-qa.md)

## Context

Admin power must not be claimable from a stolen session on a different
network. The naive approach — the client reports its own IP and the backend
trusts it — is forgeable: a browser can claim any address. The platform
also promises "no identifying logs": raw IPs must never be stored, so the
binding mechanism itself must be privacy-preserving while still being
enforceable.

## Decision

- **The backend records what it observed, not what was claimed**: at admin
  sign-in, the IP the Convex edge actually saw on the request
  (`cf-connecting-ip` / `x-forwarded-for`) is captured and stored only as a
  **salted one-way hash** — the raw address never reaches storage.
- **Verification is backend-driven**: a fresh admin sign-in is verified
  through the `/admin/ip/verify` HTTP action against the observed
  request IP, so the admin can never self-certify an address.
- **Silent revocation**: the binding (and admin power) is revoked
  automatically when it goes stale or when an admin session shows up from a
  different network.
- Covered by the harness-gated `qa:admin-ip` script in the nightly health
  check (ADR-0004).

## Consequences

### Positive
- A stolen admin session used from another network is revoked instead of
  trusted; the window is closed at the backend, where the truth lives.
- Privacy holds: only salted hashes exist, consistent with the
  "no identifying logs" promise.

### Negative
- Legitimate admins on dynamically-assigned networks re-authenticate when
  their address changes — a small friction tax for the security win.
- The binding depends on the edge seeing a usable client IP; proxy
  misconfigurations (missing `cf-connecting-ip`) could degrade the check —
  the QA script guards against silent degradation.

### Trade-offs / notes
- This is the same principle as the rest of the platform's security model:
  the backend decides what is true, and it stores only what it must
  (salted hashes, never raw identifiers).
- The removal log's one-way snapshot discipline (auditable, never
  resurrectable) follows the same posture.
