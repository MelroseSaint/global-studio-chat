# ADR-0002: Dynamic rendering for SEO

- **Status:** Accepted
- **Date:** 2026-08-06
- **Related:** [ADR-0001](0001-repo-owned-canonical-host.md), [ADR-0003](0003-dynamic-sitemap-and-health-gates.md)

## Context

PureWire is a client-rendered React SPA. A bare SPA is invisible to search
engines and social unfurlers: the crawler sees an empty `<div id="root">`
and the app's investment in OG tags and structured data is dead. The
product needs post and profile pages to be indexable and to win rich social
cards — *without* sacrificing the SPA experience for real users.

Options considered:

- **Full SSR / SSG framework** — a rewrite; rejected for scope and because
  the interactive surfaces (feeds, DMs, admin) genuinely need the SPA.
- **Prerender service** — external cost + a second rendering truth.
- **Dynamic rendering** — serve static HTML to crawlers, the SPA to
  browsers, from the same URLs.

## Decision

- Convex **HTTP actions** render `/og/post/:id` and `/og/profile/:handle`
  as static HTML: the real content, Article/ProfilePage JSON-LD, a
  real-host canonical (ADR-0001), and `index,follow`.
- **Vercel middleware** serves those OG pages to crawler and social-unfurler
  user agents for the public URLs `/post/:id` and `/u/:handle`; browsers get
  the SPA, whose runtime per-route metadata module (`src/lib/seo.ts`)
  applies the matching tags client-side.
- **CI enforces it**: a Googlebot-vs-browser check must never see the SPA
  shell from a crawler fetch, and must never see a non-interactive page
  from a browser fetch.

## Consequences

### Positive
- Post/profile pages are crawlable and card-worthy with zero JavaScript —
  verified in CI on every push and nightly.
- No SSR framework rewrite; the SPA stays the single interactive truth and
  the server-rendered pages are thin, deterministic views over Convex.

### Negative
- Two HTML paths (server-rendered OG pages + SPA runtime metadata) must
  stay consistent; a feature that changes page structure has to touch both.
- Middleware UA sniffing is a heuristic — new crawler UAs need adding, and
  a misclassification serves the wrong variant (guards catch this).

### Trade-offs / notes
- Content that is invisible to an anonymous crawler (posts in AI review,
  shadowbanned profiles) is excluded from the sitemap (ADR-0003) so the
  crawl surface and the render surface agree.
- The dynamic-render guard is the tripwire: if it ever fails, search
  visibility is already broken — treat it as urgent.
