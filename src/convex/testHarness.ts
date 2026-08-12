import { v, ConvexError } from "convex/values";
import { getAuthSessionId } from "@convex-dev/auth/server";
import { SignJWT, importPKCS8 } from "jose";

import { ADMIN_EMAIL } from "./auth";
import { eraseAccount } from "./account";
import { maybeNotifyAutoClosed } from "./posts";
import { internal } from "./_generated/api";

import {
  cleanupMediaItems,
  sweepCommentLikes,
  sweepPostEngagement,
} from "./mediaCleanup";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

import type { Id } from "./_generated/dataModel";

/**
 * QA harness for the silent-moderation layer.
 *
 * A script can't read email OTPs, so a repeatable end-to-end check of the
 * quiet shadowban needs a way to create throwaway accounts and mint real
 * auth sessions for them. This module does exactly that — and only while the
 * deployment env has TEST_HARNESS_ENABLED=1 AND the caller proves
 * TEST_HARNESS_SECRET, so it is inert by default in production. Every
 * function throws unless both gates pass.
 *
 * Run `npm run qa:shadowban` (see scripts/shadowban-qa.mjs). To enable on a
 * deployment, set both env vars, run the script, then remove them:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> npm run qa:shadowban
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Sessions are minted exactly like the auth library: an authSessions row plus
 * a JWT signed with the deployment's own JWT_PRIVATE_KEY (sub "userId|sessionId",
 * issuer CONVEX_SITE_URL, audience "convex"), so every surface the check
 * drives behaves identically to a browser session.
 */

/** Both gates must pass: the deployment flag and the shared secret. */
function requireHarness(secret: string): void {
  if (process.env.TEST_HARNESS_ENABLED !== "1") {
    throw new Error(
      "Test harness disabled — set TEST_HARNESS_ENABLED=1 to run the shadowban QA check.",
    );
  }
  if (process.env.TEST_HARNESS_SECRET !== secret) {
    throw new Error("Wrong harness secret.");
  }
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days, like the auth library
const TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour, like the auth library

// The permanent-session horizon used by the migration below: 10 years,
// matching the `session` config in convex/auth.ts. Sessions are meant to
// last until the user signs out — never a timeout.
const SESSION_HORIZON_MS = 1000 * 60 * 60 * 24 * 365 * 10;

/** Insert an authSessions row and sign a JWT for it, mirroring tokens.js. */
async function mintSession(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const sessionId = await ctx.db.insert("authSessions", {
    expirationTime: Date.now() + SESSION_TTL_MS,
    userId,
  });
  const privateKey = await importPKCS8(
    process.env.JWT_PRIVATE_KEY ?? "",
    "RS256",
  );
  const issuer =
    process.env.CONVEX_SITE_URL ?? process.env.SITE_URL ?? "";
  if (issuer.length === 0) {
    throw new Error("CONVEX_SITE_URL not set — cannot mint sessions.");
  }
  return await new SignJWT({ sub: `${userId}|${sessionId}` })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience("convex")
    .setExpirationTime(new Date(Date.now() + TOKEN_TTL_MS))
    .sign(privateKey);
}

/** True when the harness is enabled on this deployment. */
export const isEnabled = query({
  handler: async () => ({
    enabled: process.env.TEST_HARNESS_ENABLED === "1",
  }),
});

/**
 * Create a throwaway QA account (role "user", verified, active) and mint a
 * real session for it. Usernames are forced under the reserved qa_ prefix so
 * they can never collide with a real account.
 */
export const createTestUser = mutation({
  args: {
    name: v.string(),
    username: v.string(),
    secret: v.string(),
    unsetProfileType: v.optional(v.boolean()),
  },
  handler: async (ctx, { name, username, secret, unsetProfileType }) => {
    requireHarness(secret);
    const normalized = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!normalized.startsWith("qa_") || normalized.length < 6) {
      throw new Error("QA usernames must start with qa_ and be at least 6 chars.");
    }
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", normalized))
      .first();
    if (existing !== null) {
      throw new Error("That username is already taken.");
    }
    // QA accounts default to the identity declaration so the full-screen
    // onboarding gate never blocks a harness browser flow. QA scripts that
    // specifically exercise the gate (profile-type-qa) pass
    // unsetProfileType: true to mint an account with NO declaration.
    const userId = await ctx.db.insert("users", {
      username: normalized,
      name: name.trim() || normalized,
      verified: true,
      role: "user",
      followersCount: 0,
      followingCount: 0,
      postsCount: 0,
      accountStatus: "active",
      ...(unsetProfileType === true ? {} : { profileType: "creator" }),
    });
    const token = await mintSession(ctx, userId);
    // A real sign-in stores BOTH the access JWT and a refresh token; the
    // browser's auth manager refetches with the refresh token right after
    // the server confirms the cached JWT (initialAuthTokenReuse defaults to
    // false), so a JWT-only minted session drops to unauthenticated within
    // milliseconds of a page load. Mint the refresh token alongside the
    // session so harness sessions behave like real logins in the browser.
    const session = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .first();
    if (session === null) {
      throw new ConvexError("Session mint failed.");
    }
    const refreshId = await ctx.db.insert("authRefreshTokens", {
      sessionId: session._id,
      expirationTime: session.expirationTime,
    });
    return {
      userId,
      username: normalized,
      token,
      refreshToken: `${refreshId}|${session._id}`,
    };
  },
});

/**
 * Delete a single notification row by id — QA cleanup for notifications
 * that land on REAL accounts (e.g. the auto-close heads-up the admin
 * receives when a QA flood closes a thread on an admin-authored post).
 * Test accounts are cascade-erased by deleteTestUser; this exists for the
 * real-account recipient case so no test trace ever outlives a run. Gated
 * by the same harness env pair as everything else in this module.
 */
export const deleteNotification = mutation({
  args: { notificationId: v.id("notifications"), secret: v.string() },
  handler: async (ctx, { notificationId, secret }) => {
    requireHarness(secret);
    const row = await ctx.db.get(notificationId);
    if (row !== null) {
      await ctx.db.delete(notificationId);
    }
    return { deleted: row !== null };
  },
});

/**
 * Drive the auto-close notification guard for a single post — the exact
 * logic the nightly sweep runs per post — with an optional backdate of
 * the last-notified marker. Lets the QA test the weekly cooldown without
 * waiting a week: backdate the marker past the cooldown and the guard
 * re-notifies; call again immediately and it stays quiet. Gated by the
 * same harness env pair as everything else in this module.
 */
/**
 * Clear a user's rolling activity budget for one action (the rateLimits
 * bookkeeping rows checkRateLimit counts against). QA needs a real
 * (non-test) actor for notification paths, and the only such account the
 * harness can mint is the real admin — whose comment budget is shared
 * with real usage and every other QA run in the same hour. A flood that
 * draws on it can collide with an overlapping run and spuriously red the
 * healthcheck, so the QA clears the admin's budget for the exact action
 * before flooding, making the flood deterministic. Only deletes
 * rate-limit bookkeeping — never touches the account or its data — and
 * is gated by the same harness env pair as everything else in this
 * module.
 */
export const clearRateLimitBudget = mutation({
  args: { secret: v.string(), userId: v.id("users"), action: v.string() },
  handler: async (ctx, { secret, userId, action }) => {
    requireHarness(secret);
    let cleared = 0;
    for (;;) {
      const rows = await ctx.db
        .query("rateLimits")
        .withIndex("by_user_action", (q) =>
          q.eq("userId", userId).eq("action", action),
        )
        .take(500);
      if (rows.length === 0) break;
      for (const row of rows) {
        await ctx.db.delete(row._id);
        cleared++;
      }
    }
    return { cleared };
  },
});

export const recheckAutoClosedNotification = mutation({
  args: {
    postId: v.id("posts"),
    secret: v.string(),
    backdateNotifiedMs: v.optional(v.number()),
  },
  handler: async (ctx, { postId, secret, backdateNotifiedMs }) => {
    requireHarness(secret);
    let post = await ctx.db.get(postId);
    if (post === null) {
      throw new Error("Post not found");
    }
    if (backdateNotifiedMs !== undefined) {
      await ctx.db.patch(postId, {
        commentsAutoClosedNotifiedAt: Date.now() - backdateNotifiedMs,
      });
      post = await ctx.db.get(postId);
      if (post === null) {
        throw new Error("Post not found");
      }
    }
    return { notified: await maybeNotifyAutoClosed(ctx, post) };
  },
});

/**
 * Erase a throwaway QA account (and its auth sessions) by id, so a run that
 * crashes before its own cleanup can still be swept. Only ever targets the
 * reserved qa_ prefix, never a real account. Gated by the same two env gates.
 */
export const deleteTestUser = mutation({
  args: { userId: v.id("users"), secret: v.string() },
  handler: async (ctx, { userId, secret }) => {
    requireHarness(secret);
    const user = await ctx.db.get(userId);
    if (user === null) {
      return { deleted: false, reason: "not-found" };
    }
    if (!user.username?.startsWith("qa_")) {
      return { deleted: false, reason: "not-qa" };
    }
    // Pre-count what the sweep will remove so callers' logs stay useful;
    // the actual erasure is eraseAccount — the SAME cascade a real account
    // deletion runs (posts + media + engagement, stories + views, comments
    // and likes left on other people's posts, follows, notifications, auth
    // records), with post/comment counts recomputed from surviving rows. A
    // QA run that skips its cleanup (crash, timeout, interrupted job) can
    // therefore never leave the user's content on the live feed again.
    const sessions = (
      await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .take(100)
    ).length;
    const posts = (
      await ctx.db
        .query("posts")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .take(500)
    ).length;
    const comments = (
      await ctx.db
        .query("comments")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .take(500)
    ).length;
    await eraseAccount(ctx, userId);
    return { deleted: true, sessions, posts, comments };
  },
});

/**
 * Mint a real session for the platform's admin (ADMIN_EMAIL), so the QA
 * check can verify silenced content is visible to moderation. Also mints
 * the refresh token for the SAME session: the browser auth client requires
 * BOTH a JWT and a refresh token in storage — a JWT-only injection makes
 * it try to refresh, find nothing, and sign out, so browser-driving QAs
 * (the workload page-up check, the INP harness's authed section) would
 * silently bounce to /auth without it. Gated by the same two env gates as
 * everything else in this module.
 */
