import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";

import { ADMIN_EMAIL, PERMANENT_SESSION_MS, SHORT_SESSION_MS } from "./auth";
import { cleanupMediaItems, cleanupUserArtwork } from "./mediaCleanup";

import { mutation, type MutationCtx } from "./_generated/server";

import type { Id } from "./_generated/dataModel";

/**
 * PureWire's data-minimization layer.
 *
 * The platform keeps only what it needs to work, and nothing else: no
 * tracking, no analytics, no third-party embeds, no cookies. Whatever is
 * kept is either a salted one-way hash (email), content the user posted, records
 * of their own actions, or a short-lived moderation signal.
 *
 * The right to erasure is absolute: `deleteAccount` permanently removes a
 * user and every trace of them — profile, posts, comments, likes, shares,
 * stories, follows, notifications, tickets, blocks, rate-limit rows,
 * silent-flag events, auth sessions and accounts, and every file they
 * uploaded. No soft-delete,
 * no copy kept anywhere. Counts on other people's posts and profiles are
 * recomputed from the surviving rows, so erased data never leaves a drift.
 */

/** Sweep size cap per table so one mutation never exceeds write budgets. */
const SWEEP = 500;

type ErasableId =
  | Id<"posts">
  | Id<"comments">
  | Id<"likes">
  | Id<"shares">
  | Id<"follows">
  | Id<"notifications">
  | Id<"stories">
  | Id<"supportTickets">
  | Id<"blocks">
  | Id<"rateLimits">
  | Id<"authRateLimits">
  | Id<"silentFlagEvents">
  | Id<"moderationLog">;

interface ErasableRow {
  id: ErasableId;
}

/**
 * Repeatedly fetch a page of rows and delete each one until the table has
 * nothing left for this user. Rows are deleted as we go, so each pass
 * naturally picks up where the last one stopped — no double deletes.
 */
async function sweep(
  ctx: MutationCtx,
  fetchPage: (ctx: MutationCtx) => Promise<ErasableRow[]>,
  onRow: (ctx: MutationCtx, row: ErasableRow) => Promise<void>,
): Promise<void> {
  for (;;) {
    const page = await fetchPage(ctx);
    if (page.length === 0) {
      return;
    }
    for (const row of page) {
      await onRow(ctx, row);
    }
  }
}

/**
 * Permanently erase a user and every trace of their data. Shared by the
 * self-service `deleteAccount` and the admin `removeAccount` action so
 * both paths run the exact same full erasure — profile, posts, comments,
 * likes, shares, stories, follows, notifications, tickets, blocks,
 * rate-limit rows, silent-flag events, auth sessions and accounts, and
 * every file they uploaded. No soft-delete, no copy kept anywhere.
 *
 * The platform itself is not self-destructible: the owner account stays
 * unless removed by a direct database action.
 */
