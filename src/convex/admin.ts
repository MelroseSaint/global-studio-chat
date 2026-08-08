import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import type { Id } from "./_generated/dataModel";

import { isStandardId } from "@/lib/standard";

import { assertAdminIpVerified } from "./adminIp";
import { eraseAccount } from "./account";
import { cleanupMediaItems, sweepPostEngagement } from "./mediaCleanup";
import { publicUser } from "./privacy";

import { api, internal } from "./_generated/api";
import { action, mutation, query, type QueryCtx } from "./_generated/server";

const ADMIN_EMAIL = "monroedoses@gmail.com";

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

export async function requireAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    // ConvexError so the message crosses the public HTTP boundary (plain
    // Errors are masked as "Server Error") — the admin UI and QA harness
    // rely on the real reason.
    throw new ConvexError("Not authenticated");
  }
  const me = await ctx.db.get(userId);
  if (me?.role !== "admin") {
    throw new ConvexError("Admins only");
  }
  // Backend-verified device gate (see adminIp.ts): admin power is refused
  // unless the backend has recently OBSERVED the admin's IP for this
  // session via the /admin/ip/verify HTTP action. The role check above
  // proves WHO, this proves WHERE — a stolen session replayed from a
  // different network cannot act, even with a valid token.
  await assertAdminIpVerified(ctx);
  return userId;
}

export const dashboardStats = query({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [users, posts, stories, tickets, follows, comments, aiReview, racismReview, flagged, aiReviewStories] =
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
        ctx.db
          .query("posts")
          .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
          .filter((q) => q.neq(q.field("racismReviewCategory"), undefined))
          .collect(),
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
        ctx.db
          .query("stories")
          .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
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
      racismReview: racismReview.length,
      security: flagged.length,
      aiReviewStories: aiReviewStories.length,
    };
  },
});

/**
 * Lightweight moderation workload for admins — the two queues that need a
 * human decision: open support tickets and posts waiting on AI review.
 * Indexed on both tables (by_status, by_ai_status), so it stays cheap to
 * call from the app shell on every load (powers the Admin nav badge and the
 * installed PWA's app-icon badge).
 */
export const moderationWorkload = query({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [openTickets, aiReview] = await Promise.all([
      ctx.db
        .query("supportTickets")
        .withIndex("by_status", (q) => q.eq("status", "open"))
        .collect(),
      ctx.db
        .query("posts")
        .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
        .collect(),
    ]);
    return {
      openTickets: openTickets.length,
      aiReview: aiReview.length,
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
    return {
      ...result,
      // Flag the owner account so the admin UI can mark its row protected
      // and disable every control on it.
      page: result.page.map((u) => ({
        ...publicUser(u),
        isOwner: u.email === ADMIN_EMAIL,
      })),
    };
  },
});

export const setVerified = mutation({
  args: { userId: v.id("users"), verified: v.boolean() },
  handler: async (ctx, { userId, verified }) => {
    await requireAdmin(ctx);
    // The owner account is untouchable — its verified badge can never be
    // stripped, even by the owner. Checked by email, not role.
    const target = await ctx.db.get(userId);
    if (target !== null && target.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be changed.");
    }
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
    // The owner account can never be demoted — the platform is not
    // self-destructible. Checked by email, not role.
    const target = await ctx.db.get(userId);
    if (target !== null && target.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be changed.");
    }
    await ctx.db.patch(userId, { role });
  },
});

/**
 * Permanently remove an account — the same full erasure a user triggers
 * with "delete my account", run by an admin for accounts that must be
 * gone entirely (repeat offenders, farm networks, impersonators). The
 * platform is not self-destructible: the owner account (ADMIN_EMAIL) and
 * the admin's own account cannot be removed this way.
 *
 * Like every other admin action, the removal must cite the PureWire
 * Standard principle it is taken under. Before the erasure sweep runs,
 * the account's public identity — username, display name, and the salted
 * one-way email hash (never the plain address) — is snapshotted into the
 * private removal log, together with who acted, the cited principle, and
 * when. That record lives in a separate table the erasure sweep never
 * touches (see eraseAccount), so "who was removed, when, by whom" is
 * always knowable — and it is strictly one-way: it can never recreate the
 * account or any of its data.
 */