export const mintAdminSession = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const admin = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", ADMIN_EMAIL))
      .first();
    if (admin === null) {
      throw new Error("Admin account not found on this deployment.");
    }
    const token = await mintSession(ctx, admin._id);
    const session = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", admin._id))
      .order("desc")
      .first();
    if (session === null) {
      throw new ConvexError("Session mint failed.");
    }
    const refreshId = await ctx.db.insert("authRefreshTokens", {
      sessionId: session._id,
      expirationTime: session.expirationTime,
    });
    return {
      userId: admin._id,
      token,
      refreshToken: `${refreshId}|${session._id}`,
    };
  },
});

/**
 * Simulate the admin's IP CHANGING between verifications — the exact
 * scenario the backend-verified binding must catch. Rewrites the current
 * caller's adminIpBindings row (if any) to a sentinel hash that can never
 * equal the real IP hash the verify endpoint will compute, so the NEXT
 * /admin/ip/verify call from the real client IP must report revoked and
 * delete the session. Lets the admin-ip QA prove the cross-IP revoke path
 * end to end. Gated by the same two env gates as the rest of the module.
 */
export const simulateAdminIpChange = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const sessionId = await getAuthSessionId(ctx);
    if (sessionId === null) {
      throw new ConvexError("Caller is not authenticated.");
    }
    const binding = await ctx.db
      .query("adminIpBindings")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (binding === null) {
      return { tampered: false, reason: "no-binding" };
    }
    await ctx.db.patch(binding._id, {
      // A sentinel that no real IP hash can equal (a raw string, not the
      // salted sha256 the verify endpoint produces).
      ipHash: "simulated:different-ip",
      verifiedAt: Date.now(),
    });
    return { tampered: true };
  },
});

/**
 * Age the caller's adminIpBindings row to the distant past so the binding
 * counts as STALE — requireAdmin must then refuse admin power even though
 * the JWT is valid, proving enforcement isn't just client-side. Gated by
 * the same two env gates as the rest of the module.
 */
export const expireAdminIpBinding = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const sessionId = await getAuthSessionId(ctx);
    if (sessionId === null) {
      throw new ConvexError("Caller is not authenticated.");
    }
    const binding = await ctx.db
      .query("adminIpBindings")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (binding === null) {
      return { expired: false, reason: "no-binding" };
    }
    await ctx.db.patch(binding._id, {
      verifiedAt: 0, // older than any TTL — effectively never verified
    });
    return { expired: true };
  },
});

/**
 * Mint a real session for any existing account by its stored email, so the
 * QA check can verify the salted-hash pipeline against a real
 * email-bearing record (e.g. a pre-existing test account). Gated by the
 * same two env gates as everything else in this module.
 */
export const mintSessionForEmail = mutation({
  args: { email: v.string(), secret: v.string() },
  handler: async (ctx, { email, secret }) => {
    requireHarness(secret);
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (user === null) {
      throw new Error("No account with that email on this deployment.");
    }
    const token = await mintSession(ctx, user._id);
    return { userId: user._id, token };
  },
});

/**
 * Mint a real refresh token for an existing harness session, formatted
 * exactly like the auth library's (`${refreshTokenId}|${sessionId}`). The
 * browser auth client requires BOTH a JWT and a refresh token in storage;
 * a JWT-only injection makes it try to refresh, find nothing, and sign out.
 * Gated by the same two env gates as the rest of the module.
 */
export const mintSessionRefreshToken = mutation({
  args: { userId: v.id("users"), secret: v.string() },
  handler: async (ctx, { userId, secret }) => {
    requireHarness(secret);
    const user = await ctx.db.get(userId);
    if (user === null || !user.username?.startsWith("qa_")) {
      throw new ConvexError("Only qa_ harness accounts can receive refresh tokens.");
    }
    const session = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .first();
    if (session === null) {
      throw new ConvexError("No auth session found for this account.");
    }
    const refreshId = await ctx.db.insert("authRefreshTokens", {
      sessionId: session._id,
      expirationTime: session.expirationTime,
    });
    return { refreshToken: `${refreshId}|${session._id}`, sessionId: session._id };
  },
});

/**
 * Mint a fresh session + refresh token for an existing qa_ harness account
 * by username. JWT access tokens are short-lived (1h) and the QA scripts
 * hold them across runs, so a long walk needs a way to re-mint without
 * recreating the account (which would orphan its posts/stories). Gated by
 * the same two env gates as everything else in this module.
 */
export const mintSessionForQaUsername = mutation({
  args: { username: v.string(), secret: v.string() },
  handler: async (ctx, { username, secret }) => {
    requireHarness(secret);
    const normalized = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!normalized.startsWith("qa_")) {
      throw new ConvexError("Only qa_ harness accounts can be re-minted.");
    }
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", normalized))
      .first();
    if (user === null) {
      throw new ConvexError("No qa_ account with that username.");
    }
    const token = await mintSession(ctx, user._id);
    const session = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();
    if (session === null) {
      throw new ConvexError("Session mint failed.");
    }
    const refreshId = await ctx.db.insert("authRefreshTokens", {
      sessionId: session._id,
      expirationTime: session.expirationTime,
    });
    return {
      userId: user._id,
      username: normalized,
      token,
      refreshToken: `${refreshId}|${session._id}`,
    };
  },
});

/**
 * One-time migration: push every existing auth session and refresh token
 * out to the permanent 10-year horizon. Sessions created before the
 * `session` config in convex/auth.ts took effect carry the library's old
 * 30-day default and would otherwise log those members out automatically;
 * this converges them so no existing user hits a timeout. Idempotent —
 * rows already beyond the horizon are left untouched, so re-running is
 * harmless. Gated by the same two env gates as the rest of the module.
 */
export const extendSessionLifetimes = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    try {
      return await extendSessionLifetimesImpl(ctx, secret);
    } catch (e) {
      // Convex masks plain Error messages as "Server Error"; rethrow as a
      // ConvexError so the runner script reports the real reason.
      throw new ConvexError(e instanceof Error ? e.message : String(e));
    }
  },
});

async function extendSessionLifetimesImpl(
  ctx: MutationCtx,
  secret: string,
): Promise<{ sessions: number; tokens: number; prefs: number }> {
  requireHarness(secret);
  const horizon = Date.now() + SESSION_HORIZON_MS;
  const sessions = await extendTable(ctx, "authSessions", horizon);
  const tokens = await extendTable(ctx, "authRefreshTokens", horizon);
  const prefs = await sweepOrphanPrefs(ctx);
  return { sessions, tokens, prefs };
}

/**
 * Delete sessionPrefs rows whose session no longer exists. The auth
 * library's own sign-out / expiry cleanup deletes the session row but knows
 * nothing about sessionPrefs, so an opt-out marker can outlive its session;
 * this converges them (harmless — the audit only ever consults prefs for
 * sessions that still exist).
 */
async function sweepOrphanPrefs(ctx: MutationCtx): Promise<number> {
  let swept = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows = await ctx.db
      .query("sessionPrefs")
      .order("asc")
      .filter((q) =>
        q.gt(q.field("_id"), (cursor ?? "") as Id<"sessionPrefs">),
      )
      .take(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      if ((await ctx.db.get(row.sessionId)) === null) {
        await ctx.db.delete(row._id);
        swept++;
      }
      cursor = row._id;
    }
  }
  return swept;
}

/**
 * Walk one auth-library table and push every row's expirationTime out to
 * the horizon. Convex allows only a single `paginate` per function, so
 * this pages with take() + an _id cursor filter instead — fully general
 * and visits every row exactly once regardless of table size.
 */
async function extendTable(
  ctx: MutationCtx,
  table: "authSessions" | "authRefreshTokens",
  horizon: number,
): Promise<number> {
  let extended = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows = await ctx.db
      .query(table)
      .order("asc")
      .filter((q) =>
        q.gt(
          q.field("_id"),
          (cursor ?? "") as Id<"authSessions"> | Id<"authRefreshTokens">,
        ),
      )
      .take(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.expirationTime < horizon) {
        await ctx.db.patch(row._id, { expirationTime: horizon });
        extended++;
      }
      cursor = row._id;
    }
  }
  return extended;
}

/**
 * Reconcile every user's postsCount against the actual posts table. The
 * user-facing deletePost used to remove the row without decrementing the
 * counter, so accounts that deleted their own posts showed an inflated
 * "posts made" number (the admin's moderatePost always decremented — the
 * member path didn't). Idempotent: patches each drifted user to the real
 * row count and returns what changed, so the count-drift QA can assert
 * clean state (and this can be re-run any time). Gated by the same two
 * env gates as the rest of the module.
 */
export const reconcilePostsCounts = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    try {
      requireHarness(secret);
      const fixed: Array<{ userId: Id<"users">; was: number; now: number }> =
        [];
      let usersSeen = 0;
      let cursor: string | null = null;
      for (;;) {
        const users = await ctx.db
          .query("users")
          .order("asc")
          .filter((q) =>
            q.gt(q.field("_id"), (cursor ?? "") as Id<"users">),
          )
          .take(500);
        if (users.length === 0) break;
        for (const user of users) {
          usersSeen++;
          const actual = await countPostsByAuthor(ctx, user._id);
          const was = user.postsCount ?? 0;
          if (was !== actual) {
            await ctx.db.patch(user._id, { postsCount: actual });
            fixed.push({ userId: user._id, was, now: actual });
          }
          cursor = user._id;
        }
      }
      return { fixed, usersSeen };
    } catch (e) {
      // Convex masks plain Error messages as "Server Error"; rethrow as a
      // ConvexError so the runner script reports the real reason.
      throw new ConvexError(e instanceof Error ? e.message : String(e));
    }
  },
});

/**
 * Count one author's posts exactly, without loading them all into memory:
 * pages the by_author index in 500-row chunks with an _id cursor filter,
 * the same bounded pattern extendTable uses. (The deployed Convex runtime
 * has no query `.count()`, and a fixed take() cap could undercount a heavy
 * account.)
 */
