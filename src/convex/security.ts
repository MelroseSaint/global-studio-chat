import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { isStandardId } from "@/lib/standard";

import { assertAdminIpVerified } from "./adminIp";

import { internal } from "./_generated/api";
import { publicUser } from "./privacy";

/**
 * The platform owner's account — untouchable by any moderation action.
 *
 * Deliberately a local copy, not an import from ./auth: auth.ts imports
 * computeRiskScore from this module, so importing ADMIN_EMAIL back would
 * create a circular dependency. admin.ts keeps the same local copy for the
 * same reason. users.ts and account.ts import the exported const from
 * ./auth instead (no cycle there).
 */
const ADMIN_EMAIL = "monroedoses@gmail.com";

import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
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

/**
 * The moderation actions the current schema allows on the audit trail.
 * Legacy rows may hold values that predate the schema union (e.g. the old
 * "remove" record, superseded by the dedicated removalLog table) — the
 * audit trail maps anything outside this set to a safe current value.
 */
const KNOWN_MODERATION_ACTIONS = new Set([
  "silence",
  "unsilence",
  "restrict",
  "ban",
  "approve",
  "reinstate",
  "suspend",
  "unsuspend",
  "flag",
]);

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
export const verifyBotChallenge = action({
  args: { token: v.string() },
  returns: v.object({ ok: v.boolean(), enabled: v.boolean() }),
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
  // Direct messages: a generous budget for real conversations that still
  // blunts bot floods and mass-message spam.
  dm: { windowMs: 60 * 60_000, limit: 300 }, // 300 DMs/hour
  // Support tickets and reports: a generous per-user budget that still
  // blunts report-flooding — a malicious member can't drown the admin
  // queue with one-tap phishing reports.
  ticket: { windowMs: 60 * 60_000, limit: 10 }, // 10 tickets/hour
};

/**
 * Check an activity budget for a user. Returns false when the budget is
 * spent — and schedules a quiet escalation for it, which commits in its own
 * transaction. Unlike the throwing variant below, this never throws, so the
 * escalation survives. Uses a rolling window keyed on the user + action.
 */
async function checkRateLimit(
  ctx: MutationCtx,
  userId: Id<"users">,
  action: keyof typeof RATE_LIMITS,
): Promise<boolean> {
  const budget = RATE_LIMITS[action];
  if (budget === undefined) {
    return true;
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
    // Budget spent — reject the action. The quiet flag was already recorded
    // the moment this action filled the budget (below), so nothing is lost
    // by the rejection. Convex mutations are atomic: a throw rolls back
    // every write and every scheduled call made by the mutation, so a flag
    // recorded at rejection time would silently vanish for every caller
    // that rejects by throwing. Recording at budget-fill time keeps it for
    // every caller, throwing or not.
    return false;
  }
  await ctx.db.insert("rateLimits", {
    userId,
    action,
    windowStart: now,
  });
  // This action filled the activity budget. Repeatedly filling a budget is
  // the shape of a bot or farm — count it toward a quiet shadowban. The
  // escalation is scheduled in its own transaction, so it survives whether
  // this caller commits or throws afterwards.
  if (recent.length + 1 >= budget.limit) {
    await ctx.scheduler.runAfter(
      0,
      internal.security.escalateSilentlyInternal,
      { userId, points: 1, reason: "rate-limit", source: `rateLimit:${action}` },
    );
  }
  return true;
}

/**
 * Throwing budget check for mutations that reject via errors (the default).
 * Escalations for these callers use the scheduled internal mutation above,
 * so the points are recorded even though the caller throws.
 */
export async function enforceRateLimit(
  ctx: MutationCtx,
  userId: Id<"users">,
  action: keyof typeof RATE_LIMITS,
): Promise<void> {
  if (!(await checkRateLimit(ctx, userId, action))) {
    throw new Error(
      "You're moving a little too fast. Slow down and try again in a moment.",
    );
  }
}

/**
 * Non-throwing budget check for mutations that reject via a structured
 * result (createPost), so the escalation still commits with the caller.
 */
export async function enforceRateLimitResult(
  ctx: MutationCtx,
  userId: Id<"users">,
  action: keyof typeof RATE_LIMITS,
): Promise<boolean> {
  return checkRateLimit(ctx, userId, action);
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
 * Why an account collected silent-flag points. Each reason maps to the
 * abuse signal that triggered it; the Silenced admin tab breaks a flag
 * total down by these so a shadowban is never an opaque number.
 */
export type SilentFlagReason =
  | "rate-limit" // breached an activity budget
  | "duplicate" // reposted stolen/copied content
  | "ai" // repeated AI-suspicious text or media
  | "farm-reciprocal" // instant mutual follows (network boosting)
  | "farm-churn" // quick follow/unfollow churn
  | "scam" // phishing / credential- or money-harvesting attempts
  | "harassment" // racial/ethnic hate, targeted harassment, or intimidation
  | "automation"; // driven browser (headless / CDP / Playwright / Puppeteer)

/**
 * Add points to an account's silent-infraction counter, record why, and
 * bump the lifetime total. At the threshold the account is quietly
 * shadowbanned — no error, no notice, their content simply stops reaching
 * anyone until an admin lifts it. Every escalation is appended to the
 * silentFlagEvents log so the admin Silenced tab can show history and a
 * reason breakdown.
 */
/** Flags older than this no longer count — points decay after clean behavior. */
const FLAG_DECAY_MS = 7 * 24 * 3600_000;

/** Validator for the silent-flag reasons, shared with the internal escalator. */
const SILENT_FLAG_REASON = v.union(
  v.literal("rate-limit"),
  v.literal("duplicate"),
  v.literal("ai"),
  v.literal("farm-reciprocal"),
  v.literal("farm-churn"),
  v.literal("scam"),
);

/**
 * Internal entry point that lets another mutation escalate points as a
 * separate scheduled transaction. Needed because Convex mutations are
 * atomic: a mutation that must reject the action (duplicate posts,
 * rate-limit breaches) would roll back any direct escalation write — and
 * even a `ctx.scheduler.runAfter` call — together with the error. The
 * escalation is scheduled instead, so it commits in its own transaction.
 */
export const escalateSilentlyInternal = internalMutation({
  args: {
    userId: v.id("users"),
    points: v.number(),
    reason: SILENT_FLAG_REASON,
    source: v.optional(v.string()),
  },
  handler: async (ctx, { userId, points, reason, source }) => {
    await escalateSilently(ctx, userId, points, reason, source);
  },
});

export async function escalateSilently(
  ctx: MutationCtx,
  userId: Id<"users">,
  points: number,
  reason: SilentFlagReason,
  source?: string,
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
    lifetimeSilentFlags: number;
    shadowban?: boolean;
  } = {
    silentFlags,
    silentFlagsUpdatedAt: now,
    lifetimeSilentFlags: (user.lifetimeSilentFlags ?? 0) + points,
  };
  if (silentFlags >= SHADOWBAN_THRESHOLD) {
    patch.shadowban = true;
  }
  await ctx.db.patch(userId, patch);
  await ctx.db.insert("silentFlagEvents", {
    userId,
    reason,
    points,
    source,
  });
  // The moment the account crosses the threshold is itself an audit event:
  // the system silenced it, so the Security tab shows when and why.
  if (silentFlags >= SHADOWBAN_THRESHOLD) {
    await ctx.db.insert("moderationLog", {
      targetUserId: userId,
      action: "silence",
    });
  }
}

/**
 * AI-spam accelerator: accounts dedicated to AI-generated spam.
 *
 * One AI flag is a mistake; a pattern of them inside a short window is an
 * account whose whole purpose is machine-made content. Called by the
 * post/comment paths after each AI BLOCK (self-identified AI text or
 * AI-generator media — the unambiguous signals with no innocent reading).
 * It counts the account's recent `ai-blocked` events and, at the repeat
 * threshold, escalates bonus points with a distinct source (`ai-spam`) so
 * the Silenced tab's breakdown shows the account wasn't merely unlucky —
 * it was persistently pushing machine-made content and was silenced for
 * that pattern.
 *
 * Deliberately counts ONLY hard-blocked AI content, never review-tier
 * flags: the review queue exists precisely because the statistical scan
 * false-positives on genuine human writers with formal styles, so an
 * account that merely trips the review tier must never be accelerated
 * toward a shadowban — a human looks at those posts first.
 *
 * Decay is inherited from escalateSilently (same 7-day window), so a
 * genuine creator who briefly experiments never accumulates toward this.
 */
const AI_SPAM_WINDOW_MS = 7 * 24 * 3600_000;
const AI_SPAM_THRESHOLD = 3; // AI-blocked events before acceleration
const AI_SPAM_BONUS = 2;

export async function escalateForAiSpam(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (user === null || user.role === "admin" || user.shadowban === true) {
    return;
  }
  const cutoff = Date.now() - AI_SPAM_WINDOW_MS;
  const events = await ctx.db
    .query("silentFlagEvents")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(100);
  // Only unambiguous hard blocks count toward the accelerator — review
  // flags (statistical false-positive-prone) never do.
  const aiBlocks = events.filter(
    (e) =>
      e.reason === "ai" &&
      e.source === "ai-blocked" &&
      e._creationTime >= cutoff,
  );
  if (aiBlocks.length >= AI_SPAM_THRESHOLD) {
    await escalateSilently(ctx, userId, AI_SPAM_BONUS, "ai", "ai-spam");
  }
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
  // Lazy suspension expiry: a time-limited suspension ends the moment the
  // deadline passes, so the account returns to full active status on its
  // next activity without waiting for an admin or a background sweep. The
  // member is told the outcome (same "system" notification channel as
  // reinstatement). This only fires once — the deadline is cleared here.
  const now = Date.now();
  if (user.suspendedUntil !== undefined && user.suspendedUntil <= now) {
    await ctx.db.patch(userId, {
      accountStatus: "active",
      suspendedUntil: undefined,
      shadowban: false,
    });
    await ctx.db.insert("moderationLog", {
      targetUserId: userId,
      action: "unsuspend",
      note: "Suspension expired automatically.",
    });
    await ctx.db.insert("notifications", {
      userId,
      type: "system",
      message: "Your suspension has ended — your account is active again.",
      read: false,
    });
  }
  if (user.accountStatus === "banned") {
    throw new Error(
      "This account has been banned for violating the PureWire Standard.",
    );
  }
  if (user.accountStatus === "restricted") {
    const until = user.suspendedUntil;
    const when =
      until !== undefined && until > now
        ? `until ${new Date(until).toUTCString()}`
        : "pending review";
    throw new Error(
      `This account is suspended ${when}. Contact Support if this looks like a mistake.`,
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
    // Backend-verified device gate (see adminIp.ts) — admin surfaces must
    // prove the session's IP was recently observed by the backend.
    await assertAdminIpVerified(ctx);
    // Only accounts that actually need a decision — suspicious signups,
    // restricted, and banned — not every account that was ever scored.
    // Quietly shadowbanned accounts live in the dedicated Silenced tab,
    // not here, so the two queues stay distinct. (A shadowbanned account
    // that also carries a real accountStatus still appears here, because
    // that status genuinely needs Security attention.)
    const result = await ctx.db
      .query("users")
      .filter((q) =>
        q.or(
          q.eq(q.field("accountStatus"), "suspicious"),
          q.eq(q.field("accountStatus"), "restricted"),
          q.eq(q.field("accountStatus"), "banned"),
        ),
      )
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (u) => ({
        ...publicUser(u),
        // Dual-mode: external Cloudinary URL wins; otherwise resolve the
        // Convex storage id (legacy/fallback path).
        avatarUrl:
          u.avatarUrl ??
          (u.avatarStorageId ? await ctx.storage.getUrl(u.avatarStorageId) : null),
      })),
    );
    return { ...result, page };
  },
});

