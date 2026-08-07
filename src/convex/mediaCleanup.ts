/**
 * Best-effort media cleanup for PureWire — split into its own module so the
 * helpers that schedule the batch-delete action live in a different module
 * than the action they schedule (a Convex function may not call an internal
 * function defined in its own file — the generated types recurse).
 *
 * Convex storage ids delete inline (mutations can touch storage directly);
 * external Cloudinary public_ids are handed to the fire-and-forget
 * batch-delete action in mediaStorage.ts, so a slow or failed Cloudinary
 * call never blocks the caller's write. Best-effort throughout: a failed
 * delete is an orphaned asset (cheap), never a thrown error.
 */
import { internal } from "./_generated/api";
import { type MutationCtx } from "./_generated/server";

import type { Id } from "./_generated/dataModel";

import { keyFromPublicUrl, resourceTypeFor } from "./mediaStorage";

/**
 * Clean up media files referenced by a list of items — dual-mode. Convex
 * storage ids delete inline; external Cloudinary public_ids go through the
 * batch-delete action in mediaStorage.ts. Best-effort: never throws.
 */
export async function cleanupMediaItems(
  ctx: MutationCtx,
  media: Array<{
    storageId?: Id<"_storage"> | null;
    url?: string | null;
    key?: string | null;
    kind?: "image" | "video" | "audio";
  }>,
): Promise<void> {
  const keys: { key: string; resourceType: string }[] = [];
  for (const m of media) {
    if (m.storageId) {
      try {
        await ctx.storage.delete(m.storageId);
      } catch {
        // Best-effort: never fail the caller over a storage delete.
      }
    }
    const key = m.key ?? (m.url ? keyFromPublicUrl(m.url) : undefined);
    if (key !== undefined && key !== null) {
      keys.push({
        key,
        resourceType: resourceTypeFor(m.kind ?? "image"),
      });
    }
  }
  if (keys.length > 0) {
    await ctx.scheduler.runAfter(
      0,
      internal.mediaStorage.deleteExternalKeys,
      { keys },
    );
  }
}

/**
 * Delete every commentLikes row pointing at a comment, in chunks. Called
 * wherever a comment dies — deleteComment, sweepPostEngagement, and the
 * account erasure — so no orphan likes outlive the comment they key.
 */
export async function sweepCommentLikes(
  ctx: MutationCtx,
  commentId: Id<"comments">,
): Promise<void> {
  for (;;) {
    const rows = await ctx.db
      .query("commentLikes")
      .withIndex("by_comment", (q) => q.eq("commentId", commentId))
      .take(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
  }
}

/**
 * Delete every like, comment, and share row pointing at a post, in chunks.
 * Called when a post is removed — the user-facing deletePost and the
 * admin's moderatePost — so no orphan engagement rows outlive it (they
 * would inflate the admin dashboard's totals and never be reachable
 * again). Chunked exactly like the erasure sweeps in account.ts (500 rows
 * per pass) so a viral post's engagement is never loaded into memory
 * wholesale or burned in a single mutation's write budget. The post's own
 * like/comment/share counters die with the post row, so no counters need
 * touching here.
 */
export async function sweepPostEngagement(
  ctx: MutationCtx,
  postId: Id<"posts">,
): Promise<void> {
  for (;;) {
    const rows = await ctx.db
      .query("likes")
      .withIndex("by_post", (q) => q.eq("postId", postId))
      .take(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
  }
  for (;;) {
    const rows = await ctx.db
      .query("comments")
      .withIndex("by_post", (q) => q.eq("postId", postId))
      .take(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      // The comment's own likes die with it, so the commentLikes table
      // never keeps rows keyed to a deleted comment.
      await sweepCommentLikes(ctx, row._id);
      await ctx.db.delete(row._id);
    }
  }
  for (;;) {
    const rows = await ctx.db
      .query("shares")
      .withIndex("by_post", (q) => q.eq("postId", postId))
      .take(500);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
  }
}

/** Shape of a user row's artwork fields, for cleanupUserArtwork. */
export interface ArtworkFields {
  avatarStorageId?: Id<"_storage"> | null;
  bannerStorageId?: Id<"_storage"> | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
}

/** Delete a user's avatar + banner files, both modes. */
export async function cleanupUserArtwork(
  ctx: MutationCtx,
  user: ArtworkFields | null | undefined,
): Promise<void> {
  if (user === null || user === undefined) {
    return;
  }
  await cleanupMediaItems(ctx, [
    {
      storageId: user.avatarStorageId ?? undefined,
      url: user.avatarUrl ?? undefined,
    },
    {
      storageId: user.bannerStorageId ?? undefined,
      url: user.bannerUrl ?? undefined,
    },
  ]);
}