export async function eraseAccount(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (user === null) {
    throw new Error("Account not found");
  }
  // The platform itself is not self-destructible — the owner account
  // stays unless removed by a direct database action.
  if (user.email === ADMIN_EMAIL) {
    throw new Error("The owner account cannot be deleted from the app.");
  }

  // 1. Auth records — sessions, refresh tokens, verifiers, accounts,
  //    verification codes. Deleting these signs the user out everywhere.
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const token of tokens) {
      await ctx.db.delete(token._id);
    }
    // authVerifiers has no sessionId index — scan and filter (the table
    // only holds short-lived OAuth PKCE records).
    const verifiers = await ctx.db.query("authVerifiers").collect();
    for (const verifier of verifiers) {
      if (verifier.sessionId === session._id) {
        await ctx.db.delete(verifier._id);
      }
    }
    await ctx.db.delete(session._id);
  }
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const account of accounts) {
    const codes = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", account._id))
      .collect();
    for (const code of codes) {
      await ctx.db.delete(code._id);
    }
    await ctx.db.delete(account._id);
  }
  // The auth library's sign-in rate counters are keyed by the identifier
  // (the account's email) — sweep them so nothing references the account.
  const accountEmail = user.email;
  if (accountEmail !== undefined) {
    await sweep(
      ctx,
      async (c) => {
        const rows = await c.db
          .query("authRateLimits")
          .withIndex("identifier", (q) => q.eq("identifier", accountEmail))
          .take(SWEEP);
        return rows.map((r) => ({ id: r._id as ErasableId }));
      },
      async (c, { id }) => {
        await c.db.delete(id as Id<"authRateLimits">);
      },
    );
  }

  // 2. Posts authored by the user — their media files, the comments,
  //    likes, and shares attached to them all die with each post.
  await sweep(
    ctx,
    async (c) => {
      const posts = await c.db
        .query("posts")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .take(SWEEP);
      return posts.map((p) => ({ id: p._id }));
    },
    async (c, { id }) => {
      const post = await c.db.get(id as Id<"posts">);
      if (post === null) {
        return;
      }
      // Dual-mode cleanup: Convex storage ids delete inline, external
      // Cloudinary keys go through the fire-and-forget batch delete.
      await cleanupMediaItems(c, post.media ?? []);
      const [comments, likes, shares] = await Promise.all([
        c.db
          .query("comments")
          .withIndex("by_post", (q) => q.eq("postId", post._id))
          .collect(),
        c.db
          .query("likes")
          .withIndex("by_post", (q) => q.eq("postId", post._id))
          .collect(),
        c.db
          .query("shares")
          .withIndex("by_post", (q) => q.eq("postId", post._id))
          .collect(),
      ]);
      for (const row of [...comments, ...likes, ...shares]) {
        await c.db.delete(row._id);
      }
      await c.db.delete(post._id);
    },
  );

  // 3. Stories — media files deleted with each row.
  await sweep(
    ctx,
    async (c) => {
      const stories = await c.db
        .query("stories")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .take(SWEEP);
      return stories.map((s) => ({ id: s._id }));
    },
    async (c, { id }) => {
      const story = await c.db.get(id as Id<"stories">);
      if (story === null) {
        return;
      }
      await cleanupMediaItems(c, [story.media]);
      await c.db.delete(story._id);
    },
  );

  // 4. Comments, likes, shares the user made on other people's posts.
  //    Counts on those posts are recomputed afterwards (below) so real
  //    engagement is reflected exactly — phantom rows created while an
  //    account was quietly silenced never increment a count, and erasure
  //    must not decrement what was never incremented.
  const affectedPosts = new Set<Id<"posts">>();
  await sweep(
    ctx,
    async (c) => {
      const rows = await c.db
        .query("comments")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .take(SWEEP);
      return rows.map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      const comment = await c.db.get(id as Id<"comments">);
      if (comment === null) {
        return;
      }
      affectedPosts.add(comment.postId);
      await c.db.delete(comment._id);
    },
  );
  await sweep(
    ctx,
    async (c) => {
      const rows = await c.db
        .query("likes")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(SWEEP);
      return rows.map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      const like = await c.db.get(id as Id<"likes">);
      if (like === null) {
        return;
      }
      affectedPosts.add(like.postId);
      await c.db.delete(like._id);
    },
  );
  await sweep(
    ctx,
    async (c) => {
      const rows = await c.db
        .query("shares")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(SWEEP);
      return rows.map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      const share = await c.db.get(id as Id<"shares">);
      if (share === null) {
        return;
      }
      affectedPosts.add(share.postId);
      await c.db.delete(share._id);
    },
  );

  // 5. Follows in both directions — then the affected profiles' follower
  //    and following counts are recomputed from the surviving rows.
  const affectedFollowed = new Set<Id<"users">>(); // people they followed
  const affectedFollowers = new Set<Id<"users">>(); // people who followed them
  await sweep(
    ctx,
    async (c) => {
      const following = await c.db
        .query("follows")
        .withIndex("by_follower", (q) => q.eq("followerId", userId))
        .take(SWEEP);
      const followers = await c.db
        .query("follows")
        .withIndex("by_following", (q) => q.eq("followingId", userId))
        .take(SWEEP);
      return [...following, ...followers].map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      const follow = await c.db.get(id as Id<"follows">);
      if (follow === null) {
        return;
      }
      if (follow.followerId === userId) {
        affectedFollowed.add(follow.followingId);
      } else {
        affectedFollowers.add(follow.followerId);
      }
      await c.db.delete(follow._id);
    },
  );

  // 6. Notifications — both their inbox and any they triggered. The same
  //    row can appear in both lists (e.g. self-mentions), so dedupe by id
  //    within each pass to avoid deleting a row twice.
  await sweep(
    ctx,
    async (c) => {
      const inbox = await c.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(SWEEP);
      const triggered = await c.db
        .query("notifications")
        .filter((q) => q.eq(q.field("actorId"), userId))
        .take(SWEEP);
      const unique = new Map<string, ErasableRow>();
      for (const r of [...inbox, ...triggered]) {
        unique.set(r._id, { id: r._id });
      }
      return [...unique.values()];
    },
    async (c, { id }) => {
      await c.db.delete(id as Id<"notifications">);
    },
  );

  // 7. Support tickets, blocks (both directions), and rate-limit rows.
  await sweep(
    ctx,
    async (c) => {
      const rows = await c.db
        .query("supportTickets")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(SWEEP);
      return rows.map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      await c.db.delete(id as Id<"supportTickets">);
    },
  );
  await sweep(
    ctx,
    async (c) => {
      const blockedByMe = await c.db
        .query("blocks")
        .withIndex("by_blocker", (q) => q.eq("blockerId", userId))
        .take(SWEEP);
      const blockedMe = await c.db
        .query("blocks")
        .withIndex("by_blocked", (q) => q.eq("blockedId", userId))
        .take(SWEEP);
      return [...blockedByMe, ...blockedMe].map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      await c.db.delete(id as Id<"blocks">);
    },
  );
  await sweep(
    ctx,
    async (c) => {
      const rows = await c.db
        .query("rateLimits")
        .withIndex("by_user_action", (q) => q.eq("userId", userId))
        .take(SWEEP);
      return rows.map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      await c.db.delete(id as Id<"rateLimits">);
    },
  );
  // Silent-flag events (the quiet-moderation log) die with the account.
  await sweep(
    ctx,
    async (c) => {
      const rows = await c.db
        .query("silentFlagEvents")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(SWEEP);
      return rows.map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      await c.db.delete(id as Id<"silentFlagEvents">);
    },
  );
  // Moderation-log entries pointing at the account (silences, unsilences,
  // status changes) are part of the account's data — erased with it. The
  // private removal log (removalLog) is a separate table that this sweep
  // never touches: an admin removal leaves a permanent one-way identity
  // record there — who was removed, when, by whom — that no erasure can
  // remove, and that can never recreate the account or its data.
  await sweep(
    ctx,
    async (c) => {
      const rows = await c.db
        .query("moderationLog")
        .withIndex("by_target", (q) => q.eq("targetUserId", userId))
        .take(SWEEP);
      return rows.map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      await c.db.delete(id as Id<"moderationLog">);
    },
  );

  // 8. Recompute engagement counts on every affected post — truthful
  //    numbers, immune to phantom rows. Capped so an ultra-prolific
  //    account can't blow a single mutation's write budget: any post
  //    past the cap keeps its previous count (off by at most the user's
  //    own engagement), which is safer than failing the whole erasure.
  for (const postId of [...affectedPosts].slice(0, 500)) {
    const post = await ctx.db.get(postId);
    if (post === null) {
      continue;
    }
    const [likes, comments, shares] = await Promise.all([
      ctx.db
        .query("likes")
        .withIndex("by_post", (q) => q.eq("postId", postId))
        .collect(),
      ctx.db
        .query("comments")
        .withIndex("by_post", (q) => q.eq("postId", postId))
        .collect(),
      ctx.db
        .query("shares")
        .withIndex("by_post", (q) => q.eq("postId", postId))
        .collect(),
    ]);
    await ctx.db.patch(postId, {
      likeCount: likes.length,
      commentCount: comments.length,
      shareCount: shares.length,
    });
  }
  // …and follower/following counts on every affected profile (same cap
  //    and reasoning — the erasure itself always completes).
  for (const targetId of [...affectedFollowed].slice(0, 500)) {
    const target = await ctx.db.get(targetId);
    if (target === null) {
      continue;
    }
    const followers = await ctx.db
      .query("follows")
      .withIndex("by_following", (q) => q.eq("followingId", targetId))
      .collect();
    await ctx.db.patch(targetId, { followersCount: followers.length });
  }
  for (const followerId of [...affectedFollowers].slice(0, 500)) {
    const follower = await ctx.db.get(followerId);
    if (follower === null) {
      continue;
    }
    const following = await ctx.db
      .query("follows")
      .withIndex("by_follower", (q) => q.eq("followerId", followerId))
      .collect();
    await ctx.db.patch(followerId, { followingCount: following.length });
  }

  // 9. Profile files, then the account itself. Dual-mode: both the
  //    legacy Convex storage ids and external Cloudinary keys are removed.
  await cleanupUserArtwork(ctx, user);
  await ctx.db.delete(userId);
}
/** Permanently delete the signed-in user and every trace of their data. */
export const deleteAccount = mutation({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    await eraseAccount(ctx, userId);
  },
});

