import { v } from "convex/values";

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";

import { mutation } from "./_generated/server";

/**
 * Self-auditing session security.
 *
 * PureWire never stores IP addresses or user agents in the clear. Instead
 * the browser computes a one-way fingerprint — a salted SHA-256 of the UA
 * string plus a coarse region token (timezone offset + language) — and
 * files it against the current authSessions row. When an existing session
 * suddenly presents a wildly different fingerprint (a stolen cookie being
 * used from another device/country, or an account-takeover attempt), the
 * session is SILENTLY revoked: the authSessions row is deleted, the JWT
 * stops validating, and the user must re-authenticate with a one-time
 * email code. Nothing sensitive is logged — the audit keeps only the
 * one-way fingerprint of the CURRENT device.
 */

/**
 * File this device's fingerprint against the current session.
 *
 * - First call: stores the fingerprint (the session is trusted).
 * - Later call with the SAME fingerprint: refreshes updatedAt (no-op).
 * - Later call with a DIFFERENT fingerprint: silently revokes the
 *   session and returns { revoked: true }. The client then signs the
 *   user out with a friendly notice and prompts a one-time email code.
 */
export const signal = mutation({
  args: { uaHash: v.string(), regionToken: v.string() },
  handler: async (ctx, { uaHash, regionToken }) => {
    const userId = await getAuthUserId(ctx);
    const sessionId = await getAuthSessionId(ctx);
    if (userId === null || sessionId === null) {
      return { revoked: false };
    }
    if (typeof uaHash !== "string" || uaHash.length < 16) {
      return { revoked: false };
    }

    const existing = await ctx.db
      .query("sessionSignals")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    if (existing === null) {
      // Brand-new session — establish its fingerprint.
      await ctx.db.insert("sessionSignals", {
        sessionId,
        uaHash,
        regionToken: typeof regionToken === "string" ? regionToken : undefined,
        updatedAt: Date.now(),
      });
      return { revoked: false };
    }

    const sameDevice = existing.uaHash === uaHash;
    const sameRegion = (existing.regionToken ?? "") === regionToken;

    if (sameDevice && sameRegion) {
      await ctx.db.patch(existing._id, { updatedAt: Date.now() });
      return { revoked: false };
    }

    // Fingerprint mismatch → the cookie is being used somewhere else.
    // Silently revoke: delete the authSessions row (the JWT dies with it).
    // The auth library also keeps an authRefreshTokens row per session —
    // deleting the session row is sufficient to invalidate the token.
    await ctx.db.delete(sessionId);
    await ctx.db.delete(existing._id);
    return { revoked: true };
  },
});