/**
 * Admin: complete flagged-accounts report for CSV export — every account
 * needing a Security decision (suspicious/restricted/banned), newest
 * first, including the bot/farm signals and the automation-likelihood
 * score with its matched signal names. Non-paginated so a moderator can
 * pull the whole queue in one file instead of paging through the tab;
 * capped at 1000 rows so a single export can't blow a query's response
 * budget (the tab itself remains the surface for very large queues).
 *
 * Privacy: exactly the `publicUser` shape the tab already shows — masked
 * email, no plain address, no coordinates — plus the moderation fields.
 */
export const exportFlaggedAccounts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") {
      throw new Error("Admins only");
    }
    // Backend-verified device gate (see adminIp.ts) — admin surfaces must
    // prove the session's IP was recently observed by the backend.
    await assertAdminIpVerified(ctx);
    const rows = await ctx.db
      .query("users")
      .filter((q) =>
        q.or(
          q.eq(q.field("accountStatus"), "suspicious"),
          q.eq(q.field("accountStatus"), "restricted"),
          q.eq(q.field("accountStatus"), "banned"),
        ),
      )
      .order("desc")
      .take(1000);
    return rows.map((u) => ({
      ...publicUser(u),
      accountStatus: u.accountStatus ?? "active",
      riskScore: u.riskScore ?? 0,
      riskReasons: u.riskReasons ?? [],
      shadowban: u.shadowban ?? false,
      silentFlags: u.silentFlags ?? 0,
      automationScore: u.automationScore ?? null,
      automationSignals: u.automationSignals ?? [],
      automationReportedAt: u.automationReportedAt ?? null,
      moderationStandardId: u.moderationStandardId ?? null,
      moderationNote: u.moderationNote ?? null,
      // When a suspension lifts on its own (if the account is suspended) —
      // included in the export so the Security report shows deadlines.
      suspendedUntil: u.suspendedUntil ?? null,
      createdAt: u._creationTime,
    }));
  },
});