async function countPostsByAuthor(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows = await ctx.db
      .query("posts")
      .withIndex("by_author", (q) => q.eq("authorId", userId))
      .order("asc")
      .filter((q) => q.gt(q.field("_id"), (cursor ?? "") as Id<"posts">))
      .take(500);
    if (rows.length === 0) break;
    total += rows.length;
    cursor = rows[rows.length - 1]._id;
  }
  return total;
}

/**
 * Count one direction of a user's follows exactly, without loading them
 * all into memory: pages the relevant follows index in 500-row chunks with
 * an _id cursor filter, the same bounded pattern countPostsByAuthor uses.
 * (The deployed Convex runtime has no query `.count()`.)
 */
async function countFollowRows(
  ctx: MutationCtx,
  kind: "followers" | "following",
  userId: Id<"users">,
): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows =
      kind === "followers"
        ? await ctx.db
            .query("follows")
            .withIndex("by_following", (q) => q.eq("followingId", userId))
            .order("asc")
            .filter((q) =>
              q.gt(q.field("_id"), (cursor ?? "") as Id<"follows">),
            )
            .take(500)
        : await ctx.db
            .query("follows")
            .withIndex("by_follower", (q) => q.eq("followerId", userId))
            .order("asc")
            .filter((q) =>
              q.gt(q.field("_id"), (cursor ?? "") as Id<"follows">),
            )
            .take(500);
    if (rows.length === 0) break;
    total += rows.length;
    cursor = rows[rows.length - 1]._id;
  }
  return total;
}

/**
 * Count one post's engagement rows exactly (likes, comments, or shares),
 * without loading them all into memory: pages the by_post index in
 * 500-row chunks with an _id cursor filter, the same bounded pattern the
 * other count helpers use. (The deployed Convex runtime has no query
 * `.count()`.)
 */
async function countByPostIndex(
  ctx: MutationCtx,
  table: "likes" | "comments" | "shares",
  postId: Id<"posts">,
): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_post", (q) => q.eq("postId", postId))
      .order("asc")
      .filter((q) =>
        q.gt(
          q.field("_id"),
          (cursor ?? "") as Id<"likes"> | Id<"comments"> | Id<"shares">,
        ),
      )
      .take(500);
    if (rows.length === 0) break;
    total += rows.length;
    cursor = rows[rows.length - 1]._id;
  }
  return total;
}

/**
 * Count one comment's like rows exactly, without loading them all into
 * memory — the same bounded cursor pattern as countByPostIndex, but over
 * the commentLikes table's by_comment index.
 */
async function countByCommentIndex(
  ctx: MutationCtx,
  commentId: Id<"comments">,
): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows = await ctx.db
      .query("commentLikes")
      .withIndex("by_comment", (q) => q.eq("commentId", commentId))
      .order("asc")
      .filter((q) =>
        q.gt(q.field("_id"), (cursor ?? "") as Id<"commentLikes">),
      )
      .take(500);
    if (rows.length === 0) break;
    total += rows.length;
    cursor = rows[rows.length - 1]._id;
  }
  return total;
}

/**
 * Count the replies hanging under one comment — the same bounded cursor
 * pattern as countByCommentIndex, but over the comments table's by_parent
 * index. Drives the comments.replyCount reconcile.
 */
async function countByParentIndex(
  ctx: MutationCtx,
  parentId: Id<"comments">,
): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const rows = await ctx.db
      .query("comments")
      .withIndex("by_parent", (q) => q.eq("parentId", parentId))
      .order("asc")
      .filter((q) =>
        q.gt(q.field("_id"), (cursor ?? "") as Id<"comments">),
      )
      .take(500);
    if (rows.length === 0) break;
    total += rows.length;
    cursor = rows[rows.length - 1]._id;
  }
  return total;
}

/**
 * Sweep orphan engagement rows and reconcile every post's engagement
 * counters against the actual tables. Two jobs:
 *
 * 1. Orphan sweep — likes/comments/shares rows whose post no longer
 *    exists (left behind by post deletions made before the delete paths
 *    swept them, or by interrupted erasures). Each is deleted and
 *    reported, so the admin dashboard's totals can never be inflated by
 *    engagement on deleted posts.
 *
 * 2. Counter reconcile — posts.likeCount / commentCount / shareCount are
 *    denormalized counters incremented on like/comment/share and
 *    decremented on unlike; posts.reportCount is the number of open
 *    (open/in_review) support tickets targeting the post; and
 *    comments.likeCount is the denormalized tally of its commentLikes
 *    rows. Every post and comment is patched to the exact surviving-row
 *    totals. Phantom engagement rows (a sandboxed account's absorbed
 *    like/comment) are counted like the follows reconcile counts phantom
 *    follows — the rows table is truth, matching the platform's unsilence
 *    behavior of retroactively counting phantom follows.
 *
 * Idempotent — a clean run changes nothing and returns empty lists, so
 * the count-drift QA can assert clean state and this can be re-run any
 * time. Gated by the same two env gates as the rest of the module.
 */
export const reconcileEngagementCounts = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    try {
      requireHarness(secret);
      const orphanLikes: Array<{ rowId: Id<"likes">; postId: Id<"posts"> }> =
        [];
      const orphanComments: Array<{
        rowId: Id<"comments">;
        postId: Id<"posts">;
      }> = [];
      const orphanShares: Array<{ rowId: Id<"shares">; postId: Id<"posts"> }> =
        [];
      const orphanCommentLikes: Array<{
        rowId: Id<"commentLikes">;
        commentId: Id<"comments">;
      }> = [];
      let likesSeen = 0;
      let commentsSeen = 0;
      let sharesSeen = 0;
      let commentLikesSeen = 0;
      let cursor: string | null = null;
      for (;;) {
        const rows = await ctx.db
          .query("likes")
          .order("asc")
          .filter((q) => q.gt(q.field("_id"), (cursor ?? "") as Id<"likes">))
          .take(500);
        if (rows.length === 0) break;
        for (const row of rows) {
          likesSeen++;
          if ((await ctx.db.get(row.postId)) === null) {
            await ctx.db.delete(row._id);
            orphanLikes.push({ rowId: row._id, postId: row.postId });
          }
          cursor = row._id;
        }
      }
      let commentCursor: string | null = null;
      for (;;) {
        const rows = await ctx.db
          .query("comments")
          .order("asc")
          .filter((q) =>
            q.gt(q.field("_id"), (commentCursor ?? "") as Id<"comments">),
          )
          .take(500);
        if (rows.length === 0) break;
        for (const row of rows) {
          commentsSeen++;
          const post = await ctx.db.get(row.postId);
          if (post === null) {
            await ctx.db.delete(row._id);
            orphanComments.push({ rowId: row._id, postId: row.postId });
          } else if (row.parentId !== undefined) {
            // Replies: the parent must still exist on the same post (left
            // behind by interrupted erasures or stale re-roots). Orphans
            // are deleted — with their likes — like any other orphan.
            const parent = await ctx.db.get(row.parentId);
            if (parent === null || parent.postId !== row.postId) {
              await sweepCommentLikes(ctx, row._id);
              await ctx.db.delete(row._id);
              orphanComments.push({ rowId: row._id, postId: row.postId });
            }
          }
          commentCursor = row._id;
        }
      }
      // Comment likes: rows whose comment no longer exists (left behind by
      // comment deletions made before the sweep path was added) are removed
      // the same way.
      let commentLikeCursor: string | null = null;
      for (;;) {
        const rows = await ctx.db
          .query("commentLikes")
          .order("asc")
          .filter((q) =>
            q.gt(
              q.field("_id"),
              (commentLikeCursor ?? "") as Id<"commentLikes">,
            ),
          )
          .take(500);
        if (rows.length === 0) break;
        for (const row of rows) {
          commentLikesSeen++;
          if ((await ctx.db.get(row.commentId)) === null) {
            await ctx.db.delete(row._id);
            orphanCommentLikes.push({ rowId: row._id, commentId: row.commentId });
          }
          commentLikeCursor = row._id;
        }
      }
      let shareCursor: string | null = null;
      for (;;) {
        const rows = await ctx.db
          .query("shares")
          .order("asc")
          .filter((q) =>
            q.gt(q.field("_id"), (shareCursor ?? "") as Id<"shares">),
          )
          .take(500);
        if (rows.length === 0) break;
        for (const row of rows) {
          sharesSeen++;
          if ((await ctx.db.get(row.postId)) === null) {
            await ctx.db.delete(row._id);
            orphanShares.push({ rowId: row._id, postId: row.postId });
          }
          shareCursor = row._id;
        }
      }
      // One pass over the tickets table builds the truthful reportCount
      // for every post: the number of open/in_review tickets targeting it.
      const openReports = new Map<string, number>();
      let ticketCursor: string | null = null;
      for (;;) {
        const rows = await ctx.db
          .query("supportTickets")
          .order("asc")
          .filter((q) =>
            q.gt(q.field("_id"), (ticketCursor ?? "") as Id<"supportTickets">),
          )
          .take(500);
        if (rows.length === 0) break;
        for (const row of rows) {
          if (
            row.postId !== undefined &&
            (row.status === "open" || row.status === "in_review")
          ) {
            openReports.set(row.postId, (openReports.get(row.postId) ?? 0) + 1);
          }
          ticketCursor = row._id;
        }
      }
      const fixed: Array<{
        postId: Id<"posts">;
        was: {
          likeCount: number;
          commentCount: number;
          shareCount: number;
          reportCount: number;
        };
        now: {
          likeCount: number;
          commentCount: number;
          shareCount: number;
          reportCount: number;
        };
      }> = [];
      // Comment likeCounts are denormalized the same way as the post
      // counters, so they get the same reconcile: every comment is patched
      // to the count of its surviving commentLikes rows.
      const fixedComments: Array<{
        commentId: Id<"comments">;
        was: { likeCount: number; replyCount: number };
        now: { likeCount: number; replyCount: number };
      }> = [];
      let commentsReconciled = 0;
      let postsSeen = 0;
      let postCursor: string | null = null;
      for (;;) {
        const posts = await ctx.db
          .query("posts")
          .order("asc")
          .filter((q) =>
            q.gt(q.field("_id"), (postCursor ?? "") as Id<"posts">),
          )
          .take(500);
        if (posts.length === 0) break;
        for (const post of posts) {
          postsSeen++;
          const [likeCount, commentCount, shareCount] = await Promise.all([
            countByPostIndex(ctx, "likes", post._id),
            countByPostIndex(ctx, "comments", post._id),
            countByPostIndex(ctx, "shares", post._id),
          ]);
          const reportCount = openReports.get(post._id) ?? 0;
          const was = {
            likeCount: post.likeCount ?? 0,
            commentCount: post.commentCount ?? 0,
            shareCount: post.shareCount ?? 0,
            reportCount: post.reportCount ?? 0,
          };
          const now = { likeCount, commentCount, shareCount, reportCount };
          if (
            was.likeCount !== now.likeCount ||
            was.commentCount !== now.commentCount ||
            was.shareCount !== now.shareCount ||
            was.reportCount !== now.reportCount
          ) {
            await ctx.db.patch(post._id, now);
            fixed.push({ postId: post._id, was, now });
          }
          postCursor = post._id;
        }
      }
      let commentReconcileCursor: string | null = null;
      for (;;) {
        const comments = await ctx.db
          .query("comments")
          .order("asc")
          .filter((q) =>
            q.gt(
              q.field("_id"),
              (commentReconcileCursor ?? "") as Id<"comments">,
            ),
          )
          .take(500);
        if (comments.length === 0) break;
        for (const comment of comments) {
          commentsReconciled++;
          const likeCount = await countByCommentIndex(ctx, comment._id);
          const replyCount = await countByParentIndex(ctx, comment._id);
          const was = { likeCount: comment.likeCount ?? 0, replyCount: comment.replyCount ?? 0 };
          const now = { likeCount, replyCount };
          if (was.likeCount !== now.likeCount || was.replyCount !== now.replyCount) {
            await ctx.db.patch(comment._id, now);
            fixedComments.push({ commentId: comment._id, was, now });
          }
          commentReconcileCursor = comment._id;
        }
      }
      return {
        orphanLikes,
        orphanComments,
        orphanShares,
        orphanCommentLikes,
        likesSeen,
        commentsSeen,
        sharesSeen,
        commentLikesSeen,
        fixed,
        postsSeen,
        fixedComments,
        commentsReconciled,
      };
    } catch (e) {
      // Convex masks plain Error messages as "Server Error"; rethrow as a
      // ConvexError so the runner script reports the real reason.
      throw new ConvexError(e instanceof Error ? e.message : String(e));
    }
  },
});