export const removeAccount = mutation({
  args: {
    userId: v.id("users"),
    // Required: the PureWire Standard principle this removal cites, so a
    // permanent removal is never an unqualified action.
    standardId: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { userId, standardId, note }) => {
    const me = await requireAdmin(ctx);
    if (userId === me) {
      throw new Error("You can't remove your own account from here.");
    }
    if (!isStandardId(standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    const target = await ctx.db.get(userId);
    if (target !== null && target.email === ADMIN_EMAIL) {
      throw new Error("The owner account cannot be removed.");
    }
    // One-way safety net FIRST: snapshot the account's public identity
    // before the sweep erases every trace of it. The email is stored as
    // the salted one-way hash — the same value already on the user record
    // — never the plain address. `removalLog` is a separate table that
    // eraseAccount never sweeps, so this record survives the erasure.
    await ctx.db.insert("removalLog", {
      userId,
      username: target?.username ?? undefined,
      name: target?.name ?? undefined,
      emailHash: target?.emailHash ?? undefined,
      actorId: me,
      standardId,
      note: note !== undefined && note.trim().length > 0 ? note.trim() : undefined,
    });
    // Blast-radius report: count what the sweep is about to erase (posts
    // and comments authored by the target) so callers — the cleanup
    // scripts, admin tooling — can show exactly how much content a
    // removal removed. The same bounded pre-count the QA harness's
    // deleteTestUser uses.
    const posts = (
      await ctx.db
        .query("posts")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .take(500)
    ).length;
    const comments = (
      await ctx.db
        .query("comments")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .take(500)
    ).length;
    await eraseAccount(ctx, userId);
    return { posts, comments };
  },
});

/**
 * Admin: the private removal log — every permanent removal with the
 * snapshotted public identity (username, display name, salted email
 * hash), who acted, the cited Standard principle, the note, and when.
 * Read from the dedicated removalLog table, which the erasure sweep never
 * touches, so this list is complete even for accounts whose data is long
 * gone. One-way: admins can see who was removed; nothing here can restore
 * the account.
 */
export const listRemovals = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("removalLog")
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (entry) => {
        const actor =
          entry.actorId !== undefined ? await ctx.db.get(entry.actorId) : null;
        return {
          username: entry.username ?? null,
          name: entry.name ?? null,
          // The salted one-way email hash — displayable, but it can never
          // be reversed into the address, and no restore path uses it.
          emailHash: entry.emailHash ?? null,
          actorUsername: actor?.username ?? actor?.name ?? null,
          standardId: entry.standardId ?? null,
          note: entry.note ?? null,
          createdAt: entry._creationTime,
        };
      }),
    );
    return { ...result, page };
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
                avatarUrl:
                  author.avatarUrl ??
                  (author.avatarStorageId
                    ? await ctx.storage.getUrl(author.avatarStorageId)
                    : null),
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
      // The files die with the removed post — Convex storage ids inline,
      // external Cloudinary keys through the fire-and-forget batch delete.
      await cleanupMediaItems(ctx, post.media ?? []);
      // The engagement rows die with the post too — the same sweep the
      // user-facing deletePost does, so no orphan likes/comments/shares
      // rows outlive a moderated post.
      await sweepPostEngagement(ctx, postId);
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
                avatarUrl:
                  author.avatarUrl ??
                  (author.avatarStorageId
                    ? await ctx.storage.getUrl(author.avatarStorageId)
                    : null),
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

/** Racism-prevention review: posts flagged with a racism signal that a
 *  human moderator must judge — same pattern as the AI review queue. */
export const listRacismReview = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("posts")
      .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
      .filter((q) => q.neq(q.field("racismReviewCategory"), undefined))
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
                avatarUrl:
                  author.avatarUrl ??
                  (author.avatarStorageId
                    ? await ctx.storage.getUrl(author.avatarStorageId)
                    : null),
              }
            : null,
        };
      }),
    );
    return { ...result, page };
  },
});

/** Admin clears a racism-flagged post — it stays live but the flag is gone. */
export const resolveRacismReview = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    await requireAdmin(ctx);
    const post = await ctx.db.get(postId);
    if (post !== null) {
      await ctx.db.patch(postId, {
        aiStatus: "clean" as const,
        racismReviewCategory: undefined,
        racismEvasionScore: undefined,
      });
    }
  },
});

