import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { isStandardId } from "@/lib/standard";

import { publicUser } from "./privacy";

import { mutation, query, type QueryCtx } from "./_generated/server";

const ADMIN_EMAIL = "monreodoses@gmail.com";

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
    const [users, posts, stories, tickets, follows, comments, aiReview, flagged] =
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
      security: flagged.length,
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
    return { ...result, page: result.page.map((u) => publicUser(u)) };
  },
});

export const setVerified = mutation({
  args: { userId: v.id("users"), verified: v.boolean() },
  handler: async (ctx, { userId, verified }) => {
    await requireAdmin(ctx);
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
    await ctx.db.patch(userId, { role });
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
                avatarUrl: author.avatarStorageId
                  ? await ctx.storage.getUrl(author.avatarStorageId)
                  : null,
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
                avatarUrl: author.avatarStorageId
                  ? await ctx.storage.getUrl(author.avatarStorageId)
                  : null,
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
