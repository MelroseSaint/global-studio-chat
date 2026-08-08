# ADR-0001: Repo-owned canonical host

- **Status:** Accepted
- **Date:** 2026-08-06
- **Related:** [ADR-0002](0002-dynamic-rendering-for-seo.md), [ADR-0003](0003-dynamic-sitemap-and-health-gates.md)

## Context

The site's canonical/OG tags must always point at the production host
(`https://purewire.vercel.app`). Two failure modes repeatedly appeared:

1. **Env-var drift** — a `VITE_SITE_URL` dashboard var that predated the
   canonical-host work overrode the intended host at build time, shipping
   wrong hosts in canonical/OG tags from preview and mirror builds.
2. **Multi-surface leakage** — the Convex static-hosting mirror and preview
   deployments each have their own hostnames, and any of them could leak
   into canonical tags, sitemap `<loc>`s, or og:url values.

The host is a deployment property; the repo is the only place that can
guarantee it stays correct.

## Decision

- The canonical host is **repo-owned by construction**: `vite.config.ts`
  substitutes `%PUREWIRE_SITE_URL%` in every URL-bearing meta tag, defaulting
  to `https://purewire.vercel.app` when the env var is absent.
- `PUREWIRE_SITE_URL` is set explicitly on **all** Vercel environments
  (production, preview, development) so the dashboard self-documents the
  canonical host and previews canonicalize to production.
- `VITE_SITE_URL` is deprecated and ignored everywhere; a CI guard fails if
  it is ever re-added to the Vercel environment.
- The canonical host is asserted on **every link surface** by CI: the SEO
  basics guard (homepage tags), the sitemap URL health checks (canonical
  and `og:url` on sampled posts/profiles), the source-level sitemap `<loc>`
  guard (main host **and** mirror), and the build-log warning guard (the
  shipped deploy's build log must carry no canonical-host warnings).

## Consequences

### Positive
- Canonical/OG/sitemap URLs can never regress to a preview or mirror
  hostname — the failure is caught at the source, in CI, with the offending
  URLs named in the alert.
- Changing the domain later is a single, documented edit: the `vite.config.ts`
  default, the Vercel env var, and the healthcheck's `EXPECTED_SITE_URL`.

### Negative
- The env guard depends on Vercel API access from CI (the env-verification
  script needs a Vercel token); a CI permissions change silently widens the
  guard's blind spot until the build-log guard catches it.
- An explicit env var on all environments is a small operational tax versus
  relying on the default.

### Trade-offs / notes
- The **mirror** host is *not* canonicalized — its sitemap must carry
  canonical-host `<loc>`s (ADR-0003) rather than self-referencing, so the
  mirror stays crawlable without ever becoming the canonical host.
- Drift detection is layered (env guard + build-log guard + live-tag
  checks) deliberately: no single check can see all three surfaces.