/**
 * Sweep orphan follow rows and reconcile every user's followers/following
 * counters against the follows table. Two jobs, one pass each:
 *
 * 1. Orphan sweep — a follows row whose follower OR following account no
 *    longer exists (left behind when a QA account was removed by a path
 *    that skipped the full erasure, or by an interrupted cleanup). Each is
 *    deleted and reported, so "followers/following of deleted test users"
 *    can never keep the dashboard's totals lying.
 *
 * 2. Counter reconcile — same denormalized-counter discipline as
 *    reconcilePostsCounts: users.followersCount / followingCount are
 *    incremented on follow and decremented on unfollow, so any write path
 *    that touched the follows table without the counters (phantom follows,
 *    erasure edge cases) leaves drift. Every user is patched to the exact
 *    surviving-row count.
 *
 * Idempotent — a clean run changes nothing and returns empty lists, so
 * the count-drift QA can assert clean state and this can be re-run any
 * time. Gated by the same two env gates as the rest of the module.
 */
export const reconcileFollowCounts = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    try {
      requireHarness(secret);
      const orphanFollows: Array<{
        rowId: Id<"follows">;
        followerId: Id<"users">;
        followingId: Id<"users">;
      }> = [];
      let followsSeen = 0;
      let cursor: string | null = null;
      for (;;) {
        const rows = await ctx.db
          .query("follows")
          .order("asc")
          .filter((q) =>
            q.gt(q.field("_id"), (cursor ?? "") as Id<"follows">),
          )
          .take(500);
        if (rows.length === 0) break;
        for (const row of rows) {
          followsSeen++;
          const [follower, following] = await Promise.all([
            ctx.db.get(row.followerId),
            ctx.db.get(row.followingId),
          ]);
          if (follower === null || following === null) {
            await ctx.db.delete(row._id);
            orphanFollows.push({
              rowId: row._id,
              followerId: row.followerId,
              followingId: row.followingId,
            });
          }
          cursor = row._id;
        }
      }
      const fixed: Array<{
        userId: Id<"users">;
        wasFollowers: number;
        nowFollowers: number;
        wasFollowing: number;
        nowFollowing: number;
      }> = [];
      let usersSeen = 0;
      let userCursor: string | null = null;
      for (;;) {
        const users = await ctx.db
          .query("users")
          .order("asc")
          .filter((q) =>
            q.gt(q.field("_id"), (userCursor ?? "") as Id<"users">),
          )
          .take(500);
        if (users.length === 0) break;
        for (const user of users) {
          usersSeen++;
          const followers = await countFollowRows(ctx, "followers", user._id);
          const following = await countFollowRows(ctx, "following", user._id);
          const wasFollowers = user.followersCount ?? 0;
          const wasFollowing = user.followingCount ?? 0;
          if (wasFollowers !== followers || wasFollowing !== following) {
            await ctx.db.patch(user._id, {
              followersCount: followers,
              followingCount: following,
            });
            fixed.push({
              userId: user._id,
              wasFollowers,
              nowFollowers: followers,
              wasFollowing,
              nowFollowing: following,
            });
          }
          userCursor = user._id;
        }
      }
      return { orphanFollows, followsSeen, fixed, usersSeen };
    } catch (e) {
      // Convex masks plain Error messages as "Server Error"; rethrow as a
      // ConvexError so the runner script reports the real reason.
      throw new ConvexError(e instanceof Error ? e.message : String(e));
    }
  },
});

/**
 * Purge QA traces so no test data ever lingers on a real deployment.
 *
 * The QA suite creates reserved-prefix accounts (`qa_*`, `pwtest*`, and
 * the signup e2e's `pw_e2e_*` — deliberately assignable so the real-flow
 * test can register it) and normally erases them with the full admin
 * sweep, but the one-way removal log keeps an audit row for every erasure
 * — including test sweeps — so the log fills up with test-user entries
 * the moment any QA runs.
 *
 * This harness-gated mutation deletes removalLog rows whose username
 * carries a reserved test prefix, and reports what it swept so a QA gate
 * can assert the site is test-free. Only the removal log is touched: real
 * moderation entries (real usernames) are one-way and never deleted.
 * Gated by the same two env gates as the rest of the module.
 */
export const purgeTestTraces = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const entries = await ctx.db.query("removalLog").collect();
    const testUsername = /^(qa_|pwtest|pw_e2e_)/i;
    const purged: Array<{ username: string | null; createdAt: number }> = [];
    for (const entry of entries) {
      if (entry.username && testUsername.test(entry.username)) {
        await ctx.db.delete(entry._id);
        purged.push({ username: entry.username, createdAt: entry._creationTime });
      }
    }
    return { purgedCount: purged.length, purged };
  },
});

/**
 * Page of notification ids for the dangling-row sweep, in _id order.
 * Paginated because the sweep must run in bounded executions: a single
 * mutation scanning the whole table exceeds Convex's per-function read
 * limits once real accounts accumulate notifications (the old full-table
 * sweep tripped "Too many documents read in a single function
 * execution" at ~6.4k rows). The caller walks pages with
 * purgeNotificationChunk until isDone — every execution stays small no
 * matter how large the table grows. Gated by the same two env gates as
 * the rest of the module.
 */
export const listNotificationsForPurge = query({
  args: { secret: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, { secret, cursor }) => {
    requireHarness(secret);
    return await ctx.db
      .query("notifications")
      .paginate({ cursor: cursor ?? null, numItems: 400 });
  },
});

/**
 * Check one page of notification rows (from listNotificationsForPurge)
 * for dangling references — a post, shared post, actor, or recipient
 * that no longer exists — and delete the dead rows. Bounded to the passed
 * ids so each execution stays well under Convex's per-function read/write
 * limits no matter how large the table grows: the caller walks pages via
 * listNotificationsForPurge and hands each page to this mutation.
 * Gated by the same harness env pair as everything else in this module.
 */
export const purgeNotificationChunk = mutation({
  args: { secret: v.string(), ids: v.array(v.id("notifications")) },
  handler: async (ctx, { secret, ids }) => {
    requireHarness(secret);
    const purged: Array<{
      id: Id<"notifications">;
      type: string;
      reason: string;
    }> = [];
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row === null) continue;
      let reason: string | null = null;
      if (row.postId !== undefined) {
        const post = await ctx.db.get(row.postId);
        if (post === null) reason = "missing-post";
      }
      // dm-share / comment-share rows preview the SHARED post, which
      // rides in sharedPostId while postId stays the host (thread or DM
      // the share landed in). The host can survive while the shared post
      // is gone — the preview then dangles even though every other
      // reference resolves. Sweep that class too.
      if (reason === null && row.sharedPostId !== undefined) {
        const shared = await ctx.db.get(row.sharedPostId);
        if (shared === null) reason = "missing-shared-post";
      }
      // Comment-share rows preview the SHARED comment in sharedCommentId
      // — same dangling class: sweep it when the original comment dies.
      if (reason === null && row.sharedCommentId !== undefined) {
        const shared = await ctx.db.get(row.sharedCommentId);
        if (shared === null) reason = "missing-shared-comment";
      }
      if (reason === null && row.actorId !== undefined) {
        const actor = await ctx.db.get(row.actorId);
        if (actor === null) reason = "missing-actor";
      }
      if (reason === null) {
        const recipient = await ctx.db.get(row.userId);
        if (recipient === null) reason = "missing-recipient";
      }
      if (reason !== null) {
        await ctx.db.delete(id);
        purged.push({ id, type: row.type, reason });
      }
    }
    return { purgedCount: purged.length, purged };
  },
});

/**
 * Count reserved-prefix test traces across the tables QA touches: users
 * and one-way removal-log entries. The "never keep test stuff on the site"
 * gate — CI asserts every count is zero, so a leftover qa_ account or a
 * test erasure polluting the audit log fails the build instead of shipping.
 * Gated by the same two env gates as the rest of the module.
 */