/** Admin bulk-clears racism-flagged posts. */
export const resolveRacismReviewBatch = mutation({
  args: { postIds: v.array(v.id("posts")) },
  handler: async (ctx, { postIds }) => {
    await requireAdmin(ctx);
    for (const postId of postIds) {
      const post = await ctx.db.get(postId);
      if (post !== null && post.racismReviewCategory !== undefined) {
        await ctx.db.patch(postId, {
          aiStatus: "clean" as const,
          racismReviewCategory: undefined,
          racismEvasionScore: undefined,
        });
      }
    }
  },
});

/** Stories flagged for AI review — same pattern as posts. */
export const listAiReviewStories = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("stories")
      .withIndex("by_ai_status", (q) => q.eq("aiStatus", "review"))
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (s) => {
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
        };
      }),
    );
    return { ...result, page };
  },
});

/** Admin clears a flagged story — mark it clean. */
export const resolveAiReviewStory = mutation({
  args: { storyId: v.id("stories") },
  handler: async (ctx, { storyId }) => {
    await requireAdmin(ctx);
    const story = await ctx.db.get(storyId);
    if (story !== null) {
      await ctx.db.patch(storyId, { aiStatus: "clean" });
    }
  },
});

/** Admin bulk-clears story review flags. */
export const resolveAiReviewStoryBatch = mutation({
  args: { storyIds: v.array(v.id("stories")) },
  handler: async (ctx, { storyIds }) => {
    await requireAdmin(ctx);
    for (const storyId of storyIds) {
      const story = await ctx.db.get(storyId);
      if (story !== null && story.aiStatus === "review") {
        await ctx.db.patch(storyId, { aiStatus: "clean" });
      }
    }
  },
});

/** Admin removes a story (with Standard citation). */
export const moderateStory = mutation({
  args: {
    storyId: v.id("stories"),
    standardId: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { storyId, standardId, note }) => {
    await requireAdmin(ctx);
    const story = await ctx.db.get(storyId);
    if (story === null) return;
    await ctx.db.insert("moderationLog", {
      targetUserId: story.authorId,
      action: "flag",
      standardId,
      note,
    });
    // Sweep the viewer rows so a moderated story leaves no orphan views.
    const views = await ctx.db
      .query("storyViews")
      .withIndex("by_story", (q) => q.eq("storyId", storyId))
      .take(200);
    for (const view of views) {
      await ctx.db.delete(view._id);
    }
    await ctx.db.delete(storyId);
  },
});

/**
 * Self-test for the media evidence pipeline. Creates three synthetic
 * images (AI-generated, clean phone photo, C2PA-signed camera capture),
 * uploads them through Convex storage, runs the full scanMediaForAi
 * pipeline on each, and returns the verdict + structured evidence.
 *
 * Admin-gated (not harness-gated) — any admin can run this from the
 * dashboard to confirm the pipeline is working without uploading files
 * through the composer UI.
 */
