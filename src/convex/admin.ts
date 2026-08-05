import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { isStandardId } from "@/lib/standard";

import { eraseAccount } from "./account";
import { cleanupMediaItems, sweepPostEngagement } from "./mediaCleanup";
import { publicUser } from "./privacy";

import { mutation, query, type QueryCtx } from "./_generated/server";

const ADMIN_EMAIL = "monroedoses@gmail.com";

/**
 * Promote the admin account if it predates the role system (e.g. created
 * during earlier testing). Safe to call on every app load.
 */
export const ensureAdminStatus = mutation({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return;
    }
    const me = await ctx.db.get(userId);
    if (me?.email === ADMIN_EMAIL && me.role !== "admin") {
      await ctx.db.patch(userId, { role: "admin", verified: true });
    }
  },
});

async function requireAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not authenticated");
  }
  const me = await ctx.db.get(userId);
  if (me?.role !== "admin") {
    throw new Error("Admins only");
  }
  return userId;
}

export const dashboardStats = query({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [users, posts, stories, tickets, follows, comments, aiReview, racismReview, flagged] =
      await Promise.all([
        ctx.db.query("users").collect(),
        ctx.db.query("posts").collect(),
        ctx.db.query("stories").collect(),
        ctx.db.query("supportTickets").collect(),
        ctx.db.query("follows").collect(),
        ctx.db.query("comments").collect(),
        ctx.db
          .query("posts")
          .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
          .collect(),
        // Racism review is a subset of AI review — posts flagged with a
        // racism category that a human moderator must judge.
        ctx.db
          .query("posts")
          .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
          .filter((q) => q.neq(q.field("racismReviewCategory"), undefined))
          .collect(),
        // Only accounts that actually need a decision — not every user
        // that was ever auto-scored "active".
        ctx.db
          .query("users")
          .filter((q) =>
            q.or(
              q.eq(q.field("accountStatus"), "suspicious"),
              q.eq(q.field("accountStatus"), "restricted"),
              q.eq(q.field("accountStatus"), "banned"),
              q.eq(q.field("shadowban"), true),
            ),
          )
          .collect(),
      ]);
    return {
      users: users.length,
      posts: posts.length,
      stories: stories.length,
      tickets: tickets.length,
      openTickets: tickets.filter((t) => t.status === "open").length,
      follows: follows.length,
      comments: comments.length,
      likes: (await ctx.db.query("likes").collect()).length,
      aiReview: aiReview.length,
      racismReview: racismReview.length,
      security: flagged.length,
    };
  },
});

/**
 * Lightweight moderation workload for admins — the two queues that need a
 * human decision: open support tickets and posts waiting on AI review.
 * Indexed on both tables (by_status, by_ai_status), so it stays cheap to
 * call from the app shell on every load (powers the Admin nav badge and the
 * installed PWA's app-icon badge).
 */
export const moderationWorkload = query({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [openTickets, aiReview] = await Promise.all([
      ctx.db
        .query("supportTickets")
        .withIndex("by_status", (q) => q.eq("status", "open"))
        .collect(),
      ctx.db
        .query("posts")
        .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
        .collect(),
    ]);
    return {
      openTickets: openTickets.length,
      aiReview: aiReview.length,
    };
  },
});

export const listUsers = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("users")
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...result,
      // Flag the owner account so the admin UI can mark its row protected
      // and disable every control on it.
      page: result.page.map((u) => ({
        ...publicUser(u),
        isOwner: u.email === ADMIN_EMAIL,
      })),
    };
  },
});

export const setVerified = mutation({
  args: { userId: v.id("users"), verified: v.boolean() },
  handler: async (ctx, { userId, verified }) => {
    await requireAdmin(ctx);
    // The owner account is untouchable — its verified badge can never be
    // stripped, even by the owner. Checked by email, not role.
    const target = await ctx.db.get(userId);
    if (target !== null && target.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be changed.");
    }
    await ctx.db.patch(userId, { verified });
  },
});