/**
 * Admin: accounts quietly shadowbanned by the silent-flag system, newest
 * first, for the dedicated Silenced tab. Each row carries the current
 * (decayed) flag total, the lifetime total that never resets, and a reason
 * breakdown summed from the event log so a shadowban is never an opaque
 * number. Suspicious/restricted/banned accounts stay in the Security tab.
 */
export const listSilencedAccounts = query({
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
    // Backend-verified device gate (see adminIp.ts) — admin surfaces must
    // prove the session's IP was recently observed by the backend.
    await assertAdminIpVerified(ctx);
    const result = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("shadowban"), true))
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (u) => {
        const events = await ctx.db
          .query("silentFlagEvents")
          .withIndex("by_user", (q) => q.eq("userId", u._id))
          .take(200);
        const breakdown: Record<string, number> = {};
        for (const event of events) {
          breakdown[event.reason] = (breakdown[event.reason] ?? 0) + event.points;
        }
        // When the silence began: the moderation log entry that silenced the
        // account (system or admin), falling back to the first flag event.
        const actions = await ctx.db
          .query("moderationLog")
          .withIndex("by_target", (q) => q.eq("targetUserId", u._id))
          .take(200);
        const silenced = actions
          .filter((a) => a.action === "silence")
          .sort((a, b) => b._creationTime - a._creationTime)[0];
        const silencedAt =
          silenced?._creationTime ??
          (events.length > 0
            ? Math.min(...events.map((e) => e._creationTime))
            : undefined);
        return {
          ...publicUser(u),
          // Dual-mode: external Cloudinary URL wins; otherwise resolve the
          // Convex storage id (legacy/fallback path).
          avatarUrl:
            u.avatarUrl ??
            (u.avatarStorageId ? await ctx.storage.getUrl(u.avatarStorageId) : null),
          silentFlags: u.silentFlags ?? 0,
          lifetimeSilentFlags: u.lifetimeSilentFlags ?? 0,
          silentEventCount: events.length,
          breakdown,
          silencedAt,
        };
      }),
    );
    return { ...result, page };
  },
});

