# ADR-0007: Redis as a distributed layer for 1M+ user scaling

- **Status:** Accepted
- **Date:** 2026-08-08
- **Context:** ADR-0001…0006 (canonical host, dynamic rendering, sitemap, QA
  harness, comment engagement, admin IP binding)
- **Decision:** Add Upstash Redis as a **complementary distributed layer** —
  rate-limit preflights and ephemeral state — while Convex remains the sole
  system of record. Document the full 1M-user division of labor.

## Context

PureWire's backend is Convex: a hosted, reactive database where queries
push updates to clients and mutations are transactional server functions.
The frontend is a Vite SPA served by Vercel at the edge, with an Edge
middleware for crawler dynamic-rendering and the sitemap. At 1,000,000+
users the write path is the contended surface: every post, comment, like,
follow, share and DM pays a per-user table check (`rateLimits` table) plus
the write itself, and abuse traffic that will never pass the limit still
pays that cost.

Redis was evaluated for every candidate role:

| Role | Verdict |
| --- | --- |
| **System of record / DB replacement** | **Rejected.** Convex's reactive push (a query update reaches every subscribed client within ~100ms) and transactional mutations are the product's core. Splitting durable state across a second store would fork the reactive graph and create two sources of truth. |
| **Caching Convex query results** | **Rejected.** Convex already deduplicates and caches queries server-side, and cache invalidation outside Convex would need an event feed that doesn't exist. A Redis copy would drift. |
| **Distributed rate-limit preflight** | **Adopted** — see below. |
| **Ephemeral state (typing, presence)** | **Adopted (design)** — the natural Redis domain: short-TTL, low-durability, cross-instance. Not yet implemented; see "Next steps". |
| **Distributed locks (one-off jobs)** | **Adopted (design)** — a `SET NX PX` lock around cross-instance maintenance (blocklist sync, migrations) so a concurrent run can't double-apply. |

The rule that decides each row: **Redis owns nothing durable; it only makes
the hot path cheaper or coordinates instances. If Redis vanished, the app
must keep working correctly (just slightly slower) — Convex enforces.** That
is what makes the layer safe to add to a reactive architecture.

## Decision

### 1. Convex remains the system of record — the 1M-user foundation

The load-bearing scaling work is Convex-side and is already in place or
cheap to keep:

- **Indexed reads everywhere** — every query the app issues uses a defined
  index (`by_author`, `by_post`, `by_user_action`, …); no full scans.
- **Denormalized engagement counters** — post `likeCount`/`commentCount`/
  `shareCount`, comment `likeCount`/`replyCount` are maintained on the
  document, so a feed of 50 posts is 50 document reads, never N sub-queries.
- **Paginated everywhere** — feeds, comment threads, notifications,
  followers, search all paginate; no unbounded result sets.
- **PoW write-gating** — every write carries a client-solved hashcash
  puzzle; bots pay compute per attempt on top of rate limits.
- **Bounded rate-limit table** — `rateLimits` rows self-expire out of the
  rolling window; the table cannot grow without bound.

### 2. Redis adds the distributed fast path

- **`api/rate-limit.ts`** (Vercel serverless + Upstash Redis): a fixed-window
  token bucket per `(action, actor)` via a single atomic Lua
  `INCR + EXPIRE`. One round trip, no read-modify-write race, keys
  auto-expire (no janitor job). Actor = Convex user id when signed in, IP
  otherwise.
- **Client preflight** (`src/lib/rate-limit.ts`): the write path
  (post, comment, like, follow, share, dm) checks the bucket BEFORE the
  Convex mutation, so an over-budget actor fails fast with the app's normal
  "slow down" toast — without paying a database write. Standard
  `X-RateLimit-*` headers ride along.
- **Convex table limits stay authoritative.** The Redis bucket is tuned
  slightly tighter (28/30 posts, 55/60 comments, …) and is *advisory*: it
  rejects marginally earlier on the fast path, and the table check still
  enforces the true budget. **Fail-open semantics:** if Redis or the
  endpoint is down (503), the client passes straight through to Convex —
  a cache outage can never lock out legitimate members.

### 3. Where Redis is NOT used (and why)

- No durable state, no cache of reactive queries, no user documents, no
  messages (DMs are E2E-encrypted and stored in Convex).
- Enforcement never depends on Redis availability.

## Consequences

**Positive**

- Abuse and over-budget traffic is rejected with O(1) Redis work instead of
  a database write per attempt; the database write path serves legitimate
  traffic.
- Distributed by construction — one shared counter across the whole Vercel
  fleet, no per-instance memory state.
- Fully additive: Convex stays the single source of truth; reactivity is
  untouched; the layer degrades to "exactly today's behavior" if disabled.

**Negative / costs**

- One more service to provision (Upstash Redis) and two env vars
  (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`); dev runs without
  them (preflight fails open).
- The budget tables exist in three places (Convex `security.ts`, the API
  route, the client mirror) — they must be kept in sync when tuning (the
  files cross-reference each other).
- Rate-limit semantics are fixed-window (per-hour), not sliding-window —
  adequate for abuse prevention; the table check is the rolling-window
  authority.

## 1M-user capacity posture

- **Reads**: edge-served static assets (immutable hashed bundles), Convex
  reactive reads on indexed + paginated + denormalized data, dynamic-render
  middleware for crawlers only.
- **Writes**: PoW gate → Redis preflight → Convex transaction (with its own
  table rate limits). The Redis layer absorbs the flood that would
  otherwise reach the database.
- **Next steps** (documented for when headroom is needed):
  1. Typing/presence indicators via Redis (`SETEX` presence keys,
     `PUBLISH/SUBSCRIBE` via Upstash Channels) — ephemeral, no Convex writes.
  2. Distributed lock for cross-instance maintenance (blocklist sync,
     migrations) — `SET key uuid NX PX 60000` with a stale-lock watchdog.
  3. A dedicated load test (`qa:scale` script or k6) hammering the write
     path at N× current QPS to measure the Convex ceiling and validate the
     Redis offload before it's needed.
  4. Upstash's own rate-limit helper could replace the hand-rolled Lua once
     its sliding-window support is verified (same fail-open discipline).

## Related

- `src/convex/security.ts` — authoritative per-user table rate limits.
- `api/rate-limit.ts` — Redis token-bucket endpoint.
- `src/lib/rate-limit.ts` — client preflight (fail-open).
- `docs/setup.md` — Redis env vars and local dev.
