import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { isStandardId } from "@/lib/standard";

import { publicUser } from "./privacy";

import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/**
 * PureWire's trust & safety layer.
 *
 * The platform's promise is freedom with a reason, and that requires the
 * strongest possible protection against coordinated abuse:
 *
 * - Account risk scoring at signup (disposable email domains, pattern
 *   usernames, bulk-style names) flags suspicious signups for review.
 * - Rate limits on every activity (posts, comments, likes, follows)
 *   blunt bot floods and farm networks.
 * - Blocking lets members cut off harassers; blocked accounts are hidden
 *   from feeds, profiles, and notifications in both directions.
 * - Admin can restrict or ban accounts; restricted/banned accounts can't
 *   post or engage, and their content stops appearing publicly. Accounts
 *   flagged suspicious at signup are kept off public feeds until approved.
 * - Silent moderation: accounts that keep tripping abuse signals are
 *   quietly shadowbanned — nothing errors, their posts still "work" to
 *   them, but nothing they do reaches anyone else until a human reviews.
 */

export const ACCOUNT_STATUS = v.union(
  v.literal("active"),
  v.literal("suspicious"),
  v.literal("restricted"),
  v.literal("banned"),
);

/**
 * Human-only bot check: verifies a Cloudflare Turnstile token server-side.
 *
 * Paired with the email trigger so only a real browser operated by a human
 * can request a verification code. The client renders the Turnstile widget
 * only when VITE_TURNSTILE_SITE_KEY is set; the secret key here comes from
 * Convex env (TURNSTILE_SECRET_KEY). When the secret is not configured the
 * check is reported as disabled rather than failing — signups still run
 * through email normalization, risk scoring, and rate limits.
 */
export const verifyBotChallenge = mutation({
  args: { token: v.string() },
  handler: async (_ctx, { token }) => {
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
      return { ok: true, enabled: false };
    }
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, response: token }),
      },
    );
    const data = (await res.json()) as { success?: boolean };
    if (data.success !== true) {
      throw new Error(
        "We couldn't confirm you're a person. Try again or contact Support.",
      );
    }
    return { ok: true, enabled: true };
  },
});

/** Domains used almost exclusively for throwaway bot signups. */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "temp-mail.org",
  "temp-mail.io",
  "tempmail.com",
  "tempmail.net",
  "10minutemail.com",
  "maildrop.cc",
  "mailnesia.com",
  "throwawaymail.com",
  "yopmail.com",
  "getnada.com",
  "inboxbear.com",
  "mintemail.com",
  "spamgourmet.com",
  "trashmail.com",
  "mailcatch.com",
  "discard.email",
  "emailnator.com",
  "fakeinbox.com",
  "tempinbox.com",
  "mohmal.com",
  "tempail.com",
  "cock.li",
  "onionmail.org",
  "sneakemail.com",
  "jetable.org",
  "mailmetrash.com",
  "fakemailgenerator.com",
]);

/**
 * Username shapes bots and farms generate in bulk — pure digits, long
 * random hex, repeating characters, or a digit-only suffix.
 */
const PATTERN_USERNAME = /^[0-9]{5,}$|^[a-f0-9]{16,}$|^(.)\1{4,}$|^\w+[0-9]{6,}$/i;

/** Names that are clearly placeholder ("user123", "guest_", "random"). */
const PLACEHOLDER_NAME = /^(user|guest|member|random|temp|anon)[\s_-]*[0-9]*$/i;

export type RiskVerdict = { score: number; reasons: string[] };

/**
 * Score a new account for bot/farm signals. Returns 0-100 and the list of
 * signals found. Low threshold => "suspicious" for a human to review.
 */
export function computeRiskScore(params: {
  email?: string | null;
  username?: string | null;
  name?: string | null;
}): RiskVerdict {
  const reasons: string[] = [];
  let score = 0;
  const email = String(params.email ?? "").toLowerCase().trim();
  const username = String(params.username ?? "").toLowerCase().trim();
  const name = String(params.name ?? "").trim();

  if (email.length > 0) {
    const domain = email.split("@")[1] ?? "";
    if (DISPOSABLE_DOMAINS.has(domain)) {
      score += 45;
      reasons.push("Disposable email domain");
    }
    if (/^[a-z0-9]{18,}@/.test(email)) {
      score += 15;
      reasons.push("Randomized email address");
    }
  }

  if (username.length > 0 && PATTERN_USERNAME.test(username)) {
    score += 25;
    reasons.push("Pattern or machine-like username");
  }

  if (name.length > 0 && PLACEHOLDER_NAME.test(name)) {
    score += 20;
    reasons.push("Placeholder name");
  }
  if (name.length === 0) {
    score += 10;
    reasons.push("No display name");
  }

  return { score: Math.min(score, 100), reasons };
}

