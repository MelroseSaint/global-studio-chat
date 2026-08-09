import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { countUnreadDms } from "./dms";
import { publicUser } from "./privacy";
import { hiddenAuthorIds, silencedAuthorIds } from "./security";

import { mutation, query, type QueryCtx } from "./_generated/server";

import type { Id } from "./_generated/dataModel";

export const listNotifications = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const hidden = await hiddenAuthorIds(ctx, userId);
    const silenced = await silencedAuthorIds(ctx, userId);
    const excluded = [...hidden, ...silenced];
    const result = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(paginationOpts);
    const visible = result.page.filter(
      (n) => n.actorId === undefined || !excluded.includes(n.actorId),
    );
    const page = await Promise.all(
      visible.map(async (n) => {
        const actor = n.actorId ? await ctx.db.get(n.actorId) : null;
        const post = n.postId ? await ctx.db.get(n.postId) : null;
        // The post shared into the host post's comments ("comment-share")
        // — the bell previews this instead of the host post's text.
        const sharedPost = n.sharedPostId ? await ctx.db.get(n.sharedPostId) : null;
        return {
          ...n,
          actor: actor ? publicUser(actor) : null,
          post,
          sharedPost,
        };
      }),
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
    return await countUnreadNotifications(ctx, userId);
  },
});

/** Unread notification rows for a user (shared by unreadCount + shellCounts). */
async function countUnreadNotifications(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<number> {
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .filter((q) => q.eq(q.field("read"), false))
    .collect();
  return unread.length;
}

/**
 * Combined unread counts for the app shell's badges — notifications and
 * DMs in ONE round trip instead of two, so every authenticated page load
 * saves a request. Returns 0/0 for signed-out viewers, matching the
 * individual queries.
 */
export const shellCounts = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { unread: 0, dmUnread: 0 };
    }
    const [unread, dmUnread] = await Promise.all([
      countUnreadNotifications(ctx, userId),
      countUnreadDms(ctx, userId),
    ]);
    return { unread, dmUnread };
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