/**
 * Admin: a single account's full silent-flag history — every escalation
 * with its reason, points, and timestamp, plus the lifetime total and the
 * reason breakdown. Powers the expandable history in the Silenced tab.
 */
export const silentFlagHistory = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const adminId = await getAuthUserId(ctx);
    if (adminId === null) {
      throw new Error("Not authenticated");
    }
    const me = await ctx.db.get(adminId);
    if (me?.role !== "admin") {
      throw new Error("Admins only");
    }
    // Backend-verified device gate (see adminIp.ts) — admin surfaces must
    // prove the session's IP was recently observed by the backend.
    await assertAdminIpVerified(ctx);
    const user = await ctx.db.get(userId);
    if (user === null) {
      return null;
    }
    const events = await ctx.db
      .query("silentFlagEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    const actions = await ctx.db
      .query("moderationLog")
      .withIndex("by_target", (q) => q.eq("targetUserId", userId))
      .take(200);
    const breakdown: Record<string, number> = {};
    for (const event of events) {
      breakdown[event.reason] = (breakdown[event.reason] ?? 0) + event.points;
    }
    // Resolve actor usernames once so the trail can name who acted.
    const actorIds = [
      ...new Set(
        actions
          .map((a) => a.actorId)
          .filter((id): id is Id<"users"> => id !== undefined),
      ),
    ];
    const actorNames = new Map<Id<"users">, string>();
    for (const id of actorIds) {
      const actor = await ctx.db.get(id);
      if (actor !== null) {
        actorNames.set(id, actor.username ?? actor.name ?? "Admin");
      }
    }
    return {
      silentFlags: user.silentFlags ?? 0,
      lifetimeSilentFlags: user.lifetimeSilentFlags ?? 0,
      breakdown,
      events: events
        .sort((a, b) => b._creationTime - a._creationTime)
        .map((e) => ({
          reason: e.reason,
          points: e.points,
          source: e.source ?? null,
          createdAt: e._creationTime,
        })),
      actions: actions
        .sort((a, b) => b._creationTime - a._creationTime)
        .map((a) => ({
          // Legacy rows may carry an action value that predates the current
          // schema union (e.g. the old "remove" record, since superseded by
          // the dedicated removalLog table) — map anything unknown to the
          // closest current action so the typed value never lies.
          action: KNOWN_MODERATION_ACTIONS.has(a.action as string)
            ? a.action
            : "flag",
          actor: a.actorId !== undefined ? (actorNames.get(a.actorId) ?? "Admin") : null,
          standardId: a.standardId ?? null,
          note: a.note ?? null,
          createdAt: a._creationTime,
        })),
    };
  },
});