export const getTestTraceCounts = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const testUsername = /^(qa_|pwtest|pw_e2e_)/i;
    const [users, removals] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("removalLog").collect(),
    ]);
    const testUsers = users.filter((u) => u.username && testUsername.test(u.username));
    const testRemovals = removals.filter((e) => e.username && testUsername.test(e.username));
    return {
      testUsers: testUsers.map((u) => u.username),
      testRemovalEntries: testRemovals.map((e) => e.username ?? "?"),
    };
  },
});

/**
 * Read the calling session's expiry horizon: the authSessions row's
 * expirationTime and how far out it is from now. Lets the session-lifetime
 * QA assert both paths of the "Keep me signed in" toggle against the real
 * rows — the permanent 10-year default and the opted-down 30-day session.
 * Gated by the same two env gates as the rest of the module.
 */
export const getCurrentSessionLifetime = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const sessionId = await getAuthSessionId(ctx);
    if (sessionId === null) {
      return null;
    }
    const session = await ctx.db.get(sessionId);
    if (session === null) {
      return null;
    }
    const now = Date.now();
    return {
      expirationTime: session.expirationTime,
      now,
      remainingMs: Math.max(0, session.expirationTime - now),
    };
  },
});

/** The regression horizon the CI audit enforces: one year. */
const AUDIT_HORIZON_MS = 1000 * 60 * 60 * 24 * 365;

/**
 * CI regression gate for the permanent-session guarantee.
 *
 * Walks every authSessions and authRefreshTokens row and reports any that
 * expire within the next year. A row that expires that soon is a silent
 * regression — someone reverted the `session` config to the library's
 * 30-day default, or a session escaped the migration — and it would log a
 * member out automatically, which PureWire never does.
 *
 * Deliberate exceptions, neither of which trips the gate:
 * - Sessions opted down by their owner ("Keep me signed in" off) carry a
 *   sessionPrefs row — an explicit user choice, not a regression.
 * - Harness sessions minted for qa_ throwaway accounts use a short TTL by
 *   design (see mintSession) and are deleted at the end of every QA run.
 *
 * Gated by the same two env gates as the rest of the module. The runner
 * scripts/session-audit.mjs exits 1 when violations exist.
 */
export const auditSessionLifetimes = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    try {
      return await auditSessionLifetimesImpl(ctx, secret);
    } catch (e) {
      // Convex masks plain Error messages as "Server Error"; rethrow as a
      // ConvexError so the runner script reports the real reason.
      throw new ConvexError(e instanceof Error ? e.message : String(e));
    }
  },
});

const VIOLATION_CAP = 100;

async function auditSessionLifetimesImpl(ctx: QueryCtx, secret: string) {
  requireHarness(secret);
  const now = Date.now();
  const horizon = now + AUDIT_HORIZON_MS;

  const violations: Array<{
    table: "authSessions" | "authRefreshTokens";
    id: string;
    expirationTime: number;
    userId: string | null;
    sessionId: string | null;
  }> = [];
  let sessions = 0;
  let tokens = 0;

  /** True when this session is a deliberate opt-out ("Keep me signed in"
   * off) or belongs to a qa_ harness account. Only candidate violations —
   * rows already expiring within a year — trigger the lookup, so a clean
   * run (the normal case) does zero extra reads. */
  async function isExempt(
    sessionId: Id<"authSessions">,
    ownerId: Id<"users"> | null,
  ) {
    // Deliberate opt-out: the owner chose a short 30-day session. Only
    // remember=false rows are ever written, but check the flag anyway so a
    // hypothetical remember=true row can never wrongly exempt a session.
    const pref = await ctx.db
      .query("sessionPrefs")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (pref !== null && !pref.remember) {
      return true;
    }
    // QA scaffolding: sessions minted for qa_ throwaway accounts use a
    // short TTL by design and are deleted at the end of each QA run.
    if (ownerId !== null) {
      const owner = await ctx.db.get(ownerId);
      if (owner !== null && owner.username?.startsWith("qa_")) {
        return true;
      }
    }
    return false;
  }

  // Walk authSessions with take() + an _id cursor (Convex allows only a
  // single paginate per function — this visits every row exactly once).
  const sessionOwner = new Map<string, Id<"users">>(); // sessionId -> userId
  let cursor: string | null = null;
  for (;;) {
    const rows = await ctx.db
      .query("authSessions")
      .order("asc")
      .filter((q) =>
        q.gt(q.field("_id"), (cursor ?? "") as Id<"authSessions">),
      )
      .take(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      sessions++;
      sessionOwner.set(row._id, row.userId);
      if (
        row.expirationTime < horizon &&
        violations.length < VIOLATION_CAP &&
        !(await isExempt(row._id, row.userId))
      ) {
        violations.push({
          table: "authSessions",
          id: row._id,
          expirationTime: row.expirationTime,
          userId: row.userId,
          sessionId: null,
        });
      }
      cursor = row._id;
    }
  }

  // Walk authRefreshTokens the same way, resolving each token's owner
  // session to apply the same opt-out / qa_ exemptions.
  let tokenCursor: string | null = null;
  for (;;) {
    const rows = await ctx.db
      .query("authRefreshTokens")
      .order("asc")
      .filter((q) =>
        q.gt(q.field("_id"), (tokenCursor ?? "") as Id<"authRefreshTokens">),
      )
      .take(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      tokens++;
      const ownerId = sessionOwner.get(row.sessionId);
      if (
        row.expirationTime < horizon &&
        violations.length < VIOLATION_CAP &&
        !(await isExempt(row.sessionId, ownerId ?? null))
      ) {
        violations.push({
          table: "authRefreshTokens",
          id: row._id,
          expirationTime: row.expirationTime,
          userId: ownerId ?? null,
          sessionId: row.sessionId,
        });
      }
      tokenCursor = row._id;
    }
  }

  return {
    checkedAt: now,
    horizonMs: AUDIT_HORIZON_MS,
    sessions,
    tokens,
    violations,
    truncated: violations.length >= VIOLATION_CAP,
  };
}

/**
 * Full silent-moderation state for a QA account: the current (decayed) flag
 * total, the lifetime total, whether the account is shadowbanned, and the
 * raw silentFlagEvents log. The script asserts against this.
 */
export const getTestUserState = query({
  args: { userId: v.id("users"), secret: v.string() },
  handler: async (ctx, { userId, secret }) => {
    requireHarness(secret);
    const user = await ctx.db.get(userId);
    if (user === null) {
      return null;
    }
    const events = await ctx.db
      .query("silentFlagEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    return {
      username: user.username,
      shadowban: user.shadowban ?? false,
      silentFlags: user.silentFlags ?? 0,
      lifetimeSilentFlags: user.lifetimeSilentFlags ?? 0,
      accountStatus: user.accountStatus ?? "active",
      // When a time-limited suspension lifts on its own — the QA asserts
      // this is set while suspended and cleared after reinstate/expiry.
      suspendedUntil: user.suspendedUntil ?? null,
      events: events.map((e) => ({
        reason: e.reason,
        points: e.points,
        source: e.source ?? null,
        createdAt: e._creationTime,
      })),
    };
  },
});

/**
 * Deterministic, cache-free read of whether a QA fixture leaked onto the
 * public crawl surface: runs the exact same internal queries the sitemap
 * endpoint serves and reports whether the given test post and profile are
 * in them. The QA-isolation check asserts both are false, so a live test
 * run can never pollute Google's index. (Fetching the HTTP sitemap would
 * be cache-prone; running the source queries is exact.)
 *
 * Gated by the same two env gates as the rest of the harness.
 */
export const qaIsolationSnapshot = query({
  args: {
    secret: v.string(),
    testUserId: v.id("users"),
    testUsername: v.string(),
    testPostId: v.id("posts"),
    testStoryId: v.optional(v.id("stories")),
  },
  handler: async (ctx, { secret, testUserId, testUsername, testPostId, testStoryId }) => {
    requireHarness(secret);
    // Explicitly shaped (the established links.ts / media.ts pattern): the
    // handler's return type must not flow through the generated `internal`
    // namespace, or its inference resolves back through `typeof testHarness`
    // into this query's own initializer (TS7022) and poisons the whole app.
    const [posts, users] = (await Promise.all([
      ctx.runQuery(internal.posts.listPublicPostsForSitemap),
      ctx.runQuery(internal.users.listPublicUsersForSitemap),
    ])) as unknown as [
      { id: Id<"posts">; lastmod: number }[],
      { username: string; lastmod: number }[],
    ];
    // The story row must still EXIST (so the isolation checks aren't
    // vacuous) while every production surface hides it.
    const story =
      testStoryId !== undefined ? await ctx.db.get(testStoryId) : null;
    return {
      postInSitemap: posts.some((p) => p.id === testPostId),
      userInSitemap: users.some((u) => u.username === testUsername),
      sitemapPostCount: posts.length,
      sitemapUserCount: users.length,
      storyExists: story !== null,
      testUserId,
    };
  },
});

/**
 * Harness-gated: every QA/throwaway account, for the nightly cleanup sweep
 * (scripts/cleanup-test-users.mjs). The sweep previously found its targets
 * by paging the admin's listUsers — but listUsers now hides QA accounts
 * from the admin surface, so the maintenance path gets its own dedicated
 * (secret-gated) reader instead. Same reserved prefixes as testAuthorIds.
 */
export const listTestAccountsForSweep = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const [qa, pw] = await Promise.all([
      ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.gte("username", "qa_").lt("username", "qb_"))
        .take(1000),
      ctx.db
        .query("users")
        .withIndex("by_username", (q) =>
          q.gte("username", "pwtest").lt("username", "pwtf"),
        )
        .take(1000),
    ]);
    return [...qa, ...pw].map((u) => ({
      userId: u._id,
      username: u.username ?? null,
      name: u.name ?? null,
      creationTime: u._creationTime,
    }));
  },
});

/**
 * Mark a post as a QA fixture. The harness sometimes has to create posts
 * AS a REAL account (the admin drives end-to-end moderation/notification
 * flows) — those posts' authors aren't reserved-prefix handles, so
 * username isolation can't see them. This marker is what the sitemap +
 * public feeds exclude on, and what the nightly cleanup sweep erases by.
 * Only the harness (secret-gated) can set it, so a real member can never
 * hide a post from Google with a forged flag. Idempotent.
 */
