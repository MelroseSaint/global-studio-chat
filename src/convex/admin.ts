import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { mutation, query } from "./_generated/server";

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

async function requireAdmin(ctx: any) {
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
    const [users, posts, stories, tickets, follows, comments] =
      await Promise.all([
        ctx.db.query("users").collect(),
        ctx.db.query("posts").collect(),
        ctx.db.query("stories").collect(),
        ctx.db.query("supportTickets").collect(),
        ctx.db.query("follows").collect(),
        ctx.db.query("comments").collect(),
      ]);
    return {
      users: users.length,
      posts: posts.length,
      stories: stories.length,
      tickets: tickets.length,
      openTickets: tickets.filter((t: any) => t.status === "open").length,
      follows: follows.length,
      comments: comments.length,
      likes: (await ctx.db.query("likes").collect()).length,
    };
  },
});

export const listUsers = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("users")
      .order("desc")
      .paginate(paginationOpts);
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
                ...author,
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
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    await requireAdmin(ctx);
    const post = await ctx.db.get(postId);
    if (post !== null) {
      const author = await ctx.db.get(post.authorId);
      if (author !== null) {
        await ctx.db.patch(author._id, {
          postsCount: Math.max(0, (author.postsCount ?? 0) - 1),
        });
      }
      await ctx.db.delete(postId);
    }
  },
});