/** Admin: quietly unsilence a batch of accounts in one action. */
export const bulkUnsilence = mutation({
  args: { userIds: v.array(v.id("users")) },
  handler: async (ctx, { userIds }) => {
    const adminId = await getAuthUserId(ctx);
    if (adminId === null) {
      throw new Error("Not authenticated");
    }
    const admin = await ctx.db.get(adminId);
    if (admin?.role !== "admin") {
      throw new Error("Admins only");
    }
    // Backend-verified device gate (see adminIp.ts).
    await assertAdminIpVerified(ctx);
    // Cap the batch so a large selection can't blow a single mutation's
    // write budget — each restore can reconcile up to 100 phantom follows.
    for (const userId of userIds.slice(0, 50)) {
      await unsilenceAccount(ctx, userId);
      await ctx.db.insert("moderationLog", {
        targetUserId: userId,
        actorId: adminId,
        action: "unsilence",
      });
    }
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
    // Backend-verified device gate (see adminIp.ts).
    await assertAdminIpVerified(ctx);
    if (standardId !== undefined && !isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      throw new Error("User not found");
    }
    // The owner account is untouchable — checked by email, not role, so it
    // holds even if the role field were ever corrupted first.
    if (user.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be changed.");
    }
    if (user.role === "admin") {
      throw new Error("Cannot change an admin account");
    }
    // Approving an account is a full restore — clear any quiet shadowban
    // and any time-limited suspension deadline.
    const patch: {
      accountStatus: typeof status;
      shadowban?: boolean;
      suspendedUntil?: undefined;
      moderationStandardId?: string;
      moderationNote?: string;
    } = {
      accountStatus: status,
    };
    if (status === "active") {
      patch.shadowban = false;
      patch.suspendedUntil = undefined;
    }
    if (standardId !== undefined) {
      patch.moderationStandardId = standardId;
    }
    if (note !== undefined && note.trim().length > 0) {
      patch.moderationNote = note.trim();
    }
    await ctx.db.patch(userId, patch);
    // Audit the admin action so the trail records who changed what, when.
    const action =
      status === "banned"
        ? "ban"
        : status === "restricted"
          ? "restrict"
          : status === "active"
            ? "approve"
            : "flag";
    await ctx.db.insert("moderationLog", {
      targetUserId: userId,
      actorId: adminId,
      action,
      standardId,
      note: note !== undefined && note.trim().length > 0 ? note.trim() : undefined,
    });
  },
});