export const markPostAsQaFixture = mutation({
  args: { postId: v.id("posts"), secret: v.string() },
  handler: async (ctx, { postId, secret }) => {
    requireHarness(secret);
    const post = await ctx.db.get(postId);
    if (post === null) {
      return { marked: false, reason: "not-found" };
    }
    await ctx.db.patch(postId, { qaFixture: true });
    return { marked: true };
  },
});

/**
 * Every qaFixture-marked post still in the posts table — the nightly
 * cleanup sweep's second target. A crashed CI run that skips its own
 * finally-cleanup can leave posts created through a REAL account (the
 * admin); unlike qa_* accounts there is no reserved username to page, so
 * the marker is the only reliable finder. Gated by the same env pair.
 */
export const listQaFixturePostsForSweep = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const posts = await ctx.db.query("posts").take(1000);
    return posts
      .filter((p) => p.qaFixture === true)
      .map((p) => ({
        postId: p._id,
        authorUsername: p.authorId,
        content: (p.content ?? "").slice(0, 80),
        creationTime: p._creationTime,
      }));
  },
});

/**
 * Delete a qaFixture-marked post, regardless of who its author is. The
 * QA scripts that create posts as the real admin normally delete them
 * themselves in finally, but a hard crash can skip that — and the admin
 * session may also be long gone by sweep time, so this goes through the
 * harness secret instead of any session. Engagements (likes/comments/
 * shares) die with the post via the same sweep the user-facing delete
 * runs. Gated by the same env pair.
 */
export const deleteQaFixturePost = mutation({
  args: { postId: v.id("posts"), secret: v.string() },
  handler: async (ctx, { postId, secret }) => {
    requireHarness(secret);
    const post = await ctx.db.get(postId);
    if (post === null) {
      return { deleted: false, reason: "not-found" };
    }
    if (post.qaFixture !== true) {
      return { deleted: false, reason: "not-qa-fixture" };
    }
    // Mirror deletePost's core (media + engagement + share + postsCount
    // sweeps) WITHOUT the auth gate — a crashed CI run may have lost the
    // admin session it created the post with, and the nightly sweep must
    // still be able to erase the fixture. The harness secret gate above
    // is the authorization.
    await cleanupMediaItems(ctx, post.media ?? []);
    await sweepPostEngagement(ctx, postId);
    const sharedFromId = post.sharedFromId;
    if (sharedFromId !== undefined) {
      const target = await ctx.db.get(sharedFromId);
      if (target !== null) {
        const shareRow = await ctx.db
          .query("shares")
          .withIndex("by_post", (q) => q.eq("postId", sharedFromId))
          .filter((r) => r.eq(r.field("userId"), post.authorId))
          .first();
        if (shareRow !== null) {
          await ctx.db.delete(shareRow._id);
          await ctx.db.patch(target._id, {
            shareCount: Math.max(0, target.shareCount - 1),
          });
        }
      }
    }
    await ctx.db.delete(postId);
    const author = await ctx.db.get(post.authorId);
    if (author !== null) {
      await ctx.db.patch(author._id, {
        postsCount: Math.max(0, (author.postsCount ?? 0) - 1),
      });
    }
    return { deleted: true };
  },
});

/**
 * Full post-erasure state for a QA account: whether the users row still
 * exists, how many rows remain in every table keyed by userId that the
 * erasure sweep touches (posts, comments, likes, shares, stories, follows
 * both ways, notifications inbox + triggered, tickets, blocks both ways,
 * rate limits, silent-flag events, moderation log, auth
 * sessions/accounts/tokens/codes/verifiers), whether given storage files
 * still exist, and the private removal-log record (the one deliberate
 * survivor of an admin removal). The remove-account QA asserts every count
 * is zero, every probed file is gone, and the removal log kept its one-way
 * identity snapshot.
 *
 * authRateLimits is deliberately not counted here: eraseAccount sweeps it
 * by the account's EMAIL identifier (not userId), and harness users are
 * created without an email — so no such rows can ever exist for them.
 *
 * Gated by the same two env gates as the rest of the harness.
 */
export const getTestUserTraces = query({
  args: {
    userId: v.id("users"),
    secret: v.string(),
    // Storage ids to probe for existence (deleted = gone). Strings so the
    // script can pass them back verbatim from its upload response.
    storageIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { userId, secret, storageIds }) => {
    requireHarness(secret);
    const user = await ctx.db.get(userId);

    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .take(1000);
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .take(1000);
    const sessionIds = new Set(sessions.map((s) => s._id));
    const accountIds = new Set(accounts.map((a) => a._id));
    let authRefreshTokens = 0;
    for (const sid of sessionIds) {
      authRefreshTokens += (
        await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", sid))
          .take(1000)
      ).length;
    }
    let authVerificationCodes = 0;
    for (const aid of accountIds) {
      authVerificationCodes += (
        await ctx.db
          .query("authVerificationCodes")
          .withIndex("accountId", (q) => q.eq("accountId", aid))
          .take(1000)
      ).length;
    }
    // authVerifiers has no sessionId index — scan and filter, matching the
    // erasure sweep's approach.
    const verifiers = (await ctx.db.query("authVerifiers").take(1000)).filter(
      (v) => v.sessionId !== undefined && sessionIds.has(v.sessionId),
    ).length;

    const [followsOut, followsIn, blocksOut, blocksIn, inboxNotifs] =
      await Promise.all([
        ctx.db
          .query("follows")
          .withIndex("by_follower", (q) => q.eq("followerId", userId))
          .take(1000),
        ctx.db
          .query("follows")
          .withIndex("by_following", (q) => q.eq("followingId", userId))
          .take(1000),
        ctx.db
          .query("blocks")
          .withIndex("by_blocker", (q) => q.eq("blockerId", userId))
          .take(1000),
        ctx.db
          .query("blocks")
          .withIndex("by_blocked", (q) => q.eq("blockedId", userId))
          .take(1000),
        ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(1000),
      ]);
    // Notifications the account triggered (actorId) — the sweep removes
    // these too, so count them as well.
    const triggeredNotifs = (
      await ctx.db
        .query("notifications")
        .filter((q) => q.eq(q.field("actorId"), userId))
        .take(1000)
    ).length;

    // Storage probes: a file that was deleted returns null from getUrl.
    const storage = await Promise.all(
      (storageIds ?? []).map(async (id) => ({
        storageId: id,
        exists: (await ctx.storage.getUrl(id as Id<"_storage">)) !== null,
      })),
    );

    // The private removal log: the one deliberate survivor of an admin
    // removal (never swept, one-way). Before removal it is absent; after
    // an admin removal it holds the snapshotted identity.
    const removals = await ctx.db
      .query("removalLog")
      .filter((q) => q.eq(q.field("userId"), userId))
      .take(10);
    const removalLog = removals[0] ?? null;

    return {
      userExists: user !== null,
      counts: {
        posts: (await ctx.db.query("posts").withIndex("by_author", (q) => q.eq("authorId", userId)).take(1000)).length,
        comments: (await ctx.db.query("comments").withIndex("by_author", (q) => q.eq("authorId", userId)).take(1000)).length,
        commentLikes: (await ctx.db.query("commentLikes").withIndex("by_user", (q) => q.eq("userId", userId)).take(1000)).length,
        likes: (await ctx.db.query("likes").withIndex("by_user", (q) => q.eq("userId", userId)).take(1000)).length,
        shares: (await ctx.db.query("shares").withIndex("by_user", (q) => q.eq("userId", userId)).take(1000)).length,
        stories: (await ctx.db.query("stories").withIndex("by_author", (q) => q.eq("authorId", userId)).take(1000)).length,
        follows: followsOut.length + followsIn.length,
        notifications: inboxNotifs.length + triggeredNotifs,
        supportTickets: (await ctx.db.query("supportTickets").withIndex("by_user", (q) => q.eq("userId", userId)).take(1000)).length,
        blocks: blocksOut.length + blocksIn.length,
        rateLimits: (await ctx.db.query("rateLimits").withIndex("by_user_action", (q) => q.eq("userId", userId)).take(1000)).length,
        silentFlagEvents: (await ctx.db.query("silentFlagEvents").withIndex("by_user", (q) => q.eq("userId", userId)).take(1000)).length,
        moderationLog: (await ctx.db.query("moderationLog").withIndex("by_target", (q) => q.eq("targetUserId", userId)).take(1000)).length,
        authSessions: sessions.length,
        authAccounts: accounts.length,
        authRefreshTokens,
        authVerificationCodes,
        authVerifiers: verifiers,
      },
      storage,
      removalLog: removalLog
        ? {
            username: removalLog.username ?? null,
            name: removalLog.name ?? null,
            emailHash: removalLog.emailHash ?? null,
            actorId: removalLog.actorId ?? null,
            standardId: removalLog.standardId ?? null,
            note: removalLog.note ?? null,
            createdAt: removalLog._creationTime,
          }
        : null,
    };
  },
});

// ────────────────────────────────────────────────────────
//  Data Integrity: orphan detection across all FK tables
// ────────────────────────────────────────────────────────

/**
 * Full-spectrum orphan audit: walks every table that references users or
 * posts by foreign key and reports rows whose target no longer exists.
 *
 * Tables audited:
 *   notifications     — userId / actorId / postId
 *   supportTickets    — userId / offenderId / postId
 *   blocks            — blockerId / blockedId
 *   dmConversations   — participantA / participantB
 *   dmMessages        — conversationId / senderId
 *   silentFlagEvents  — userId
 *   moderationLog     — targetUserId / actorId
 *
 * Gated by the same two env gates as the rest of the harness.
 * Reads up to 1000 rows per table; returns counts plus the first few
 * orphan ids for the QA script to assert against.
 */
