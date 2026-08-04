import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { AI_MEDIA_STATUS, scanText } from "./aiContent";
import { scanForPhishing } from "./phishing";
import { publicUser } from "./privacy";
import {
  enforceActive,
  enforceRateLimit,
  escalateSilently,
  hiddenAuthorIds,
  isSandboxed,
  silencedAuthorIds,
} from "./security";

import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

export const createStory = mutation({
  args: {
    media: v.object({
      // Dual-mode: a Convex storage id (legacy/fallback) OR an external
      // Cloudinary url + key (primary path once CLOUDINARY_* is set).
      storageId: v.optional(v.id("_storage")),
      url: v.optional(v.string()),
      key: v.optional(v.string()),
      kind: v.union(
        v.literal("image"),
        v.literal("video"),
        v.literal("audio"),
      ),
      stripped: v.optional(v.boolean()),
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
      const storyId = await ctx.db.insert("stories", {
        authorId: userId,
        media,
        caption,
        expiresAt: Date.now() + 24 * 3600_000,
        aiStatus: "clean",
      });
      if (media.kind === "video") {
        await ctx.scheduler.runAfter(
          0,
          internal.videoStrip.stripVideoMetadataInternal,
          { storyId, media: [media] },
        );
      }
      return { ok: true, storyId };
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "post");
    const captionScan = caption !== undefined ? scanText(caption) : null;
    const phishScan = caption !== undefined ? scanForPhishing(caption) : null;
    if (phishScan?.status === "blocked") {
      // Rejected — and the rejection is itself an abuse signal, escalated
      // INLINE (a thrown error would roll the flag back), so repeat
      // scammers quietly shadowban.
      await escalateSilently(ctx, userId, 3, "scam", "phish-block-story");
      return {
        ok: false,
        error:
          "That looks like a phishing or scam link — nothing on PureWire may try to steal accounts, money, or personal information.",
      };
    }
    if (captionScan?.status === "blocked") {
      // Rejected — and the rejection is itself an abuse signal. Escalated
      // INLINE with the structured result (a thrown error would roll the
      // flag back), so repeat offenders quietly shadowban.
      await escalateSilently(ctx, userId, 3, "ai", "ai-blocked");
      return {
        ok: false,
        error:
          "AI-generated content isn't allowed on PureWire. Say it in your own words.",
      };
    }
    if (aiMediaStatus === "blocked") {
      await escalateSilently(ctx, userId, 3, "ai", "ai-blocked");
      return {
        ok: false,
        error:
          "This media looks AI-generated, which isn't allowed on PureWire. Upload your own original work.",
      };
    }
    // A missing scan verdict means the client never ran the scan action —
    // route to the human review queue instead of trusting it as clean.
    const needsReview =
      captionScan?.status === "review" ||
      aiMediaStatus === undefined ||
      aiMediaStatus === "review" ||
      phishScan?.status === "review";
    if (needsReview) {
      // Phishing-suspicious captions count as their own signal so the
      // Silenced tab shows the mix behind a quiet shadowban.
      await escalateSilently(
        ctx,
        userId,
        2,
        phishScan?.status === "review" ? "scam" : "ai",
        phishScan?.status === "review" ? "phish-review-story" : "ai-review",
      );
    }
    const expiresAt = Date.now() + 24 * 3600_000; // 24 hours
    const storyId = await ctx.db.insert("stories", {
      authorId: userId,
      media,
      caption,
      expiresAt,
      aiStatus: needsReview ? "review" : "clean",
      // The review reason already carries the "Suspected phishing —"
      // prefix from scanForPhishing — used as-is, no double prefix.
      aiStatusReason:
        phishScan?.status === "review" ? phishScan.reason : undefined,
    });
    if (media.kind === "video") {
      await ctx.scheduler.runAfter(
        0,
        internal.videoStrip.stripVideoMetadataInternal,
        { storyId, media: [media] },
      );
    }
    return { ok: true, storyId };
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
                ...publicUser(author),
                avatarUrl:
                  author.avatarUrl ??
                  (author.avatarStorageId
                    ? await ctx.storage.getUrl(author.avatarStorageId)
                    : null),
              }
            : null,
          mediaUrl:
            s.media.url ??
            (s.media.storageId
              ? await ctx.storage.getUrl(s.media.storageId)
              : null),
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
