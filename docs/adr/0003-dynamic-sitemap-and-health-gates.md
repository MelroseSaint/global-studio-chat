# ADR-0003: Dynamic sitemap + health gates

- **Status:** Accepted
- **Date:** 2026-08-06
- **Related:** [ADR-0001](0001-repo-owned-canonical-host.md), [ADR-0002](0002-dynamic-rendering-for-seo.md)

## Context

A static `sitemap.xml` listing only the fixed marketing pages cannot index
user content — posts and profiles, the pages that actually grow — and any
sitemap can silently carry dead URLs, wrong hosts, or redirect drift.
Search engines submit what the sitemap says; a visibility regression is
silent and compounds.

## Decision

- **The sitemap is generated from Convex**: the six fixed public pages come
  from `src/lib/routes.ts` (a routes manifest shared with the router — add
  a public page there and it appears in the sitemap automatically), plus
  the newest public posts and profiles, excluding content that 404s for an
  anonymous crawler (posts in AI review, shadowbanned profiles).
- **It is enforced at the source and at the URL**: CI samples sitemap URLs
  (configurable `SITEMAP_SAMPLE`, `--all` for a full sweep) and asserts
  each returns HTTP 200 with **real content** (Article/ProfilePage JSON-LD,
  never the SPA shell or a 404), a same-host canonical **and** `og:url`
  matching the exact sitemap URL, and no redirect drift.
- **Wrong-host sitemaps fail before sampling**: every `<loc>` on the main
  host *and* the Convex mirror must carry the canonical origin (scheme +
  host, not hostname alone) — an `http://` loc or a mirror/preview host loc
  fails with the offending URLs listed.
- **robots.txt is wired through Vercel** so the SPA fallback never
  swallows it, and a static-audit guard fails if robots/sitemap drift or
  vanish.

## Consequences

### Positive
- User content is indexable; adding a public page is a one-file edit in the
  routes manifest.
- Dead, wrong-host, or drift-prone URLs are caught in CI on every push and
  nightly — never silently submitted.

### Negative
- The sitemap is generated at request time from Convex, so it depends on
  backend availability; mitigated with CDN caching and a refresh schedule.
- The routes-manifest coupling means the sitemap and the router must stay
  in sync by construction (shared module) — a new route added outside the
  manifest silently stays out of the sitemap.

### Trade-offs / notes
- The mirror's sitemap must carry canonical-host locs (ADR-0001) even
  though the mirror serves its own hostname — crawlable, never canonical.
- Leftover test accounts (`qa_`, `pw_` prefixes) can appear in the
  sitemap; the URL health checks pass them as long as they render valid
  content, but the cleanup jobs (ADR-0004) keep them from accumulating.