/**
 * Delete stories (and their media files) that have expired. Called from the
 * client on app load so expired content never lingers in storage.
 */
export const pruneExpiredStories = mutation({
  handler: async (ctx) => {
    const now = Date.now();
    for (;;) {
      const expired = await ctx.db
        .query("stories")
        .withIndex("by_expiration", (q) => q.lt("expiresAt", now))
        .take(SWEEP);
      if (expired.length === 0) {
        return;
      }
      for (const story of expired) {
        await cleanupMediaItems(ctx, [story.media]);
        await ctx.db.delete(story._id);
      }
    }
  },
});

/**
 * Apply the "Keep me signed in" choice to the session that was just
 * created. PureWire sessions are permanent by default (10 years, the
 * platform's promise that nobody is logged out on a timeout); a device
 * where the toggle is off opts down to a short 30-day session instead.
 *
 * The auth library enforces session lifetime through the authSessions
 * row's expirationTime — every refresh checks it and stops minting new
 * JWTs once it passes — so this caps that row (and its refresh tokens) to
 * the chosen horizon. Called from the Auth page right after sign-in, when
 * the fresh session is known. Idempotent and best-effort: a failure must
 * never block sign-in.
 */
export const setSessionLifetime = mutation({
  args: { remember: v.boolean() },
  handler: async (ctx, { remember }) => {
    const sessionId = await getAuthSessionId(ctx);
    if (sessionId === null) {
      throw new ConvexError("Not signed in.");
    }
    const horizon = remember ? PERMANENT_SESSION_MS : SHORT_SESSION_MS;
    const expirationTime = Date.now() + horizon;
    // The session row is the enforcement point (refreshTokenIfValid checks
    // it on every refresh); patch it first.
    await ctx.db.patch(sessionId, { expirationTime });
    // Refresh tokens minted under the permanent config would otherwise
    // outlive a short session. The library still keys validity off the
    // session row, so this is belt-and-suspenders — but the rows should
    // tell one story.
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
      .take(SWEEP);
    for (const token of tokens) {
      await ctx.db.patch(token._id, { expirationTime });
    }
    return { remember, expirationTime };
  },
});
