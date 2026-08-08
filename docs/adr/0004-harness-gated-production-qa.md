# ADR-0004: Harness-gated production QA

- **Status:** Accepted
- **Date:** 2026-08-06
- **Related:** [ADR-0003](0003-dynamic-sitemap-and-health-gates.md)

## Context

PureWire needs real end-to-end verification **against the live deployment**
— signups, moderation tiers, blocklist syncs, admin flows — where unit and
in-process tests cannot reach. But the backend paths that make this
possible (minting sessions, creating test users, admin actions) are exactly
the kind of power that must never be reachable by the public.

## Decision

- A **QA harness** in the backend (`testHarness` module) is gated by
  `TEST_HARNESS_SECRET` and only active when `TEST_HARNESS_ENABLED=1` is
  set on the deployment. Harness functions mint admin/session tokens only
  for callers who prove the secret; the harness is **disabled in
  production by default** and only enabled inside a controlled QA window.
- QA scripts (`scripts/*.mjs`, 30+ `npm run qa:*`) follow a strict exit
  convention: **0** all good, **1** a check failed, **2** harness disabled /
  missing secret (deterministic, never retried).
- **CI wiring**: deterministic local scanners run in Static Audit on every
  push/PR; production harness QAs run in the health check nightly (and on
  push). Any failure opens a **deduplicated alert issue** (one per label,
  auto-closed by the next passing run).
- **Transient flakes can't red the gate**: production-facing harness QAs
  run through `scripts/retry-once.sh`, which retries once when a run exits
  1 (plausibly transient — network blip, external feed) and never retries
  exit 2. `qa:blocklist-sync` retries internally in the script for the
  same reason. A genuine regression still fails after the retry and still
  alerts.
- **Sweeps**: `cleanup-test-users` / `cleanup-test-domains` jobs run
  `always()` after the QA jobs to erase leftover `qa_` accounts and test
  domains.

## Consequences

### Positive
- The full platform contract (auth, moderation, blocklist, admin, SEO) is
  asserted against the live site every night — regressions surface the day
  they land, with alert issues that dedupe instead of spamming.
- Flaky external feeds and network blips no longer red the nightly gate on
  their own, while real breakage still fails loudly.

### Negative
- The harness is a standing attack surface if ever misconfigured —
  `TEST_HARNESS_ENABLED` on a production deployment outside a QA window is
  a serious incident, not a convenience.
- Harness QAs create real test data on production; the always() sweep jobs
  are what keep it pristine, so a broken sweep leaves residue (caught by
  the next night's drift/cleanup).

### Trade-offs / notes
- Retry-once deliberately trades a slightly delayed signal on genuine
  regressions (they run twice before failing) for gate stability — the
  alert still fires, and the `::warning::` annotation marks recovered
  flakes for trend tracking.
- `qa:cloudinary-health` is included in the retry set even though it is not
  harness-gated — it probes an external service and is the same flake class.
