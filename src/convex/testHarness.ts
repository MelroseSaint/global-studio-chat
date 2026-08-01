import { v } from "convex/values";
import { SignJWT, importPKCS8 } from "jose";

import { ADMIN_EMAIL } from "./auth";

import {
  mutation,
  query,
  type MutationCtx,
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
