import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { AI_MEDIA_STATUS, scanText } from "./aiContent";
import {
  enforceActive,
  enforceRateLimit,
  escalateSilently,
  hiddenAuthorIds,
  isSandboxed,
  silencedAuthorIds,
} from "./security";

import { mutation, query } from "./_generated/server";

export const createStory = mutation({
  args: {
    media: v.object({
      storageId: v.id("_storage"),
      kind: v.union(
        v.literal("image"),
        v.literal("video"),
        v.literal("audio"),
      ),
    }),
    caption: v.optional(v.string()),
    // Verdict from the client-side scan action (api.aiContent.scanMediaForAi).
    aiMediaStatus: v.optional(AI_MEDIA_STATUS),
  },
  handler: async (ctx, { media, caption, aiMediaStatus }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    // Quiet sandbox: the story is accepted so nothing looks wrong, but it
    // stays invisible to everyone else until a human reviews the account.
    if (await isSandboxed(ctx, userId)) {
      return await ctx.db.insert("stories", {
        authorId: userId,
        media,
        caption,
        expiresAt: Date.now() + 24 * 3600_000,
        aiStatus: "clean",
      });
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "post");
    const captionScan = caption !== undefined ? scanText(caption) : null;
    if (captionScan?.status === "blocked") {
      throw new Error(
        "AI-generated content isn't allowed on PureWire. Say it in your own words.",
      );
    }
    if (aiMediaStatus === "blocked") {
      throw new Error(
        "This media looks AI-generated, which isn't allowed on PureWire. Upload your own original work.",
      );
    }
    // A missing scan verdict means the client never ran the scan action —
    // route to the human review queue instead of trusting it as clean.
    const needsReview =
      captionScan?.status === "review" ||
      aiMediaStatus === undefined ||
      aiMediaStatus === "review";
    if (needsReview) {
      await escalateSilently(ctx, userId, 2);
    }
    const expiresAt = Date.now() + 24 * 3600_000; // 24 hours
    return await ctx.db.insert("stories", {
      authorId: userId,
      media,
      caption,
      expiresAt,
      aiStatus: needsReview ? "review" : "clean",
    });
  },
});

export const deleteStory = mutation({
  args: { storyId: v.id("stories") },
  handler: async (ctx, { storyId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const story = await ctx.db.get(storyId);
    if (story === null) {
      return;
    }
    const user = await ctx.db.get(userId);
    if (story.authorId !== userId && user?.role !== "admin") {
      throw new Error("You can only delete your own stories.");
    }
    await ctx.db.delete(storyId);
  },
});

export const listStories = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }
    const follows = await ctx.db
      .query("follows")
      .withIndex("by_follower", (q) => q.eq("followerId", userId))
      .take(200);
    const authorIds = new Set([userId, ...follows.map((f) => f.followingId)]);
    const hidden = await hiddenAuthorIds(ctx, userId);
    const silenced = await silencedAuthorIds(ctx, userId);
    const excluded = [...hidden, ...silenced];
    const me = await ctx.db.get(userId);
    const isAdmin = me?.role === "admin";
    const now = Date.now();
    const stories = await ctx.db
      .query("stories")
      .withIndex("by_expiration", (q) => q.gte("expiresAt", now))
      .take(200);
    const mine = stories.filter(
      (s) =>
        authorIds.has(s.authorId) &&
        !excluded.includes(s.authorId) &&
        // Stories awaiting a human AI-review stay on the author's own ring
        // only — everyone else (admins included) sees them once approved.
        (s.aiStatus !== "review" || s.authorId === userId || isAdmin),
    );
    const withMeta = await Promise.all(
      mine.map(async (s) => {
        const author = await ctx.db.get(s.authorId);
        return {
          ...s,
          author: author
            ? {
                ...author,
                avatarUrl: author.avatarStorageId
                  ? await ctx.storage.getUrl(author.avatarStorageId)
                  : null,
              }
            : null,
          mediaUrl: await ctx.storage.getUrl(s.media.storageId),
          mediaKind: s.media.kind,
        };
      }),
    );
    // Group by author so each author appears once with their latest story.
    const byAuthor = new Map<string, (typeof withMeta)[number]>();
    for (const s of withMeta) {
      const key = s.authorId;
      const existing = byAuthor.get(key);
      if (!existing || s._creationTime > existing._creationTime) {
        byAuthor.set(key, s);
      }
    }
    return [...byAuthor.values()].sort((a, b) => b._creationTime - a._creationTime);
  },
});
