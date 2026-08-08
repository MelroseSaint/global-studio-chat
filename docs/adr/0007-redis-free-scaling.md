# ADR-0007: Redis-free scaling to 1M+ users (supersedes the Redis layer)

- **Status:** Accepted (supersedes the earlier Redis distributed-layer ADR)
- **Date:** 2026-08-08
- **Context:** ADR-0001…0006 (canonical host, dynamic rendering, sitemap, QA
  harness, comment engagement, admin IP binding)
- **Decision:** Scale to 1M+ users **without Redis**, using the stack's own
  primitives — Convex's serverless model is the scaling layer, the existing
  table-based rate limits + proof-of-work are the abuse gate, and Vercel's
  edge CDN absorbs the read surface.

## Why the Redis layer was removed

An earlier iteration added Upstash Redis for distributed rate-limit
preflights (a Lua token bucket behind a Convex HTTP action). It worked,
but it cost a second service to provision and operate, three synchronized
budget tables, and a fail-open dependency — for a job the platform already
did correctly server-side. The write path's real protection was never the
Redis bucket; it was (and is) Convex's **authoritative, transactional
table-based rate limits** (`rateLimits` in `src/convex/security.ts`),
gated further by **client proof-of-work**. Redis only made the rejection
marginally cheaper — not possible at all.

Decision: **remove the Redis layer entirely** (HTTP action, client
preflight, env vars, QA job, docs) and make the Redis-free architecture
explicit, so nobody re-adds a sidecar service for work the platform's
runtime already provides.

## The 1M+ user architecture (no Redis)

### 1. Convex is the scaling layer — serverless by design

Convex runs functions in a managed, globally distributed runtime. There is
no server fleet to size, no connection-pool ceiling, no instance state —
scaling is the provider's problem, and the client SDK's automatic
deduplication + caching means N viewers of the same query share one
backend evaluation. The job of the app code is to keep every query cheap:

- **Indexed reads everywhere** — every query uses a defined index
  (`by_author`, `by_post`, `by_user_action`, …); no full scans.
- **Denormalized engagement counters** — post/comment like, comment and
  share counts live on the document, so a feed of 50 posts is 50 document
  reads, never N sub-queries.
- **Paginated everywhere** — feeds, threads, notifications, follows,
  search all paginate; no unbounded result sets.
- **Bounded tables** — `rateLimits` rows self-expire out of their rolling
  window; the removal log, audit rows, and trace tables are swept by the
  nightly QA. Nothing grows without bound.

### 2. The write path is gated without Redis

Per-write, in order:

1. **Client proof-of-work** (`src/lib/pow.ts` + `src/convex/pow.ts`) — a
   hashcash puzzle (~20–60 ms on a laptop) that makes flooding cost real
   compute per attempt. This is the bot-fleet deterrent.
2. **Convex's table-based rate limits** (`enforceRateLimit` in
   `src/convex/security.ts`) — per-user, per-action, rolling-window,
   transactional. This is the authoritative budget: posts/hour, comments,
   likes, follows, shares, uploads, DMs, tickets. It cannot be bypassed by
   a second request path, and its rows are self-cleaning.
3. **Structured rejection** — over-budget writes fail with the app's
   normal "slow down" message and record a quiet signal for the abuse
   pipeline, never a crash.

If traffic ever makes these table checks themselves a hot spot, the
next step is **not** Redis but `convex-ratelimit` (a Convex-native,
atomic sliding-window limiter built on the same table primitives) or
Convex's native rate limiting — same enforcement, zero new
infrastructure.

### 3. The read surface is absorbed by the edge

- **Vercel CDN** serves the immutable, hashed JS/CSS bundles with
  `Cache-Control: public, max-age=31536000, immutable` — a returning
  user's first byte never touches an origin.
- **Dynamic rendering only for crawlers** (`middleware.ts`) — bots get the
  server-rendered OG pages; real browsers get the SPA. Crawler traffic
  never hits the app's query layer through a browser path.
- **Convex's reactive queries** serve the personalized data, paginated and
  indexed, with the SDK's dedup/caching absorbing fan-out.

### 4. Ephemeral state (typing, presence) — if ever needed, still no Redis

The only genuine Redis-shaped need is real-time typing/presence indicators.
That is a future feature; when it lands, the options are a Convex
internal mutation+query pair (reactive by nature — presence rows expire
via a scheduled sweep) or a WebSocket relay, neither of which requires a
cache cluster.

## Consequences

**Positive**

- One fewer service to provision, secure, pay for, and fail-open around.
- The write path's enforcement is unchanged and authoritative; there is no
  "second source of truth" for budgets.
- The scaling story is the platform's own: Convex serverless + edge CDN +
  cheap queries. No external dependency appears in the critical path.

**Negative / costs**

- Convex's table-based rate check costs one indexed read + one insert per
  write — slightly more per-write work than an O(1) counter, at the
  benefit of being transactional and self-cleaning. If load ever makes
  this the bottleneck, `convex-ratelimit` is the drop-in upgrade.
- No distributed lock primitive — one-off jobs (blocklist sync,
  migrations) rely on Convex's own guarantees (single-owner scheduler
  jobs) instead. This matches how they run today.

## Related

- `src/convex/security.ts` — authoritative per-user table rate limits.
- `src/convex/pow.ts` + `src/lib/pow.ts` — client proof-of-work gate.
- `middleware.ts` + `vercel.json` — edge CDN + crawler dynamic rendering.
- `src/convex/schema.ts` — indexed, paginated, bounded tables.