/** Per-account activity budgets (windowMs, limit). */
const RATE_LIMITS: Record<string, { windowMs: number; limit: number }> = {
  post: { windowMs: 60 * 60_000, limit: 30 }, // 30 posts/hour
  comment: { windowMs: 60 * 60_000, limit: 60 }, // 60 comments/hour
  like: { windowMs: 60 * 60_000, limit: 120 }, // 120 likes/hour
  follow: { windowMs: 60 * 60_000, limit: 30 }, // 30 follows/hour
  share: { windowMs: 60 * 60_000, limit: 60 }, // 60 shares/hour
  // Upload URL generation is a public-ish surface used for bulk media
  // collection — budget it so scraping tools can't mint unlimited signed
  // URLs to fill PureWire's storage, while still allowing a photo-heavy
  // poster (4 media × 30 posts/hour) to work without hitting the wall.
  upload: { windowMs: 60 * 60_000, limit: 200 }, // 200 uploads/hour
};

/**
 * Enforce an activity budget for a user. Throws when the budget is spent.
 * Uses a rolling window keyed on the user + action.
 */
export async function enforceRateLimit(
  ctx: MutationCtx,
  userId: Id<"users">,
  action: keyof typeof RATE_LIMITS,
): Promise<void> {
  const budget = RATE_LIMITS[action];
  if (budget === undefined) {
    return;
  }
  const now = Date.now();
  const rows = await ctx.db
    .query("rateLimits")
    .withIndex("by_user_action", (q) =>
      q.eq("userId", userId).eq("action", action),
    )
    .collect();
  // Self-maintaining budget: drop rows outside the rolling window so the
  // rateLimits table never grows without bound.
  const recent: Doc<"rateLimits">[] = [];
  const stale: Doc<"rateLimits">[] = [];
  for (const row of rows) {
    if (row.windowStart >= now - budget.windowMs) {
      recent.push(row);
    } else {
      stale.push(row);
    }
  }
  if (stale.length > 0) {
    await Promise.all(stale.map((row) => ctx.db.delete(row._id)));
  }
  if (recent.length >= budget.limit) {
    // Repeatedly blasting past a budget is a bot/farm signal — count it
    // toward a quiet shadowban instead of just blocking the one action.
    await escalateSilently(ctx, userId, 1);
    throw new Error(
      "You're moving a little too fast. Slow down and try again in a moment.",
    );
  }
  await ctx.db.insert("rateLimits", {
    userId,
    action,
    windowStart: now,
  });
}

/** Abuse signals that add up to a quiet shadowban. */
const SHADOWBAN_THRESHOLD = 6;

/**
 * True when an account must be silently sandboxed: their mutations still
 * succeed client-side, but nothing they create reaches other members until
 * a human reviews the account. Admins are never sandboxed.
 */
export async function isSandboxed(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  if (user === null || user.role === "admin") {
    return false;
  }
  return user.shadowban === true || user.accountStatus === "suspicious";
}

/**
 * Add points to an account's silent-infraction counter. At the threshold
 * the account is quietly shadowbanned — no error, no notice, their content
 * simply stops reaching anyone until an admin lifts it.
 */
/** Flags older than this no longer count — points decay after clean behavior. */
const FLAG_DECAY_MS = 7 * 24 * 3600_000;

export async function escalateSilently(
  ctx: MutationCtx,
  userId: Id<"users">,
  points: number,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (user === null || user.role === "admin" || user.shadowban === true) {
    return;
  }
  const now = Date.now();
  // Points decay: after a week of clean behavior the counter starts over,
  // so occasional brushes with a rate limit never snowball into a shadowban.
  const base =
    user.silentFlagsUpdatedAt !== undefined &&
    now - user.silentFlagsUpdatedAt < FLAG_DECAY_MS
      ? (user.silentFlags ?? 0)
      : 0;
  const silentFlags = base + points;
  const patch: {
    silentFlags: number;
    silentFlagsUpdatedAt: number;
    shadowban?: boolean;
  } = {
    silentFlags,
    silentFlagsUpdatedAt: now,
  };
  if (silentFlags >= SHADOWBAN_THRESHOLD) {
    patch.shadowban = true;
  }
  await ctx.db.patch(userId, patch);
}

