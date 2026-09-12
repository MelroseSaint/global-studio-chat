import { v } from "convex/values";

import { stripVideos } from "./media";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

/**
 * Scheduled server-side video-privacy safety net.
 *
 * The composer and story dialog call `media.stripVideoMetadata` before the
 * document exists, which covers the standard UI path. This internal action
 * covers every other path: `createPost` and `createStory` schedule it the
 * moment a video-bearing post/story is inserted, so even a client that
 * never runs the strip action (an API caller, an old build, a future
 * mobile client) can never leave a live document referencing a video that
 * still carries GPS or device metadata atoms.
 *
 * It reuses the same `stripVideos` helper as the public action, then
 * patches the document's storage ids via `media.applyVideoStrip`.
 */
export const stripVideoMetadataInternal = internalAction({
  args: {
    postId: v.optional(v.id("posts")),
    storyId: v.optional(v.id("stories")),
    media: v.array(
      v.object({
        // Dual-mode: a Convex storage id (legacy/fallback) OR an external
        // Cloudinary url + key (primary path once CLOUDINARY_* is configured).
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
    ),
  },
  handler: async (ctx, { postId, storyId, media }) => {
    const { replacements, strippedKeys } = await stripVideos(ctx, media);
    if (replacements.length > 0 || strippedKeys.length > 0) {
      await ctx.runMutation(internal.media.applyVideoStrip, {
        postId,
        storyId,
        replacements,
        strippedKeys,
      });
    }
  },
});