/**
 * Admin: suspend an account for a fixed duration, with the reason and the
 * cited Standard principle both REQUIRED.
 *
 * A suspension is a time-limited restriction: the account can't post or
 * engage (enforceActive rejects), and its row carries `suspendedUntil` so
 * the Security tab shows exactly when it comes back. The moment the
 * deadline passes, the account auto-returns to active on its next activity
 * (see enforceActive) and the member is notified — no manual lift needed.
 * Lifting it early is a reinstate (or setAccountStatus active), which
 * clears the deadline.
 */
export const suspendAccount = mutation({
  args: {
    userId: v.id("users"),
    // How long the suspension lasts, in hours (1..8760 = up to one year).
    durationHours: v.number(),
    // The PureWire Standard principle this suspension cites (required —
    // every action traces to a stated rule).
    standardId: v.string(),
    // Why this account is being suspended (required — recorded verbatim
    // on the audit trail and shown to the member).
    note: v.string(),
  },
  handler: async (ctx, { userId, durationHours, standardId, note }) => {
    const adminId = await getAuthUserId(ctx);
    if (adminId === null) {
      throw new Error("Not authenticated");
    }
    const admin = await ctx.db.get(adminId);
    if (admin?.role !== "admin") {
      throw new Error("Admins only");
    }
    // Backend-verified device gate (see adminIp.ts).
    await assertAdminIpVerified(ctx);
    if (!Number.isFinite(durationHours) || durationHours < 1 || durationHours > 8760) {
      throw new Error("Duration must be between 1 hour and 1 year.");
    }
    if (!isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const reason = note.trim();
    if (reason.length === 0) {
      throw new Error("A reason is required to suspend an account.");
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      throw new Error("User not found");
    }
    // The owner account is untouchable — checked by email, not role.
    if (user.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be changed.");
    }
    if (user.role === "admin") {
      throw new Error("Cannot change an admin account");
    }
    const until = Date.now() + Math.round(durationHours) * 3600_000;
    await ctx.db.patch(userId, {
      accountStatus: "restricted",
      suspendedUntil: until,
      shadowban: false,
      moderationStandardId: standardId,
      moderationNote: reason,
    });
    await ctx.db.insert("moderationLog", {
      targetUserId: userId,
      actorId: adminId,
      action: "suspend",
      standardId,
      note: reason,
    });
    // Honest notice: a suspension is visible (the account can't post), so
    // the member is told when it lifts and why — unlike a quiet shadowban,
    // which stays invisible by design.
    await ctx.db.insert("notifications", {
      userId,
      type: "system",
      message: `Your account has been suspended until ${new Date(until).toUTCString()}. Reason: ${reason}`,
      read: false,
    });
  },
});

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
    // Backend-verified device gate (see adminIp.ts).
    await assertAdminIpVerified(ctx);
    if (standardId !== undefined && !isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      throw new Error("User not found");
    }
    // The owner account is untouchable — checked by email, not role, so it
    // holds even if the role field were ever corrupted first.
    if (user.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be changed.");
    }
    if (user.role === "admin") {
      throw new Error("Cannot change an admin account");
    }
    if (shadowban) {
      const patch: {
        shadowban: boolean;
        moderationStandardId?: string;
        moderationNote?: string;
      } = { shadowban: true };
      if (standardId !== undefined) {
        patch.moderationStandardId = standardId;
      }
      if (note !== undefined && note.trim().length > 0) {
        patch.moderationNote = note.trim();
      }
      await ctx.db.patch(userId, patch);
      await ctx.db.insert("moderationLog", {
        targetUserId: userId,
        actorId: adminId,
        action: "silence",
        standardId,
        note: note !== undefined && note.trim().length > 0 ? note.trim() : undefined,
      });
    } else {
      // Unsilencing restores an account fully: reconcile the follow counts
      // so phantom follows made while silenced are counted once, forever.
      await unsilenceAccount(ctx, userId);
      await ctx.db.insert("moderationLog", {
        targetUserId: userId,
        actorId: adminId,
        action: "unsilence",
        standardId,
        note: note !== undefined && note.trim().length > 0 ? note.trim() : undefined,
      });
    }
  },
});

