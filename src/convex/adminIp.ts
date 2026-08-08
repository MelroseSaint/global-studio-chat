import { ConvexError, v } from "convex/values";

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";

import type { DatabaseReader } from "./_generated/server";
import { httpAction, internalMutation, internalQuery, query } from "./_generated/server";

import { internal } from "./_generated/api";
import { sha256Hex } from "./privacy";

/**
 * Backend-verified admin IP binding.
 *
 * The old session-audit model (sessionAudit.ts) lets the BROWSER compute a
 * fingerprint (UA hash + region token) and REPORT it — the server believes
 * whatever the client claims. Admin power deserves a stronger anchor: the
 * backend itself must observe the IP the admin actually logged in from.
 *
 * Only an HTTP action can see the real client IP (Convex queries/mutations
 * never receive request headers). So the browser — right after the admin
 * signs in, and then on a heartbeat — POSTs to /admin/ip/verify with its
 * bearer token. The action:
 *
 *   1. reads the IP from the request headers as seen by the edge
 *      (cf-connecting-ip set by Cloudflare, falling back to the LAST
 *      x-forwarded-for entry — the one appended by a trusted proxy, which
 *      a client cannot forge);
 *   2. resolves the caller and requires the admin role;
 *   3. stores a salted one-way hash of the IP against the session
 *      (never the raw address — the platform stores no IPs in the clear);
 *   4. on a LATER verification from a DIFFERENT IP, silently revokes the
 *      session (deletes the authSessions row) — a stolen session replayed
 *      from another network dies the moment the client re-verifies.
 *
 * `requireAdmin` then refuses admin power unless this binding is FRESH
 * (see assertAdminIpVerified): even a thief who never re-verifies is cut
 * off once the binding goes stale, because admin access depends on the
 * backend having recently OBSERVED the admin's IP — not on a claim.
 */

/** Salt for the one-way IP hash. Falls back to the email salt when unset. */
function ipHashSalt(): string {
  return process.env.ADMIN_IP_HASH_SALT ?? process.env.EMAIL_HASH_SALT ?? "";
}

/** How long a binding stays valid after its last successful verification. */
const VERIFY_TTL_MS = Number(process.env.ADMIN_IP_VERIFY_TTL_MS ?? 15 * 60_000);

/**
 * Bootstrap grace: a brand-new session (just signed in) is allowed a short
 * window to complete its FIRST verification before admin power is refused.
 * This covers the race between the app shell mounting and the client's
 * initial verify call landing. Old sessions get no grace — a replayed
 * credential must verify fresh from its IP.
 */
const GRACE_MS = Number(process.env.ADMIN_IP_VERIFY_GRACE_MS ?? 30_000);

/**
 * Origins allowed to call the verify endpoint cross-origin. The auth gate
 * is the bearer JWT itself (the endpoint refuses anyone without a valid
 * admin session), so reflecting preview origins is harmless — reflecting
 * them keeps admin verification working on preview builds too. Production
 * and the Convex mirror are the anchors; *.vercel.app covers previews.
 */
const ALLOWED_ORIGINS = new Set([
  "https://purewire.vercel.app",
  "https://outgoing-seal-727.convex.site",
]);

/** CORS headers for the browser's cross-origin fetch from the app origin. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  // The auth gate is the bearer JWT itself — reflecting an origin is never
  // an authorization decision. Allowed: the two real hosts, any *.vercel.app
  // preview, and localhost dev servers.
  const allowOrigin =
    origin !== "" &&
    (ALLOWED_ORIGINS.has(origin) ||
      origin.endsWith(".vercel.app") ||
      origin.startsWith("http://localhost:") ||
      origin.startsWith("http://127.0.0.1:"))
      ? origin
      : "https://purewire.vercel.app";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    "content-type": "application/json",
  };
}

function json(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request),
  });
}

/**
 * The client IP as observed by the edge. cf-connecting-ip is set by
 * Cloudflare from the actual connection and cannot be forged by the client;
 * x-forwarded-for's LAST entry is the one appended by the nearest trusted
 * proxy (client-supplied values appear earlier in the chain).
 */
function clientIp(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf !== null && cf.trim().length > 0) {
    return cf.trim().split(",")[0].trim();
  }
  const xff = request.headers.get("x-forwarded-for");
  if (xff !== null) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }
  return null;
}

/** Internal: role lookup for the HTTP action (HTTP ctx has no direct db). */
export const getRoleForVerify = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await ctx.db.get(userId);
    if (me === null) return null;
    return { role: me.role ?? null };
  },
});

/**
 * Internal: record (or refresh, or revoke on) a session's IP binding.
 * Returns what happened so the HTTP action can tell the client.
 */