export const setRole = mutation({
  args: {
    userId: v.id("users"),
    role: v.union(v.literal("user"), v.literal("creator"), v.literal("admin")),
  },
  handler: async (ctx, { userId, role }) => {
    await requireAdmin(ctx);
    // The owner account can never be demoted — the platform is not
    // self-destructible. Checked by email, not role.
    const target = await ctx.db.get(userId);
    if (target !== null && target.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be changed.");
    }
    await ctx.db.patch(userId, { role });
  },
});

/**
 * Permanently remove an account — the same full erasure a user triggers
 * with "delete my account", run by an admin for accounts that must be
 * gone entirely (repeat offenders, farm networks, impersonators). The
 * platform is not self-destructible: the owner account (ADMIN_EMAIL) and
 * the admin's own account cannot be removed this way.
 *
 * Like every other admin action, the removal must cite the PureWire
 * Standard principle it is taken under. Before the erasure sweep runs,
 * the account's public identity — username, display name, and the salted
 * one-way email hash (never the plain address) — is snapshotted into the
 * private removal log, together with who acted, the cited principle, and
 * when. That record lives in a separate table the erasure sweep never
 * touches (see eraseAccount), so "who was removed, when, by whom" is
 * always knowable — and it is strictly one-way: it can never recreate the
 * account or any of its data.
 */
export const removeAccount = mutation({
  args: {
    userId: v.id("users"),
    // Required: the PureWire Standard principle this removal cites, so a
    // permanent removal is never an unqualified action.
    standardId: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { userId, standardId, note }) => {
    const me = await requireAdmin(ctx);
    if (userId === me) {
      throw new Error("You can't remove your own account from here.");
    }
    if (!isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const target = await ctx.db.get(userId);
    if (target !== null && target.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be removed.");
    }
    // One-way safety net FIRST: snapshot the account's public identity
    // before the sweep erases every trace of it. The email is stored as
    // the salted one-way hash — the same value already on the user record
    // — never the plain address. `removalLog` is a separate table that
    // eraseAccount never sweeps, so this record survives the erasure.
    await ctx.db.insert("removalLog", {
      userId,
      username: target?.username ?? undefined,
      name: target?.name ?? undefined,
      emailHash: target?.emailHash ?? undefined,
      actorId: me,
      standardId,
      note: note !== undefined && note.trim().length > 0 ? note.trim() : undefined,
    });
    await eraseAccount(ctx, userId);
  },
});

/**
 * Admin: the private removal log — every permanent removal with the
 * snapshotted public identity (username, display name, salted email
 * hash), who acted, the cited Standard principle, the note, and when.
 * Read from the dedicated removalLog table, which the erasure sweep never
 * touches, so this list is complete even for accounts whose data is long
 * gone. One-way: admins can see who was removed; nothing here can restore
 * the account.
 */
export const listRemovals = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("removalLog")
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (entry) => {
        const actor =
          entry.actorId !== undefined ? await ctx.db.get(entry.actorId) : null;
        return {
          username: entry.username ?? null,
          name: entry.name ?? null,
          // The salted one-way email hash — displayable, but it can never
          // be reversed into the address, and no restore path uses it.
          emailHash: entry.emailHash ?? null,
          actorUsername: actor?.username ?? actor?.name ?? null,
          standardId: entry.standardId ?? null,
          note: entry.note ?? null,
          createdAt: entry._creationTime,
        };
      }),
    );
    return { ...result, page };
  },
});

export const listRecentPosts = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("posts")
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (p) => {
        const author = await ctx.db.get(p.authorId);
        return {
          ...p,
          author: author
            ? {
                ...publicUser(author),
                avatarUrl:
                  author.avatarUrl ??
                  (author.avatarStorageId
                    ? await ctx.storage.getUrl(author.avatarStorageId)
                    : null),
              }
            : null,
        };
      }),
    );
    return { ...result, page };
  },
});

