import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { stripMp4Metadata } from "@/lib/mp4-strip";

import {
  cloudinaryConfig,
  resourceTypeFor,
  resourceTypeForContentType,
  uploadOverwriteBytes,
  uploadUrlFor,
} from "./mediaStorage";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  type ActionCtx,
} from "./_generated/server";

/**
 * A single attached media item, exactly as posts and stories store it.
 * Dual-mode: a Convex `storageId` (legacy/fallback) OR an external
 * Cloudinary `url` + `key` (primary path once CLOUDINARY_* is configured).
 */
const mediaItemValidator = v.object({
  storageId: v.optional(v.id("_storage")),
  // External object URL when the media lives in Cloudinary. Mutually
  // exclusive with storageId in practice (never both on one item).
  url: v.optional(v.string()),
  // The Cloudinary public_id, kept so deletions know exactly what to
  // remove without parsing the URL.
  key: v.optional(v.string()),
  kind: v.union(
    v.literal("image"),
    v.literal("video"),
    v.literal("audio"),
  ),
  // True when GPS/device metadata was removed from this item — by the
  // client re-encode (images and most videos) or by the server remux
  // (pass-through videos). Surfaced as the "Metadata stripped" note.
  stripped: v.optional(v.boolean()),
});

type MediaItem = {
  storageId?: Id<"_storage">;
  url?: string;
  key?: string;
  kind: "image" | "video" | "audio";
  // True when GPS/device metadata was removed from this item — by the
  // client re-encode (images and most videos) or by the server remux
  // (pass-through videos). Surfaced as the "Metadata stripped" note.
  stripped?: boolean;
};

/** What `prepareUpload` hands back to the client. */
type PreparedUpload =
  | { mode: "convex"; uploadUrl: string }
  | {
      mode: "cloudinary";
      uploadUrl: string;
      uploadPreset: string;
      resourceType: string;
      // The Convex upload URL, minted alongside every Cloudinary ticket so
      // the client can fall back to Convex storage the instant a Cloudinary
      // upload fails (missing/renamed unsigned preset, restricted key,
      // quota) instead of breaking uploads for users.
      fallbackUrl: string;
    };

/**
 * Reserve an upload slot for a new media file. Returns a dual-mode ticket:
 *
 *   - `{ mode: "convex", uploadUrl }` — the fallback path; the client POSTs
 *     to Convex storage and stores the returned storage id.
 *   - `{ mode: "cloudinary", uploadUrl, uploadPreset, resourceType,
 *     fallbackUrl }` — the Cloudinary path; the client POSTs the file +
 *     unsigned preset to the upload URL and stores the returned
 *     `secure_url`/`public_id`. The bytes never pass through Convex — but
 *     `fallbackUrl` (a Convex upload URL minted with the same ticket)
 *     lets the client re-upload to Convex storage if Cloudinary ever fails,
 *     so a misconfigured preset can never break user uploads.
 *
 * The mode flips automatically when CLOUDINARY_* env vars are configured,
 * so enabling Cloudinary requires no code change and no deploy cycle
 * beyond setting the vars. Auth, account status, and the per-account upload
 * budget are enforced in the internal mutation (actions can't touch the db
 * directly), which also mints the Convex fallback URL when needed.
 */
export const prepareUpload = action({
  args: { contentType: v.string() },
  returns: v.union(
    v.object({
      mode: v.literal("convex"),
      uploadUrl: v.string(),
    }),
    v.object({
      mode: v.literal("cloudinary"),
      uploadUrl: v.string(),
      uploadPreset: v.string(),
      resourceType: v.string(),
      fallbackUrl: v.string(),
    }),
  ),
  handler: async (ctx, { contentType }): Promise<PreparedUpload> => {
    const cfg = cloudinaryConfig();
    // The internal mutation authenticates, enforces the account status and
    // upload budget, and returns a Convex upload URL. In Cloudinary mode
    // that URL is unused (the client never touches Convex storage), but
    // running the same checks keeps both paths identically rate-limited.
    // The result is explicitly shaped: the action's return type must not
    // flow through the generated `internal` namespace, or its inference
    // resolves back through `typeof media` into its own initializer
    // (TS7022).
    const slot = (await ctx.runMutation(
      internal.mediaStorage.uploadSlot,
      {},
    )) as unknown as { userId: string; convexUrl: string };
    if (cfg === null) {
      return { mode: "convex", uploadUrl: slot.convexUrl };
    }
    const resourceType = resourceTypeForContentType(contentType);
    return {
      mode: "cloudinary",
      uploadUrl: uploadUrlFor(cfg, resourceType),
      uploadPreset: cfg.uploadPreset,
      resourceType,
      // The Convex URL is already minted by the internal mutation (it's the
      // fallback path when Cloudinary isn't configured) — hand it along so
      // the client can retry into Convex storage without a second ticket.
      fallbackUrl: slot.convexUrl,
    };
  },
});


/**
 * Discard media that was uploaded but never used — the browser uploaded a
 * Cloudinary object (or Convex file) and then the user removed it from the
 * composer before the post/story existed, so no document references it and
 * the normal deletion paths never see it.
 *
 * Both modes are cleaned: Cloudinary public_ids go through the scheduled
 * external delete (keeps the member's Cloudinary account free of orphaned
 * assets); Convex storage ids delete inline (covers the fallback path and
 * the no-Cloudinary mode).
 *
 * Only the uploader may discard; items that are referenced by a live
 * document are the caller's own problem to clean up through the normal
 * delete paths (this mutation intentionally doesn't check — the composer
 * only passes items that never left the current draft).
 */
