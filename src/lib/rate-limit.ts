/**
 * PureWire distributed rate-limit client (Redis-backed).
 *
 * The write path (post, comment, like, follow, share, dm) calls
 * `checkRateLimit` BEFORE firing the Convex mutation. It asks the Vercel
 * serverless endpoint (/api/rate-limit) for a Redis token-bucket token.
 *
 * Semantics — fail OPEN:
 *   - Redis or the endpoint unavailable (503 degraded, 404 in dev with no
 *     API server, network error): pass. Convex's own table-based limits in
 *     src/convex/security.ts remain the authoritative backstop, so the
 *     write still can't exceed budget — it just skips the fast-path gate.
 *   - 429: fail fast with a retry-after hint so the user sees the app's
 *     normal "slow down" messaging instead of paying a database write.
 *
 * The budget table mirrors api/rate-limit.ts (which mirrors Convex) — keep
 * the three in sync when tuning.
 */

export type RateLimitAction =
  | "post"
  | "comment"
  | "like"
  | "follow"
  | "share"
  | "upload"
  | "dm";

/** Match the server's fail-open behavior exactly. */
export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the bucket refills — only set on a 429. */
  retryAfterSec?: number;
  /** True when Redis/endpoint was unavailable and the check was skipped. */
  degraded?: boolean;
}

/**
 * Ask the Redis limiter for a token. Never throws: any failure is a pass
 * (fail open) so a cache outage can never lock out legitimate members.
 */
export async function checkRateLimit(
  action: RateLimitAction,
  userId?: string,
): Promise<RateLimitResult> {
  try {
    const res = await fetch("/api/rate-limit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, userId }),
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as {
        retryAfterSec?: number;
      };
      return { ok: false, retryAfterSec: body.retryAfterSec };
    }
    if (res.status === 503) {
      // Redis not configured / unavailable — fail open.
      return { ok: true, degraded: true };
    }
    if (res.ok) {
      return { ok: true };
    }
    // 400/405 — misconfigured action; fail open rather than block users.
    return { ok: true, degraded: true };
  } catch {
    // Network error (dev server without an API proxy, offline) — fail open.
    return { ok: true, degraded: true };
  }
}

/**
 * Convenience for mutations that want a one-shot preflight: returns true
 * when the action may proceed (or the limiter is unavailable).
 */
export async function mayProceed(
  action: RateLimitAction,
  userId?: string,
): Promise<boolean> {
  const r = await checkRateLimit(action, userId);
  return r.ok;
}