/** Throw unless the account is allowed to post/engage. */
export async function enforceActive(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (user === null) {
    return;
  }
  if (user.accountStatus === "banned") {
    throw new Error(
      "This account has been banned for violating the PureWire Standard.",
    );
  }
  if (user.accountStatus === "restricted") {
    throw new Error(
      "This account is restricted pending review. Contact Support if this looks like a mistake.",
    );
  }
}

/**
 * Author IDs to hide from a viewer: everyone the viewer blocked, everyone
 * who blocked the viewer, and banned accounts. Empty for signed-out viewers.
 */
export async function hiddenAuthorIds(
  ctx: QueryCtx,
  viewerId: Id<"users"> | null,
): Promise<Id<"users">[]> {
  if (viewerId === null) {
    return [];
  }
  const blockedByMe = await ctx.db
    .query("blocks")
    .withIndex("by_blocker", (q) => q.eq("blockerId", viewerId))
    .take(200);
  const blockedMe = await ctx.db
    .query("blocks")
    .withIndex("by_blocked", (q) => q.eq("blockedId", viewerId))
    .take(200);
  const banned = await ctx.db
    .query("users")
    .withIndex("by_account_status", (q) => q.eq("accountStatus", "banned"))
    .take(200);
  const ids = new Set<Id<"users">>([
    ...blockedByMe.map((b) => b.blockedId),
    ...blockedMe.map((b) => b.blockerId),
    ...banned.map((u) => u._id),
  ]);
  return [...ids];
}

/**
 * Accounts whose content must not reach other members: accounts awaiting
 * admin approval AND quietly shadowbanned accounts. Their posts, comments,
 * stories, and engagement stay invisible until a human reviews them.
 * Admins always see everything so they can act; the silenced user still
 * sees their own content so nothing looks wrong to them.
 */
export async function silencedAuthorIds(
  ctx: QueryCtx,
  viewerId: Id<"users"> | null,
): Promise<Id<"users">[]> {
  if (viewerId === null) {
    return [];
  }
  const viewer = await ctx.db.get(viewerId);
  if (viewer?.role === "admin") {
    return [];
  }
  const silenced = await ctx.db
    .query("users")
    .filter((q) =>
      q.or(
        q.eq(q.field("accountStatus"), "suspicious"),
        q.eq(q.field("shadowban"), true),
      ),
    )
    .take(200);
  // The silenced user always sees their own content — the hiding applies
  // to everyone else on the platform, not to themselves.
  return silenced.filter((u) => u._id !== viewerId).map((u) => u._id);
}

/** All accounts the viewer has blocked. */
export const listBlockedUsers = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }
    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_blocker", (q) => q.eq("blockerId", userId))
      .take(200);
    return await Promise.all(
      blocks.map(async (b) => {
        const user = await ctx.db.get(b.blockedId);
        return user === null
          ? null
          : {
              ...publicUser(user),
              avatarUrl: user.avatarStorageId
                ? await ctx.storage.getUrl(user.avatarStorageId)
                : null,
            };
      }),
    );
  },
});

export const isBlocked = query({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return false;
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (target === null) {
      return false;
    }
    const block = await ctx.db
      .query("blocks")
      .withIndex("by_pair", (q) =>
        q.eq("blockerId", userId).eq("blockedId", target._id),
      )
      .first();
    return block !== null;
  },
});

export const blockUser = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (target === null) {
      throw new Error("User not found");
    }
    if (target._id === userId) {
      throw new Error("You cannot block yourself");
    }
    const existing = await ctx.db
      .query("blocks")
      .withIndex("by_pair", (q) =>
        q.eq("blockerId", userId).eq("blockedId", target._id),
      )
      .first();
    if (existing === null) {
      await ctx.db.insert("blocks", {
        blockerId: userId,
        blockedId: target._id,
      });
    }
    // Unfollow both directions so the block is clean.
    const follows = await ctx.db
      .query("follows")
      .withIndex("by_pair", (q) =>
        q.eq("followerId", userId).eq("followingId", target._id),
      )
      .first();
    if (follows !== null) {
      await ctx.db.delete(follows._id);
    }
    const reverse = await ctx.db
      .query("follows")
      .withIndex("by_pair", (q) =>
        q.eq("followerId", target._id).eq("followingId", userId),
      )
      .first();
    if (reverse !== null) {
      await ctx.db.delete(reverse._id);
    }
  },
});

export const unblockUser = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (target === null) {
      return;
    }
    const block = await ctx.db
      .query("blocks")
      .withIndex("by_pair", (q) =>
        q.eq("blockerId", userId).eq("blockedId", target._id),
      )
      .first();
    if (block !== null) {
      await ctx.db.delete(block._id);
    }
  },
});