export const moderatePost = mutation({
  args: {
    postId: v.id("posts"),
    // The PureWire Standard principle the removal cites, recorded on the
    // author's moderation trail so the action names the rule.
    standardId: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { postId, standardId, note }) => {
    await requireAdmin(ctx);
    if (standardId !== undefined && !isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const post = await ctx.db.get(postId);
    if (post !== null) {
      const author = await ctx.db.get(post.authorId);
      if (author !== null) {
        const patch: {
          postsCount: number;
          moderationStandardId?: string;
          moderationNote?: string;
        } = {
          postsCount: Math.max(0, (author.postsCount ?? 0) - 1),
        };
        if (standardId !== undefined) {
          patch.moderationStandardId = standardId;
        }
        if (note !== undefined && note.trim().length > 0) {
          patch.moderationNote = note.trim();
        }
        await ctx.db.patch(author._id, patch);
      }
      // The files die with the removed post — Convex storage ids inline,
      // external Cloudinary keys through the fire-and-forget batch delete.
      await cleanupMediaItems(ctx, post.media ?? []);
      // The engagement rows die with the post too — the same sweep the
      // user-facing deletePost does, so no orphan likes/comments/shares
      // rows outlive a moderated post.
      await sweepPostEngagement(ctx, postId);
      await ctx.db.delete(postId);
    }
  },
});

/** Posts whose text or media was flagged as possibly AI-generated. */
export const listAiReview = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("posts")
      .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (p) => {
        const author = await ctx.db.get(p.authorId);
        return {
          ...p,
          author: author
            ? {
                ...publicUser(author),
                avatarUrl:
                  author.avatarUrl ??
                  (author.avatarStorageId
                    ? await ctx.storage.getUrl(author.avatarStorageId)
                    : null),
              }
            : null,
        };
      }),
    );
    return { ...result, page };
  },
});

/** Admin decides a flagged post is fine — mark it clean. */
export const resolveAiReview = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    await requireAdmin(ctx);
    const post = await ctx.db.get(postId);
    if (post !== null) {
      await ctx.db.patch(postId, { aiStatus: "clean" });
    }
  },
});

/**
 * Admin clears a whole page of flagged posts at once. Genuine creators with
 * formal writing styles get mis-flagged by the statistical scan; approving
 * in bulk keeps the human review queue moving instead of blocking their
 * content behind dozens of individual clicks.
 */
export const resolveAiReviewBatch = mutation({
  args: { postIds: v.array(v.id("posts")) },
  handler: async (ctx, { postIds }) => {
    await requireAdmin(ctx);
    for (const postId of postIds) {
      const post = await ctx.db.get(postId);
      if (post !== null && post.aiStatus === "review") {
        await ctx.db.patch(postId, { aiStatus: "clean" });
      }
    }
  },
});

/** Racism-prevention review: posts flagged with a racism signal that a
 *  human moderator must judge — same pattern as the AI review queue. */
export const listRacismReview = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("posts")
      .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
      .filter((q) => q.neq(q.field("racismReviewCategory"), undefined))
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (p) => {
        const author = await ctx.db.get(p.authorId);
        return {
          ...p,
          author: author
            ? {
                ...publicUser(author),
                avatarUrl:
                  author.avatarUrl ??
                  (author.avatarStorageId
                    ? await ctx.storage.getUrl(author.avatarStorageId)
                    : null),
              }
            : null,
        };
      }),
    );
    return { ...result, page };
  },
});

/** Admin clears a racism-flagged post — it stays live but the flag is gone. */
export const resolveRacismReview = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    await requireAdmin(ctx);
    const post = await ctx.db.get(postId);
    if (post !== null) {
      await ctx.db.patch(postId, {
        aiStatus: "clean" as const,
        racismReviewCategory: undefined,
        racismEvasionScore: undefined,
      });
    }
  },
});

/** Admin bulk-clears racism-flagged posts. */
export const resolveRacismReviewBatch = mutation({
  args: { postIds: v.array(v.id("posts")) },
  handler: async (ctx, { postIds }) => {
    await requireAdmin(ctx);
    for (const postId of postIds) {
      const post = await ctx.db.get(postId);
      if (post !== null && post.racismReviewCategory !== undefined) {
        await ctx.db.patch(postId, {
          aiStatus: "clean" as const,
          racismReviewCategory: undefined,
          racismEvasionScore: undefined,
        });
      }
    }
  },
});