export const auditDataOrphans = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);

    // ── notifications ────────────────────────────────
    const notifs = await ctx.db.query("notifications").take(1000);
    const notificationOrphans: Array<{
      id: string;
      reason: "userId" | "actorId" | "postId";
      missingId: string;
    }> = [];
    for (const n of notifs) {
      if ((await ctx.db.get(n.userId)) === null) {
        notificationOrphans.push({ id: n._id, reason: "userId", missingId: n.userId });
      }
      if (n.actorId !== undefined && (await ctx.db.get(n.actorId)) === null) {
        notificationOrphans.push({ id: n._id, reason: "actorId", missingId: n.actorId });
      }
      if (n.postId !== undefined && (await ctx.db.get(n.postId)) === null) {
        notificationOrphans.push({ id: n._id, reason: "postId", missingId: n.postId });
      }
    }

    // ── support tickets ─────────────────────────────
    const tickets = await ctx.db.query("supportTickets").take(1000);
    const ticketOrphans: Array<{
      id: string;
      reason: "userId" | "offenderId" | "postId";
      missingId: string;
    }> = [];
    for (const t of tickets) {
      if ((await ctx.db.get(t.userId)) === null) {
        ticketOrphans.push({ id: t._id, reason: "userId", missingId: t.userId });
      }
      if (t.offenderId !== undefined && (await ctx.db.get(t.offenderId)) === null) {
        ticketOrphans.push({ id: t._id, reason: "offenderId", missingId: t.offenderId });
      }
      if (t.postId !== undefined && (await ctx.db.get(t.postId)) === null) {
        ticketOrphans.push({ id: t._id, reason: "postId", missingId: t.postId });
      }
    }

    // ── blocks ─────────────────────────────────────
    const blockRows = await ctx.db.query("blocks").take(1000);
    const blockOrphans: Array<{
      id: string;
      reason: "blockerId" | "blockedId";
      missingId: string;
    }> = [];
    for (const b of blockRows) {
      if ((await ctx.db.get(b.blockerId)) === null) {
        blockOrphans.push({ id: b._id, reason: "blockerId", missingId: b.blockerId });
      }
      if ((await ctx.db.get(b.blockedId)) === null) {
        blockOrphans.push({ id: b._id, reason: "blockedId", missingId: b.blockedId });
      }
    }

    // ── DM conversations ──────────────────────────
    const convos = await ctx.db.query("dmConversations").take(1000);
    const dmConversationOrphans: Array<{
      id: string;
      reason: "participantA" | "participantB";
      missingId: string;
    }> = [];
    for (const c of convos) {
      if ((await ctx.db.get(c.participantA)) === null) {
        dmConversationOrphans.push({ id: c._id, reason: "participantA", missingId: c.participantA });
      }
      if ((await ctx.db.get(c.participantB)) === null) {
        dmConversationOrphans.push({ id: c._id, reason: "participantB", missingId: c.participantB });
      }
    }

    // ── DM messages ───────────────────────────────
    const dms = await ctx.db.query("dmMessages").take(1000);
    const dmMessageOrphans: Array<{
      id: string;
      reason: "conversationId" | "senderId";
      missingId: string;
    }> = [];
    for (const m of dms) {
      if ((await ctx.db.get(m.conversationId)) === null) {
        dmMessageOrphans.push({ id: m._id, reason: "conversationId", missingId: m.conversationId });
      }
      if ((await ctx.db.get(m.senderId)) === null) {
        dmMessageOrphans.push({ id: m._id, reason: "senderId", missingId: m.senderId });
      }
    }

    // ── silentFlagEvents ──────────────────────────
    const flags = await ctx.db.query("silentFlagEvents").take(1000);
    const silentFlagOrphans: Array<{ id: string; missingId: string }> = [];
    for (const f of flags) {
      if ((await ctx.db.get(f.userId)) === null) {
        silentFlagOrphans.push({ id: f._id, missingId: f.userId });
      }
    }

    // ── moderationLog ─────────────────────────────
    const modLog = await ctx.db.query("moderationLog").take(1000);
    const moderationLogOrphans: Array<{
      id: string;
      reason: "targetUserId" | "actorId";
      missingId: string;
    }> = [];
    for (const m of modLog) {
      if ((await ctx.db.get(m.targetUserId)) === null) {
        moderationLogOrphans.push({ id: m._id, reason: "targetUserId", missingId: m.targetUserId });
      }
      if (m.actorId !== undefined && (await ctx.db.get(m.actorId)) === null) {
        moderationLogOrphans.push({ id: m._id, reason: "actorId", missingId: m.actorId });
      }
    }

    // ── commentLikes ──────────────────────────────
    const commentLikeRows = await ctx.db.query("commentLikes").take(1000);
    const commentLikeOrphans: Array<{
      id: string;
      reason: "commentId" | "userId";
      missingId: string;
    }> = [];
    for (const cl of commentLikeRows) {
      if ((await ctx.db.get(cl.commentId)) === null) {
        commentLikeOrphans.push({
          id: cl._id,
          reason: "commentId",
          missingId: cl.commentId,
        });
      }
      if ((await ctx.db.get(cl.userId)) === null) {
        commentLikeOrphans.push({
          id: cl._id,
          reason: "userId",
          missingId: cl.userId,
        });
      }
    }

    // ── storyViews ────────────────────────────────
    const views = await ctx.db.query("storyViews").take(1000);
    const storyViewOrphans: Array<{
      id: string;
      reason: "storyId" | "viewerId";
      missingId: string;
    }> = [];
    for (const v of views) {
      if ((await ctx.db.get(v.storyId)) === null) {
        storyViewOrphans.push({ id: v._id, reason: "storyId", missingId: v.storyId });
      }
      if ((await ctx.db.get(v.viewerId)) === null) {
        storyViewOrphans.push({ id: v._id, reason: "viewerId", missingId: v.viewerId });
      }
    }

    const totalOrphans =
      notificationOrphans.length +
      ticketOrphans.length +
      blockOrphans.length +
      dmConversationOrphans.length +
      dmMessageOrphans.length +
      silentFlagOrphans.length +
      moderationLogOrphans.length +
      commentLikeOrphans.length +
      storyViewOrphans.length;

    return {
      tablesScanned: {
        notifications: notifs.length,
        supportTickets: tickets.length,
        blocks: blockRows.length,
        dmConversations: convos.length,
        dmMessages: dms.length,
        silentFlagEvents: flags.length,
        moderationLog: modLog.length,
        commentLikes: commentLikeRows.length,
        storyViews: views.length,
      },
      notificationOrphans,
      ticketOrphans,
      blockOrphans,
      dmConversationOrphans,
      dmMessageOrphans,
      silentFlagOrphans,
      moderationLogOrphans,
      commentLikeOrphans,
      storyViewOrphans,
      totalOrphans,
    };
  },
});

/**
 * Sweep discovered orphans across all FK tables. Calls the same
 * audit logic and deletes every orphan row found, then reports what
 * was removed. Idempotent — a clean run deletes nothing.
 *
 * Gated by the same two env gates as the rest of the harness.
 */
export const sweepDataOrphans = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);

    const swept: Array<{ table: string; id: string; reason: string }> = [];

    // ── notifications ────────────────────────────────
    const notifs = await ctx.db.query("notifications").take(1000);
    for (const n of notifs) {
      const userGone = (await ctx.db.get(n.userId)) === null;
      const actorGone = n.actorId !== undefined && (await ctx.db.get(n.actorId)) === null;
      const postGone = n.postId !== undefined && (await ctx.db.get(n.postId)) === null;
      if (userGone || actorGone || postGone) {
        await ctx.db.delete(n._id);
        swept.push({
          table: "notifications",
          id: n._id,
          reason: userGone
            ? `userId ${n.userId} deleted`
            : actorGone
              ? `actorId ${n.actorId} deleted`
              : `postId ${n.postId} deleted`,
        });
      }
    }

    // ── supportTickets ─────────────────────────────
    const tickets = await ctx.db.query("supportTickets").take(1000);
    for (const t of tickets) {
      const userGone = (await ctx.db.get(t.userId)) === null;
      const offenderGone = t.offenderId !== undefined && (await ctx.db.get(t.offenderId)) === null;
      const postGone = t.postId !== undefined && (await ctx.db.get(t.postId)) === null;
      if (userGone || offenderGone || postGone) {
        await ctx.db.delete(t._id);
        swept.push({
          table: "supportTickets",
          id: t._id,
          reason: userGone
            ? `userId ${t.userId} deleted`
            : offenderGone
              ? `offenderId ${t.offenderId} deleted`
              : `postId ${t.postId} deleted`,
        });
      }
    }

    // ── blocks ─────────────────────────────────────
    const blockRows = await ctx.db.query("blocks").take(1000);
    for (const b of blockRows) {
      const blockerGone = (await ctx.db.get(b.blockerId)) === null;
      const blockedGone = (await ctx.db.get(b.blockedId)) === null;
      if (blockerGone || blockedGone) {
        await ctx.db.delete(b._id);
        swept.push({
          table: "blocks",
          id: b._id,
          reason: blockerGone
            ? `blockerId ${b.blockerId} deleted`
            : `blockedId ${b.blockedId} deleted`,
        });
      }
    }

    // ── dmConversations ──────────────────────────
    const convos = await ctx.db.query("dmConversations").take(1000);
    for (const c of convos) {
      const aGone = (await ctx.db.get(c.participantA)) === null;
      const bGone = (await ctx.db.get(c.participantB)) === null;
      if (aGone || bGone) {
        await ctx.db.delete(c._id);
        swept.push({
          table: "dmConversations",
          id: c._id,
          reason: aGone
            ? `participantA ${c.participantA} deleted`
            : `participantB ${c.participantB} deleted`,
        });
      }
    }

    // ── dmMessages ───────────────────────────────
    const dms = await ctx.db.query("dmMessages").take(1000);
    for (const m of dms) {
      const convoGone = (await ctx.db.get(m.conversationId)) === null;
      const senderGone = (await ctx.db.get(m.senderId)) === null;
      if (convoGone || senderGone) {
        await ctx.db.delete(m._id);
        swept.push({
          table: "dmMessages",
          id: m._id,
          reason: convoGone
            ? `conversationId ${m.conversationId} deleted`
            : `senderId ${m.senderId} deleted`,
        });
      }
    }

    // ── silentFlagEvents ──────────────────────────
    const flags = await ctx.db.query("silentFlagEvents").take(1000);
    for (const f of flags) {
      if ((await ctx.db.get(f.userId)) === null) {
        await ctx.db.delete(f._id);
        swept.push({
          table: "silentFlagEvents",
          id: f._id,
          reason: `userId ${f.userId} deleted`,
        });
      }
    }

    // ── moderationLog ─────────────────────────────
    const modLog = await ctx.db.query("moderationLog").take(1000);
    for (const m of modLog) {
      const targetGone = (await ctx.db.get(m.targetUserId)) === null;
      const actorGone =
        m.actorId !== undefined && (await ctx.db.get(m.actorId)) === null;
      if (targetGone || actorGone) {
        await ctx.db.delete(m._id);
        swept.push({
          table: "moderationLog",
          id: m._id,
          reason: targetGone
            ? `targetUserId ${m.targetUserId} deleted`
            : `actorId ${m.actorId} deleted`,
        });
      }
    }

    // ── commentLikes ──────────────────────────────
    const commentLikeRows = await ctx.db.query("commentLikes").take(1000);
    for (const cl of commentLikeRows) {
      const commentGone = (await ctx.db.get(cl.commentId)) === null;
      const userGone = (await ctx.db.get(cl.userId)) === null;
      if (commentGone || userGone) {
        await ctx.db.delete(cl._id);
        swept.push({
          table: "commentLikes",
          id: cl._id,
          reason: commentGone
            ? `commentId ${cl.commentId} deleted`
            : `userId ${cl.userId} deleted`,
        });
      }
    }

    // ── storyViews ────────────────────────────────
    const views = await ctx.db.query("storyViews").take(1000);
    for (const v of views) {
      const storyGone = (await ctx.db.get(v.storyId)) === null;
      const viewerGone = (await ctx.db.get(v.viewerId)) === null;
      if (storyGone || viewerGone) {
        await ctx.db.delete(v._id);
        swept.push({
          table: "storyViews",
          id: v._id,
          reason: storyGone
            ? `storyId ${v.storyId} deleted`
            : `viewerId ${v.viewerId} deleted`,
        });
      }
    }

    return {
      sweptCount: swept.length,
      swept,
    };
  },
});