/**
 * Restore a silently silenced account to the public surface and reconcile
 * the follow counts for phantom follows made while silenced — capped so a
 * prolific phantom follower can't blow up a single mutation's write budget.
 * Exported so admin reinstatement can reuse the same restore path.
 */
export async function unsilenceAccount(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (user === null || user.role === "admin") {
    return;
  }
  await ctx.db.patch(userId, { shadowban: false });
  if (user.shadowban !== true) {
    return;
  }
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

/**
 * Admin: fully reinstate a moderated account, recording the reason.
 *
 * Restores an account that still exists but was taken down — banned,
 * restricted, suspicious (pending approval), or quietly silenced — to full
 * active status in one action: status back to "active", any quiet
 * shadowban lifted, the silent-flag counter reset (the lifetime total
 * stays as the permanent record), and phantom-follow counts reconciled.
 * The reinstatement reason is REQUIRED and is recorded on the account's
 * moderation trail, so every restore leaves a "who, when, why" like every
 * restriction does.
 *
 * Deliberately does not resurrect permanently removed accounts: the erasure
 * sweep destroys the user row and all of its data by design (zero-data
 * privacy), so there is nothing left to restore — a removed person starts
 * fresh with a new verified account instead.
 */
export const reinstateAccount = mutation({
  args: {
    userId: v.id("users"),
    // Required: why the account is being reinstated ("false positive",
    // "appeal granted", …) — recorded on the audit trail.
    note: v.string(),
    // Optional: the PureWire Standard principle behind the call, when one
    // applies (e.g. the flag it was taken down under turned out to be a
    // false positive).
    standardId: v.optional(v.string()),
  },
  handler: async (ctx, { userId, note, standardId }) => {
    const adminId = await getAuthUserId(ctx);
    if (adminId === null) {
      throw new Error("Not authenticated");
    }
    const admin = await ctx.db.get(adminId);
    if (admin?.role !== "admin") {
      throw new Error("Admins only");
    }
    // Backend-verified device gate (see adminIp.ts).
    await assertAdminIpVerified(ctx);
    if (standardId !== undefined && !isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const reason = note.trim();
    if (reason.length === 0) {
      throw new Error("A reason is required to reinstate an account.");
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      throw new Error(
        "This account was permanently removed — no data survives to restore. They can sign up again.",
      );
    }
    // The owner account is untouchable — checked by email, not role.
    if (user.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be changed.");
    }
    if (user.role === "admin") {
      throw new Error("Cannot change an admin account");
    }
    // Full restore: lift any quiet silence and reconcile phantom follows,
    // then flip the status to active and reset the flag counter (the
    // lifetime total is kept so the account's whole history stays visible).
    await unsilenceAccount(ctx, userId);
    await ctx.db.patch(userId, {
      accountStatus: "active",
      silentFlags: 0,
      suspendedUntil: undefined,
    });
    await ctx.db.insert("moderationLog", {
      targetUserId: userId,
      actorId: adminId,
      action: "reinstate",
      standardId,
      note: reason,
    });
    // Tell the member the outcome: a wrongly-taken-down account learns it's
    // active again without having to contact support. The Notifications
    // page renders the "system" case with the message verbatim; no actor is
    // set (it's from the platform, not a member). Only when the account was
    // actually moderated (pre-restore state) — a reinstate of an
    // already-active account is a no-op restore and must not send a
    // spurious welcome-back.
    const wasModerated =
      (user.accountStatus ?? "active") !== "active" || user.shadowban === true;
    if (wasModerated) {
      await ctx.db.insert("notifications", {
        userId,
        type: "system",
        message: "Your account was reinstated — welcome back.",
        read: false,
      });
    }
  },
});
