import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { stripMp4Metadata } from "@/lib/mp4-strip";

import { enforceActive, enforceRateLimit } from "./security";

import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  type ActionCtx,
} from "./_generated/server";

/** A single attached media item, exactly as posts and stories store it. */
const mediaItemValidator = v.object({
  storageId: v.id("_storage"),
  kind: v.union(
    v.literal("image"),
    v.literal("video"),
    v.literal("audio"),
  ),
  stripped: v.optional(v.boolean()),
});

type MediaItem = {
  storageId: Id<"_storage">;
  kind: "image" | "video" | "audio";
  // True when GPS/device metadata was removed from this item — by the
  // client re-encode (images and most videos) or by the server remux
  // (pass-through videos). Surfaced as the "Metadata stripped" note.
  stripped?: boolean;
};

/**
 * Mint a signed upload URL. Requires a logged-in, active account and runs
 * against the per-account upload budget so automated scrapers can't use
 * the storage endpoint as an unbounded dumping ground.
 */
export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "upload");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * The server-side half of PureWire's video privacy pipeline.
 *
 * The browser already re-encodes most videos, which drops container
 * metadata. But any clip that passes through untouched — longer than the
 * re-encode budget, already small, or undecodable — keeps its original
 * MP4/MOV atoms, including GPS coordinates (`©xyz`), camera make/model
 * (`©mak` / `©mod`), and vendor `udta` / `meta` / `uuid` boxes.
 *
 * This helper remuxes those containers on the server: the media payload
 * (`mdat`) is copied byte-for-byte, so every frame, track, and timestamp
 * survives intact — only the metadata atoms disappear. The cleaned copy is
 * stored in place of the original and the original is deleted, so no
 * surface ever serves a clip that still carries GPS or device data.
 *
 * Returns the cleaned media list plus the storage-id replacements, so both
 * callers (the client action below and the scheduled internal action) get
 * exactly what they need. Idempotent: a video that is already clean comes
 * back unchanged with no re-store and no delete.
 */
export async function stripVideos(
  ctx: ActionCtx,
  media: MediaItem[],
): Promise<{
  media: MediaItem[];
  replacements: { oldStorageId: Id<"_storage">; newStorageId: Id<"_storage"> }[];
}> {
  const replacements: {
    oldStorageId: Id<"_storage">;
    newStorageId: Id<"_storage">;
  }[] = [];
  const out: MediaItem[] = [];
  for (const item of media) {
    let storageId = item.storageId;
    // The client may have already re-encoded this item; the server remux
    // below may add that guarantee for pass-through videos. Either path
    // means the stored copy is metadata-clean — carry it as the flag.
    let metadataStripped = item.stripped === true;
    if (item.kind === "video") {
      const blob = await ctx.storage.get(item.storageId);
      if (blob !== null) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const result = stripMp4Metadata(bytes);
        if (result !== null && result.changed) {
          // Copy into a fresh Uint8Array: it guarantees a plain ArrayBuffer
          // backing (the remux may hand back a subarray of a SharedArrayBuffer
          // from the source blob), which Blob's type accepts.
          const cleanBytes = new Uint8Array(result.bytes);
          const cleaned = await ctx.storage.store(
            new Blob([cleanBytes], { type: blob.type }),
          );
          await ctx.storage.delete(item.storageId);
          replacements.push({ oldStorageId: item.storageId, newStorageId: cleaned });
          storageId = cleaned;
          metadataStripped = true;
        }
      }
    }
    out.push({
      storageId,
      kind: item.kind,
      ...(metadataStripped ? { stripped: true } : {}),
    });
  }
  return { media: out, replacements };
}

/**
 * Client-facing video privacy step. The composer and story dialog call this
 * AFTER uploading (and AFTER the AI scan reads the original bytes, so
 * stripping metadata can never strip the evidence a file was machine-made)
 * and BEFORE the post/story is created — so the document only ever
 * references a cleaned clip. Mirrors the scanMediaForAi action pattern:
 * the action does the storage work, the mutation trusts its result.
 */
export const stripVideoMetadata = action({
  args: { media: v.array(mediaItemValidator) },
  returns: v.array(mediaItemValidator),
  handler: async (ctx, { media }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const { media: cleaned } = await stripVideos(ctx, media);
    return cleaned;
  },
});

/**
 * Apply a batch of storage-id replacements to a post or story after the
 * server-side strip. Called by the scheduled safety-net action so that
 * even clients that never call stripVideoMetadata (API callers, future
 * mobile builds) can never leave a dirty video referenced by a live doc.
 */
export const applyVideoStrip = internalMutation({
  args: {
    postId: v.optional(v.id("posts")),
    storyId: v.optional(v.id("stories")),
    replacements: v.array(
      v.object({
        oldStorageId: v.id("_storage"),
        newStorageId: v.id("_storage"),
      }),
    ),
  },
  handler: async (ctx, { postId, storyId, replacements }) => {
    if (replacements.length === 0) {
      return;
    }
    if (postId !== undefined) {
      const post = await ctx.db.get(postId);
      if (post?.media) {
        const media = post.media.map((m) => {
          const rep = replacements.find(
            (r) => r.oldStorageId === m.storageId,
          );
          return rep
            ? { ...m, storageId: rep.newStorageId, stripped: true }
            : m;
        });
        await ctx.db.patch(postId, { media });
      }
    }
    if (storyId !== undefined) {
      const story = await ctx.db.get(storyId);
      if (story) {
        const rep = replacements.find(
          (r) => r.oldStorageId === story.media.storageId,
        );
        if (rep) {
          await ctx.db.patch(storyId, {
            media: { ...story.media, storageId: rep.newStorageId, stripped: true },
          });
        }
      }
    }
  },
});