export const discardUploads = mutation({
  args: {
    items: v.array(
      v.object({
        key: v.optional(v.string()),
        resourceType: v.optional(v.string()),
        storageId: v.optional(v.id("_storage")),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { items }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const keys = items.filter(
      (i) => i.key !== undefined && i.resourceType !== undefined,
    );
    if (keys.length > 0) {
      await ctx.scheduler.runAfter(0, internal.mediaStorage.deleteExternalKeys, {
        keys: keys as { key: string; resourceType: string }[],
      });
    }
    for (const item of items) {
      if (item.storageId !== undefined) {
        try {
          await ctx.storage.delete(item.storageId);
        } catch {
          // Best-effort: never fail the caller over a storage delete.
        }
      }
    }
    return null;
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
 * survives intact — only the metadata atoms disappear.
 *
 * Dual-mode behavior:
 *   - Convex items: the cleaned copy is stored in place of the original and
 *     the original is deleted (storage ids are immutable, so a replacement
 *     is required). `replacements` carries the old→new storage ids.
 *   - Cloudinary items: the object is fetched, remuxed, and signed-overwritten
 *     at the SAME public_id (the URL never changes). Successfully overwritten
 *     keys are returned in `strippedKeys` so the caller can flag them.
 *
 * Returns the cleaned media list plus both patch lists, so both callers
 * (the client action below and the scheduled internal action) get exactly
 * what they need. Idempotent: a video that is already clean comes back
 * unchanged with no re-store, no overwrite, and no delete.
 */
export async function stripVideos(
  ctx: ActionCtx,
  media: MediaItem[],
): Promise<{
  media: MediaItem[];
  replacements: { oldStorageId: Id<"_storage">; newStorageId: Id<"_storage"> }[];
  strippedKeys: string[];
}> {
  const cfg = cloudinaryConfig();
  const replacements: {
    oldStorageId: Id<"_storage">;
    newStorageId: Id<"_storage">;
  }[] = [];
  const strippedKeys: string[] = [];
  const out: MediaItem[] = [];
  for (const item of media) {
    let storageId = item.storageId;
    // The client may have already re-encoded this item; the server remux
    // below may add that guarantee for pass-through videos. Either path
    // means the stored copy is metadata-clean — carry it as the flag.
    let metadataStripped = item.stripped === true;
    if (item.kind === "video") {
      if (item.url !== undefined && item.key !== undefined && cfg !== null) {
        // Cloudinary path: fetch, remux, signed-overwrite the same public_id.
        // Only the remux writes to storage, so the caller claims "metadata
        // stripped" only when the overwrite actually succeeded.
        const res = await fetch(item.url);
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          const result = stripMp4Metadata(bytes);
          if (result !== null && result.changed) {
            const cleanBytes = new Uint8Array(result.bytes);
            const contentType = res.headers.get("content-type") ?? "video/mp4";
            const overwritten = await uploadOverwriteBytes(
              cfg,
              item.key,
              resourceTypeFor(item.kind),
              contentType,
              cleanBytes,
            );
            if (overwritten) {
              strippedKeys.push(item.key);
              metadataStripped = true;
            }
          }
        }
      } else if (storageId !== undefined) {
        // Convex path: read, remux, store the cleaned copy, delete original.
        const blob = await ctx.storage.get(storageId);
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
            await ctx.storage.delete(storageId);
            replacements.push({ oldStorageId: storageId, newStorageId: cleaned });
            storageId = cleaned;
            metadataStripped = true;
          }
        }
      }
    }
    out.push({
      ...(storageId !== undefined ? { storageId } : {}),
      ...(item.url !== undefined ? { url: item.url } : {}),
      ...(item.key !== undefined ? { key: item.key } : {}),
      kind: item.kind,
      ...(metadataStripped ? { stripped: true } : {}),
    });
  }
  return { media: out, replacements, strippedKeys };
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
 * Apply a batch of storage-id replacements / stripped-key flags to a post
 * or story after the server-side strip. Called by the scheduled safety-net
 * action so that even clients that never call stripVideoMetadata (API
 * callers, future mobile builds) can never leave a dirty video referenced
 * by a live doc.
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
    // External keys whose objects were overwritten with cleaned copies —
    // the URL is unchanged, only the stripped flag needs patching.
    strippedKeys: v.array(v.string()),
  },
  handler: async (ctx, { postId, storyId, replacements, strippedKeys }) => {
    const markStripped = (m: MediaItem) => {
      const rep = replacements.find((r) => r.oldStorageId === m.storageId);
      if (rep) {
        return { ...m, storageId: rep.newStorageId, stripped: true };
      }
      if (m.key !== undefined && strippedKeys.includes(m.key)) {
        return { ...m, stripped: true };
      }
      return m;
    };
    if (postId !== undefined) {
      const post = await ctx.db.get(postId);
      if (post?.media) {
        await ctx.db.patch(postId, { media: post.media.map(markStripped) });
      }
    }
    if (storyId !== undefined) {
      const story = await ctx.db.get(storyId);
      if (story) {
        await ctx.db.patch(storyId, { media: markStripped(story.media) });
      }
    }
  },
});

// Re-exported so callers that import from "./media" keep working — the
// canonical implementation lives in mediaStorage.ts.
export { keyFromPublicUrl } from "./mediaStorage";