export const recordIpBinding = internalMutation({
  args: {
    sessionId: v.id("authSessions"),
    ipHash: v.string(),
  },
  handler: async (ctx, { sessionId, ipHash }) => {
    const now = Date.now();
    // REVOCATION MUST BE STICKY. The auth JWT is stateless and stays
    // cryptographically valid for up to an hour after the authSessions row
    // is deleted, so a thief holding a revoked JWT could otherwise re-call
    // /admin/ip/verify and re-establish a binding (the old one was deleted
    // on revoke). Never bind a session whose row no longer exists — treat
    // it as revoked so the client signs out and the theft stays dead for
    // the life of the JWT.
    if ((await ctx.db.get(sessionId)) === null) {
      return { established: false, revoked: true };
    }
    const existing = await ctx.db
      .query("adminIpBindings")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (existing === null) {
      // First verification — this IP becomes the session's original.
      await ctx.db.insert("adminIpBindings", {
        sessionId,
        ipHash,
        verifiedAt: now,
      });
      return { established: true, revoked: false };
    }
    if (existing.ipHash === ipHash) {
      // Same IP — the admin's own device, refresh the timestamp.
      await ctx.db.patch(existing._id, { verifiedAt: now });
      return { established: false, revoked: false, refreshed: true };
    }
    // A DIFFERENT IP presented for this session — the session is being
    // used from another network. Silently revoke it (delete the
    // authSessions row — the JWT dies with it) and drop the binding.
    await ctx.db.delete(sessionId);
    await ctx.db.delete(existing._id);
    return { established: false, revoked: true };
  },
});

/** Internal: assert a fresh binding for the current session (action use). */
export const assertVerifiedForAction = internalQuery({
  args: {},
  handler: async (ctx) => {
    await assertAdminIpVerified(ctx as never);
    return { verified: true };
  },
});

/**
 * Client-facing status: has THIS session's admin IP binding been verified
 * recently? The Admin page gates on this so it can show a "verifying
 * device" screen instead of a wall of admin-query errors while the
 * initial verify call lands. Cheap: one index lookup per session.
 */
export const adminIpStatus = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { isAdmin: false, verified: false };
    }
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") {
      return { isAdmin: false, verified: false };
    }
    const sessionId = await getAuthSessionId(ctx);
    if (sessionId === null) {
      return { isAdmin: true, verified: false };
    }
    const binding = await ctx.db
      .query("adminIpBindings")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    return {
      isAdmin: true,
      verified:
        binding !== null && Date.now() - binding.verifiedAt < VERIFY_TTL_MS,
    };
  },
});

/**
 * The HTTP action the admin client calls to prove its IP.
 *
 * Route: POST /admin/ip/verify  (OPTIONS handled for CORS preflight)
 * Auth: Authorization: Bearer <convex jwt> (the same token the React
 *       client stores and sends on every Convex call).
 *
 * Returns:
 *   { ok: true, established: true, revoked: false }   first verification
 *   { ok: true, established: false, revoked: false }  same IP refreshed
 *   { ok: true, established: false, revoked: true }   IP changed → session
 *                                                     revoked; the client
 *                                                     must sign out.
 *   { ok: false, error }                              non-2xx
 */
export const verifyAdminIp = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405, request);
  }
  const ip = clientIp(request);
  if (ip === null) {
    return json(
      { ok: false, error: "Could not determine the client IP" },
      400,
      request,
    );
  }
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    return json({ ok: false, error: "Not authenticated" }, 401, request);
  }
  const sessionId = await getAuthSessionId(ctx);
  if (sessionId === null) {
    return json({ ok: false, error: "No session" }, 401, request);
  }
  const user = await ctx.runQuery(internal.adminIp.getRoleForVerify, {
    userId,
  });
  if (user === null || user.role !== "admin") {
    return json({ ok: false, error: "Admins only" }, 403, request);
  }
  const hash = await sha256Hex(`${ipHashSalt()}:admin-ip:${ip}`);
  const result = await ctx.runMutation(internal.adminIp.recordIpBinding, {
    sessionId,
    ipHash: hash,
  });
  return json({ ok: true, ...result }, 200, request);
});

/**
 * Throw unless the current session's admin IP binding is fresh.
 *
 * Called by requireAdmin (and every inline admin gate) so admin power is
 * gated on the backend having OBSERVED the admin's IP recently. A brand-new
 * session gets GRACE_MS to complete its first verification; anything else
 * with a missing or stale binding is refused.
 */
export async function assertAdminIpVerified(ctx: {
  auth: unknown;
  db: DatabaseReader;
}): Promise<void> {
  const sessionId = await getAuthSessionId(ctx as never);
  if (sessionId === null) {
    // requireAdmin already rejected unauthenticated callers; nothing to add.
    return;
  }
  const session = await ctx.db.get(sessionId);
  // A binding is meaningless if the session row is gone (revoked for an IP
  // change, signed out, or account erased) — the stateless JWT may still
  // decode, but admin power must not survive a deleted session. Refuse even
  // when a stale binding row lingers.
  if (session === null) {
    // ConvexError so the message crosses the public HTTP boundary: plain
    // Errors are masked as "Server Error" by Convex (see auth.ts), so the
    // admin UI and the QA harness would both see a generic failure instead
    // of the real reason admin power is refused.
    throw new ConvexError(
      "Admin access requires device IP verification. Please reload the page.",
    );
  }
  const binding = await ctx.db
    .query("adminIpBindings")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .first();
  if (binding !== null && Date.now() - binding.verifiedAt < VERIFY_TTL_MS) {
    return;
  }
  // Bootstrap grace for a just-created session (the client's first verify
  // lands moments after sign-in). Old sessions get no grace.
  const age = Date.now() - (session?._creationTime ?? 0);
  if (binding === null && age < GRACE_MS) {
    return;
  }
  throw new ConvexError(
    "Admin access requires device IP verification. Please reload the page.",
  );
}
