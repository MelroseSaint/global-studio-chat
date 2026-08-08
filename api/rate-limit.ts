/**
 * PureWire distributed rate limiter (Vercel serverless + Upstash Redis).
 *
 * The platform's write path (createPost, addComment, like, follow, share,
 * sendMessage) is protected by per-user table-based limits inside Convex —
 * the authoritative backstop. But at 1M+ users, that table check is one
 * database read+write per action, and abuse traffic that will never pass
 * the limit still pays it. This endpoint is a cheap, O(1) Redis preflight
 * in front of that path:
 *
 *   - Token buckets live in Redis (fixed keys, Lua-atomic, auto-expiring),
 *     so a distributed fleet shares one counter per actor — no per-instance
 *     state, no table growth.
 *   - The bucket is consumed BEFORE the Convex mutation runs. Convex's
 *     table-based limits stay in place as the source of truth, so the
 *     Redis layer is an early-exit optimization, never a sole gate.
 *   - If Redis (or this endpoint) is unavailable, the caller falls through
 *     to Convex — graceful degradation, never a false block of a
 *     legitimate user.
 *
 * Rate-limit headers follow the standard shape so the client can surface
 * "slow down" messaging:
 *   X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 *   429 + X-RateLimit-Reset when the bucket is empty.
 *
 * Budgets are intentionally aligned with (slightly tighter than) Convex's
 * per-user budgets in src/convex/security.ts — the Redis bucket is the
 * fast path, the table check the enforcement.
 */
import { Redis } from "@upstash/redis";

/** One bucket per (action, actor) — actor is userId or IP when signed out. */
const KEY_PREFIX = "pw:rl:";

/**
 * Budgets (requests per window) mirror src/convex/security.ts RATE_LIMITS
 * but tuned slightly tighter so the preflight rejects marginally earlier
 * than the table check — the table is the authority, the bucket the gate.
 */
const BUDGETS: Record<string, { limit: number; windowSec: number }> = {
  post: { limit: 28, windowSec: 3600 }, // Convex: 30/hour
  comment: { limit: 55, windowSec: 3600 }, // Convex: 60/hour
  like: { limit: 110, windowSec: 3600 }, // Convex: 120/hour
  follow: { limit: 28, windowSec: 3600 }, // Convex: 30/hour
  share: { limit: 55, windowSec: 3600 }, // Convex: 60/hour
  upload: { limit: 180, windowSec: 3600 }, // Convex: 200/hour
  dm: { limit: 280, windowSec: 3600 }, // Convex: 300/hour
};

/**
 * Atomic fixed-window counter: INCR + expire-on-first-set. One round trip,
 * no read-modify-write race, auto-expiring so no janitor job.
 * Returns tokens remaining in the window after this call.
 */
const CONSUME_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local current = redis.call("INCR", key)
if current == 1 then
  redis.call("EXPIRE", key, window)
end
if current > limit then
  return { 0, current, now + window }
end
return { limit - current, current, now + window }
`;

function json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  // POST /api/rate-limit  { action, userId? }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, { status: 405 });
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    // Redis not configured — fail open (Convex table limits still apply).
    return json(
      { ok: true, degraded: true },
      { status: 503, headers: { "X-PureWire-RL": "degraded" } },
    );
  }

  let body: { action?: string; userId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, { status: 400 });
  }

  const { action, userId } = body;
  const budget = action ? BUDGETS[action] : undefined;
  if (!budget) {
    return json({ error: "unknown action" }, { status: 400 });
  }

  // Actor identity: signed-in users are keyed by their Convex user id; the
  // IP is the anonymous fallback (posts/comments require auth anyway, so
  // this only matters for share/like preflights from public surfaces).
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const actor = userId ? `u:${userId}` : `ip:${ip}`;

  const redis = new Redis({ url: redisUrl, token: redisToken });
  const key = `${KEY_PREFIX}${action}:${actor}`;
  const now = Math.floor(Date.now() / 1000);

  let res: number[];
  try {
    res = (await redis.eval(
      CONSUME_LUA,
      [key],
      [String(budget.limit), String(budget.windowSec), String(now)],
    )) as unknown as number[];
  } catch {
    // Redis hiccup — fail open, never block a user because of the cache.
    return json(
      { ok: true, degraded: true },
      { status: 503, headers: { "X-PureWire-RL": "degraded" } },
    );
  }

  const [remaining, used, reset] = res;
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(budget.limit),
    "X-RateLimit-Remaining": String(Math.max(0, remaining)),
    "X-RateLimit-Reset": String(reset),
  };

  if (used > budget.limit) {
    return json(
      {
        ok: false,
        retryAfterSec: Math.max(1, reset - now),
      },
      {
        status: 429,
        headers: { ...headers, "Retry-After": String(Math.max(1, reset - now)) },
      },
    );
  }

  return json({ ok: true, remaining, reset }, { headers });
}
