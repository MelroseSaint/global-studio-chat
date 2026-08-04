import { v, ConvexError } from "convex/values";
import { getAuthSessionId } from "@convex-dev/auth/server";
import { SignJWT, importPKCS8 } from "jose";

import { ADMIN_EMAIL } from "./auth";

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
  },
  handler: async (ctx, { name, username, secret }) => {
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
    const userId = await ctx.db.insert("users", {
      username: normalized,
      name: name.trim() || normalized,
      verified: true,
      role: "user",
      followersCount: 0,
      followingCount: 0,
      postsCount: 0,
      accountStatus: "active",
    });
    const token = await mintSession(ctx, userId);
    return { userId, username: normalized, token };
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
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .take(100);
    for (const session of sessions) {
      const pref = await ctx.db
        .query("sessionPrefs")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .first();
      if (pref !== null) {
        await ctx.db.delete(pref._id);
      }
      await ctx.db.delete(session._id);
    }
    await ctx.db.delete(userId);
    return { deleted: true, sessions: sessions.length };
  },
});

/**
 * Mint a real session for the platform's admin (ADMIN_EMAIL), so the QA
 * check can verify silenced content is visible to moderation. Gated by the
 * same two env gates as everything else in this module.
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
    return { userId: admin._id, token };
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