export const previewMediaEvidence = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    results: v.array(
      v.object({
        label: v.string(),
        status: v.string(),
        reason: v.optional(v.string()),
        evidence: v.optional(v.any()),
        c2paVerifiedHuman: v.optional(v.boolean()),
        c2paClaimGenerator: v.optional(v.string()),
      }),
    ),
    error: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    // Inline admin check — requireAdmin is query-only, actions must
    // check the role from user document directly.
    const user = await ctx.runQuery(api.users.getCurrentUser, {});
    if (user === null || user.role !== "admin") {
      throw new Error("Admin access required.");
    }
    // Backend-verified device gate (see adminIp.ts) — actions can't call
    // requireAdmin, so enforce the same fresh-IP binding through the
    // internal query wrapper.
    await ctx.runQuery(internal.adminIp.assertVerifiedForAction, {});

    // ── Image builders (same logic as ai-scan-qa.mjs, inlined for zero deps) ──
    const u32be = (n: number) => {
      const b = new Uint8Array(4);
      b[0] = (n >>> 24) & 0xff; b[1] = (n >>> 16) & 0xff;
      b[2] = (n >>> 8) & 0xff; b[3] = n & 0xff;
      return b;
    };
    const bytesOf = (parts: (string | Uint8Array | ArrayBuffer)[]) => {
      const arrays = parts.map((p) =>
        typeof p === "string" ? new TextEncoder().encode(p) : new Uint8Array(p),
      );
      const total = arrays.reduce((n, a) => n + a.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const a of arrays) { out.set(a, off); off += a.length; }
      return out.buffer;
    };
    function jpegWithExif(software: string) {
      const tiff = new Uint8Array(8 + 2 + 12 + 4 + software.length + 1);
      tiff[0] = 0x49; tiff[1] = 0x49; tiff[2] = 0x2a; tiff[3] = 0; tiff[4] = 8; tiff[7] = 0;
      tiff[8] = 1; tiff[10] = 0x31; tiff[11] = 1; tiff[12] = 2; tiff[13] = 0;
      const n = software.length + 1;
      tiff[14] = n & 0xff; tiff[15] = (n >> 8) & 0xff;
      tiff[20] = 20 & 0xff; tiff[21] = 0;
      for (let i = 0; i < software.length; i++) tiff[20 + i] = software.charCodeAt(i);
      const exif = bytesOf(["Exif\0\0", tiff]);
      const app1 = bytesOf([u32be(exif.byteLength + 2), new Uint8Array(exif)]);
      return bytesOf([
        new Uint8Array([0xff, 0xd8]),
        new Uint8Array([0xff, 0xe1]),
        app1,
        new Uint8Array([0xff, 0xd9]),
      ]);
    }
    // JPEG APP11 with a C2PA digitalCapture manifest (camera-signed).
    function jpegWithC2pa() {
      const payload = '{"digitalSourceType":"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture","claim_generator":"Adobe Camera Raw 17.0"}';
      const data = bytesOf(["JPEG-MBX", payload]);
      const segLen = data.byteLength + 2;
      const app11 = bytesOf([
        new Uint8Array([(segLen >> 8) & 0xff, segLen & 0xff]),
        new Uint8Array(data),
      ]);
      return bytesOf([
        new Uint8Array([0xff, 0xd8]),
        new Uint8Array([0xff, 0xeb]),
        app11,
        new Uint8Array([0xff, 0xd9]),
      ]);
    }

    const testImages = [
      { label: "AI-generated (Midjourney EXIF)", bytes: jpegWithExif("Midjourney") },
      { label: "Clean phone photo (Pixel 8 Pro)", bytes: jpegWithExif("Pixel 8 Pro") },
      { label: "C2PA camera capture (Adobe Camera Raw)", bytes: jpegWithC2pa() },
    ];

    const results: Array<{
      label: string;
      status: string;
      reason?: string;
      evidence?: Record<string, unknown>;
      c2paVerifiedHuman?: boolean;
      c2paClaimGenerator?: string;
    }> = [];

    for (const img of testImages) {
      try {
        // 1. Upload via internal mutation → get Convex upload URL, POST the bytes.
        const slot = (await ctx.runMutation(
          internal.mediaStorage.uploadSlot,
          {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        )) as any as { convexUrl: string };

        const uploadRes = await fetch(slot.convexUrl, {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: new Uint8Array(img.bytes),
        });
        if (!uploadRes.ok) {
          results.push({ label: img.label, status: "upload_failed", reason: `Upload returned ${uploadRes.status}` });
          continue;
        }
        const { storageId } = (await uploadRes.json()) as { storageId?: string };
        if (!storageId) {
          results.push({ label: img.label, status: "upload_failed", reason: "No storageId in response" });
          continue;
        }

        // 2. Run the full scan pipeline.
        const scan = await ctx.runAction(api.aiContent.scanMediaForAi, {
          media: [{ storageId: storageId as Id<"_storage">, kind: "image" }],
        });

        const s = scan as unknown as {
          reason?: string;
          evidence?: Record<string, unknown>;
          c2paVerifiedHuman?: boolean;
          c2paClaimGenerator?: string;
        };
        results.push({
          label: img.label,
          status: scan.status,
          reason: s.reason,
          evidence: s.evidence,
          c2paVerifiedHuman: s.c2paVerifiedHuman,
          c2paClaimGenerator: s.c2paClaimGenerator,
        });

        // 3. Clean up the test upload.
        await ctx.runMutation(internal.mediaStorage.uploadSlot, {}).catch(() => {});
      } catch (err) {
        results.push({
          label: img.label,
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { ok: true, results };
  },
});