/**
 * Admin: accounts flagged by the risk scorer or manually restricted/banned,
 * newest first, for the Security tab.
 */
export const listFlaggedAccounts = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") {
      throw new Error("Admins only");
    }
    // Only accounts that actually need a decision — suspicious signups,
    // restricted, banned, and quietly shadowbanned — not every account
    // that was ever scored.
    const result = await ctx.db
      .query("users")
      .filter((q) =>
        q.or(
          q.eq(q.field("accountStatus"), "suspicious"),
          q.eq(q.field("accountStatus"), "restricted"),
          q.eq(q.field("accountStatus"), "banned"),
          q.eq(q.field("shadowban"), true),
        ),
      )
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (u) => ({
        ...publicUser(u),
        avatarUrl: u.avatarStorageId
          ? await ctx.storage.getUrl(u.avatarStorageId)
          : null,
      })),
    );
    return { ...result, page };
  },
});

/** Admin: set an account's status (approve, restrict, ban, activate). */
export const setAccountStatus = mutation({
  args: {
    userId: v.id("users"),
    status: v.union(
      v.literal("active"),
      v.literal("suspicious"),
      v.literal("restricted"),
      v.literal("banned"),
    ),
    // The PureWire Standard principle this action cites (required for
    // restrict/ban, so every action traces to a stated rule).
    standardId: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { userId, status, standardId, note }) => {
    const adminId = await getAuthUserId(ctx);
    if (adminId === null) {
      throw new Error("Not authenticated");
    }
    const admin = await ctx.db.get(adminId);
    if (admin?.role !== "admin") {
      throw new Error("Admins only");
    }
    if (standardId !== undefined && !isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      throw new Error("User not found");
    }
    if (user.role === "admin") {
      throw new Error("Cannot change an admin account");
    }
    // Approving an account is a full restore — clear any quiet shadowban.
    const patch: {
      accountStatus: typeof status;
      shadowban?: boolean;
      moderationStandardId?: string;
      moderationNote?: string;
    } = {
      accountStatus: status,
    };
    if (status === "active") {
      patch.shadowban = false;
    }
    if (standardId !== undefined) {
      patch.moderationStandardId = standardId;
    }
    if (note !== undefined && note.trim().length > 0) {
      patch.moderationNote = note.trim();
    }
    await ctx.db.patch(userId, patch);
  },
});

/**
 * Admin: quietly silence or unsilence an account. A silenced account's
 * content and engagement silently stop reaching anyone (no errors shown to
 * the owner) until this is lifted.
 */

export const setShadowban = mutation({
  args: {
    userId: v.id("users"),
    shadowban: v.boolean(),
    // The PureWire Standard principle this silence cites, recorded on the
    // account so the moderation trail names the rule.
    standardId: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { userId, shadowban, standardId, note }) => {
    const adminId = await getAuthUserId(ctx);
    if (adminId === null) {
      throw new Error("Not authenticated");
    }
    const admin = await ctx.db.get(adminId);
    if (admin?.role !== "admin") {
      throw new Error("Admins only");
    }
    if (standardId !== undefined && !isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      throw new Error("User not found");
    }
    if (user.role === "admin") {
      throw new Error("Cannot change an admin account");
    }
    const patch: {
      shadowban: boolean;
      moderationStandardId?: string;
      moderationNote?: string;
    } = { shadowban };
    if (shadowban && standardId !== undefined) {
      patch.moderationStandardId = standardId;
    }
    if (shadowban && note !== undefined && note.trim().length > 0) {
      patch.moderationNote = note.trim();
    }
    await ctx.db.patch(userId, patch);
    // Unsilencing restores an account fully: reconcile the follow counts so
    // phantom follows made while silenced are counted once, forever.
    if (shadowban === false && user.shadowban === true) {
      // Cap the reconcile so a prolific phantom follower can't blow up a
      // single mutation's write budget.
      const phantomFollows = await ctx.db
        .query("follows")
        .withIndex("by_follower", (q) => q.eq("followerId", userId))
        .take(100);
      for (const follow of phantomFollows) {
        const target = await ctx.db.get(follow.followingId);
        if (target !== null) {
          await ctx.db.patch(target._id, {
            followersCount: (target.followersCount ?? 0) + 1,
          });
        }
      }
      await ctx.db.patch(userId, {
        followingCount: (user.followingCount ?? 0) + phantomFollows.length,
      });
    }
  },
});
