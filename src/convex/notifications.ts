import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { hiddenAuthorIds, suspiciousAuthorIds } from "./security";

import { mutation, query } from "./_generated/server";

export const listNotifications = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const hidden = await hiddenAuthorIds(ctx, userId);
    const suspicious = await suspiciousAuthorIds(ctx, userId);
    const excluded = [...hidden, ...suspicious];
    const result = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(paginationOpts);
    const visible = result.page.filter(
      (n) => n.actorId === undefined || !excluded.includes(n.actorId),
    );
    const page = await Promise.all(
      visible.map(async (n) => ({
        ...n,
        actor: n.actorId ? await ctx.db.get(n.actorId) : null,
        post: n.postId ? await ctx.db.get(n.postId) : null,
      })),
    );
    return { ...result, page };
  },
});

export const unreadCount = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return 0;
    }
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("read"), false))
      .collect();
    return unread.length;
  },
});

export const markAllRead = mutation({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return;
    }
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("read"), false))
      .collect();
    for (const n of unread) {
      await ctx.db.patch(n._id, { read: true });
    }
  },
});

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return;
    }
    const n = await ctx.db.get(notificationId);
    if (n !== null && n.userId === userId) {
      await ctx.db.patch(notificationId, { read: true });
    }
  },
});