// ────────────────────────────────────────────────────────
//  Data Integrity: duplicate detection
// ────────────────────────────────────────────────────────

/**
 * Detect duplicate rows where uniqueness is enforced by index but
 * not guaranteed by the schema. Reports duplicate (followerId,
 * followingId), (userId, postId) likes, and (blockerId, blockedId)
 * pairs. Does NOT mutate — the QA script asserts zero duplicates.
 *
 * Gated by the same two env gates as the rest of the harness.
 */
export const auditDuplicates = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);

    // ── follows duplicates ───────────────────────────
    const follows = await ctx.db.query("follows").take(1000);
    const followSeen = new Map<string, string>();
    const followDuplicates: Array<{
      id: string;
      pair: string;
      firstSeenId: string;
    }> = [];
    for (const f of follows) {
      const key = `${f.followerId}|${f.followingId}`;
      const prev = followSeen.get(key);
      if (prev !== undefined) {
        followDuplicates.push({ id: f._id, pair: key, firstSeenId: prev });
      } else {
        followSeen.set(key, f._id);
      }
    }

    // ── likes duplicates ─────────────────────────────
    const likes = await ctx.db.query("likes").take(1000);
    const likeSeen = new Map<string, string>();
    const likeDuplicates: Array<{
      id: string;
      pair: string;
      firstSeenId: string;
    }> = [];
    for (const l of likes) {
      const key = `${l.userId}|${l.postId}`;
      const prev = likeSeen.get(key);
      if (prev !== undefined) {
        likeDuplicates.push({ id: l._id, pair: key, firstSeenId: prev });
      } else {
        likeSeen.set(key, l._id);
      }
    }

    // ── blocks duplicates ───────────────────────────
    const blockRows = await ctx.db.query("blocks").take(1000);
    const blockSeen = new Map<string, string>();
    const blockDuplicates: Array<{
      id: string;
      pair: string;
      firstSeenId: string;
    }> = [];
    for (const b of blockRows) {
      const key = `${b.blockerId}|${b.blockedId}`;
      const prev = blockSeen.get(key);
      if (prev !== undefined) {
        blockDuplicates.push({ id: b._id, pair: key, firstSeenId: prev });
      } else {
        blockSeen.set(key, b._id);
      }
    }

    return {
      tablesScanned: {
        follows: follows.length,
        likes: likes.length,
        blocks: blockRows.length,
      },
      followDuplicates,
      likeDuplicates,
      blockDuplicates,
      totalDuplicates:
        followDuplicates.length + likeDuplicates.length + blockDuplicates.length,
    };
  },
});

// ────────────────────────────────────────────────────────
//  Data Integrity: expired story detection
// ────────────────────────────────────────────────────────

/**
 * Report every story whose expiresAt is in the past. The production
 * `pruneExpiredStories` mutation runs nightly via a scheduled job, and
 * `getFeed` / `getUserStories` already filter out expired stories at
 * query time — so a non-zero count here means the scheduled sweep is
 * failing or the story-delete path didn't clean up a row after removal
 * of the author. Either way the data integrity gate catches it.
 *
 * Gated by the same two env gates as the rest of the harness.
 */
export const auditExpiredStories = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const now = Date.now();
    const expired = await ctx.db
      .query("stories")
      .withIndex("by_expiration", (q) => q.lt("expiresAt", now))
      .take(1000);
    return {
      now,
      expiredCount: expired.length,
      expired: expired.map((s) => ({
        id: s._id,
        authorId: s.authorId,
        expiresAt: s.expiresAt,
        expiredMsAgo: now - s.expiresAt,
      })),
    };
  },
});

/**
 * Delete every story whose expiresAt is in the past. Idempotent —
 * a clean run deletes nothing. Mirrors the production cron mutation
 * in account.ts, but gated on the harness so the QA script can call
 * it immediately after the audit.
 *
 * Gated by the same two env gates as the rest of the harness.
 */
export const sweepExpiredStories = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);
    const now = Date.now();
    const expired = await ctx.db
      .query("stories")
      .withIndex("by_expiration", (q) => q.lt("expiresAt", now))
      .take(1000);
    for (const story of expired) {
      await ctx.db.delete(story._id);
    }
    return { deleted: expired.length };
  },
});

// ────────────────────────────────────────────────────────
//  Media architecture audit
// ────────────────────────────────────────────────────────

/**
 * Audit every media reference across posts, stories, and comments against
 * the Cloudinary-first architecture: Cloudinary stores the actual bytes,
 * Convex stores only a reference (`url` + `key`/public_id) plus metadata.
 *
 * Reports, per surface, how many items are:
 *   - `convex`  — stored as a Convex `_storage` id (the fallback/legacy
 *                 path, acceptable only when Cloudinary isn't configured
 *                 or the upload resiliently fell back)
 *   - `cloudinary` — an https URL on PureWire's own media host with a
 *                 stored public_id key
 *   - `invalid`  — anything that violates the architecture: blob: / data:
 *                 / base64 payloads, a media URL that isn't Cloudinary, an
 *                 item with neither storage nor URL, or one carrying both
 *
 * Does NOT mutate. The QA script asserts zero `invalid` and reports the
 * convex/cloudinary split so a regression that starts shoving bytes into
 * Convex (or hotlinking foreign hosts) surfaces immediately.
 *
 * Gated by the same harness secret as the rest of the harness.
 */
export const auditMediaArchitecture = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireHarness(secret);

    type InvalidRow = {
      table: string;
      id: string;
      reason: string;
    };
    const counts = { convex: 0, cloudinary: 0, invalid: 0 };
    const invalidRows: InvalidRow[] = [];

    const classify = (
      table: string,
      id: string,
      item: {
        storageId?: unknown;
        url?: unknown;
        key?: unknown;
      } | null | undefined,
    ) => {
      if (item === null || item === undefined) {
        return;
      }
      const hasStorage = item.storageId !== undefined;
      const hasUrl = typeof item.url === "string" && item.url.length > 0;
      const hasKey = typeof item.key === "string" && item.key.length > 0;
      const url = hasUrl ? (item.url as string) : "";

      // Neither storage nor URL — an empty husk of a media reference.
      if (!hasStorage && !hasUrl) {
        counts.invalid++;
        invalidRows.push({ table, id, reason: "no storage id and no URL" });
        return;
      }
      // Both — the dual-mode shape forbids it (exactly one mode).
      if (hasStorage && hasUrl) {
        counts.invalid++;
        invalidRows.push({ table, id, reason: "both storage id and URL" });
        return;
      }
      // blob: / data: / base64 — bytes embedded in the reference.
      if (
        url.startsWith("blob:") ||
        url.startsWith("data:") ||
        url.startsWith("base64,") ||
        url.includes("base64")
      ) {
        counts.invalid++;
        invalidRows.push({
          table,
          id,
          reason: `embedded bytes in URL (${url.slice(0, 40)}…)`,
        });
        return;
      }
      // A URL with no Cloudinary key is a broken reference: deletion
      // can't know what to remove.
      if (hasUrl && !hasKey) {
        counts.invalid++;
        invalidRows.push({ table, id, reason: "URL without a public_id key" });
        return;
      }
      if (hasUrl) {
        // Only PureWire's own media host may ride in as media.
        const host = (() => {
          try {
            return new URL(url).host;
          } catch {
            return null;
          }
        })();
        const allowed =
          host === "res.cloudinary.com" ||
          (host !== null && host.endsWith(".res.cloudinary.com"));
        if (!allowed) {
          counts.invalid++;
          invalidRows.push({
            table,
            id,
            reason: `media not hosted by PureWire's provider (${host ?? "unparseable"})`,
          });
          return;
        }
        counts.cloudinary++;
        return;
      }
      // Storage id alone — the documented fallback path.
      counts.convex++;
    };

    // ── posts ─────────────────────────────────────
    const posts = await ctx.db.query("posts").take(1000);
    for (const p of posts) {
      for (const m of p.media ?? []) {
        classify("posts", p._id, m);
      }
    }

    // ── stories ───────────────────────────────────
    const stories = await ctx.db.query("stories").take(1000);
    for (const s of stories) {
      classify("stories", s._id, s.media);
    }

    // ── comments (voice notes) ────────────────────
    const comments = await ctx.db.query("comments").take(1000);
    for (const c of comments) {
      classify("comments", c._id, c.media);
    }

    return {
      counts,
      invalidRows: invalidRows.slice(0, 50),
      invalidCount: invalidRows.length,
    };
  },
});

