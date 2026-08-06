import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";

import { ADMIN_EMAIL, PERMANENT_SESSION_MS, SHORT_SESSION_MS } from "./auth";
import { cleanupMediaItems, cleanupUserArtwork } from "./mediaCleanup";

import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

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
  | Id<"moderationLog">
  | Id<"dmMessages">
  | Id<"dmReads">
  | Id<"dmConversations">
  | Id<"storyViews">;

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
    // The sessionPrefs row ("Keep me signed in" opt-out marker) dies with
    // its session — a preference must never outlive the session it keys.
    const pref = await ctx.db
      .query("sessionPrefs")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .first();
    if (pref !== null) {
      await ctx.db.delete(pref._id);
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

  // 3. Stories — media files deleted with each row, and the story's
  //    viewer rows swept so no orphan views survive the account.
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
      const views = await c.db
        .query("storyViews")
        .withIndex("by_story", (q) => q.eq("storyId", story._id))
        .take(SWEEP);
      for (const view of views) {
        await c.db.delete(view._id);
      }
      await cleanupMediaItems(c, [story.media]);
      await c.db.delete(story._id);
    },
  );

  // 3b. Story views this user left on other people's stories.
  await sweep(
    ctx,
    async (c) => {
      const rows = await c.db
        .query("storyViews")
        .withIndex("by_viewer", (q) => q.eq("viewerId", userId))
        .take(SWEEP);
      return rows.map((r) => ({ id: r._id }));
    },
    async (c, { id }) => {
      await c.db.delete(id as Id<"storyViews">);
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
  //    The tickets' target posts are remembered so their reportCount can
  //    be recomputed afterwards — erasing a reporter's tickets without
  //    touching the counts they fed would leave every reported post's
  //    reportCount permanently inflated.
  const reportAffected = new Set<Id<"posts">>();
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
      const ticket = await c.db.get(id as Id<"supportTickets">);
      if (ticket !== null && ticket.postId !== undefined) {
        reportAffected.add(ticket.postId);
      }
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

  // 7.5 Direct messages — every conversation the user was part of dies
  //     with them, for BOTH sides: all messages, their encrypted media
  //     files (both storage modes), read watermarks, and the conversation
  //     row. PureWire holds no plaintext or keys, so this is complete by
  //     construction — erasure is the whole point of the ciphertext-only
  //     design.
  await sweep(
    ctx,
    async (c) => {
      // The user is one side of a conversation or the other, never both —
      // both indexed lookups, concatenated.
      const [asA, asB] = await Promise.all([
        c.db
          .query("dmConversations")
          .withIndex("by_participant_a", (q) => q.eq("participantA", userId))
          .take(SWEEP),
        c.db
          .query("dmConversations")
          .withIndex("by_participant_b", (q) => q.eq("participantB", userId))
          .take(SWEEP),
      ]);
      return [...asA, ...asB].map((conversation) => ({ id: conversation._id }));
    },
    async (c, { id }) => {
      const conversationId = id as Id<"dmConversations">;
      for (;;) {
        const messages = await c.db
          .query("dmMessages")
          .withIndex("by_conversation", (q) =>
            q.eq("conversationId", conversationId),
          )
          .take(SWEEP);
        if (messages.length === 0) {
          break;
        }
        for (const message of messages) {
          if (message.media !== undefined) {
            await cleanupMediaItems(c, [message.media]);
          }
          await c.db.delete(message._id);
        }
      }
      const reads = await c.db
        .query("dmReads")
        .withIndex("by_conversation", (q) =>
          q.eq("conversationId", conversationId),
        )
        .take(SWEEP);
      for (const read of reads) {
        await c.db.delete(read._id);
      }
      await c.db.delete(conversationId);
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
  // …and reportCount on every post this account reported (same cap and
  //    reasoning). A report count is derived state: the number of tickets
  //    in open/in_review on the post, so the erased tickets converge the
  //    count back to the surviving reports.
  for (const postId of [...reportAffected].slice(0, 500)) {
    const post = await ctx.db.get(postId);
    if (post === null) {
      continue;
    }
    const tickets = await ctx.db
      .query("supportTickets")
      .filter((q) => q.eq(q.field("postId"), postId))
      .take(SWEEP);
    const reportCount = tickets.filter(
      (t) => t.status === "open" || t.status === "in_review",
    ).length;
    await ctx.db.patch(postId, { reportCount });
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
        // Sweep the viewer rows so the storyViews table never outlives a
        // story (the nightly data-integrity audit asserts zero orphans).
        const views = await ctx.db
          .query("storyViews")
          .withIndex("by_story", (q) => q.eq("storyId", story._id))
          .take(SWEEP);
        for (const view of views) {
          await ctx.db.delete(view._id);
        }
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
    // Record the device preference so the session-lifetime audit can tell a
    // deliberate opt-out (this row) from a silent regression (no row). Only
    // opt-outs are stored — the permanent default needs no marker.
    const pref = await ctx.db
      .query("sessionPrefs")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (remember) {
      if (pref !== null) {
        await ctx.db.delete(pref._id);
      }
    } else if (pref === null) {
      await ctx.db.insert("sessionPrefs", { sessionId, remember: false });
    }
    return { remember, expirationTime };
  },
});

/**
 * The current device's session, for the Settings → Sessions surface: when
 * it was created and whether it is the permanent default or a deliberate
 * opt-out ("Keep me signed in" off). Only this session is returned — the
 * platform never lists other devices' sessions to the client.
 */
export const getCurrentSession = query({
  handler: async (ctx: QueryCtx) => {
    const sessionId = await getAuthSessionId(ctx);
    if (sessionId === null) {
      return null;
    }
    const session = await ctx.db.get(sessionId);
    if (session === null) {
      return null;
    }
    // An opt-out marker means the owner chose a short session; its absence
    // is the permanent 10-year default. Mirrors setSessionLifetime.
    const pref = await ctx.db
      .query("sessionPrefs")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    // How many other devices are signed in — lets the UI disable the
    // "sign out everywhere else" button when there's nothing to end.
    const userId = await getAuthUserId(ctx);
    const otherSessions =
      userId === null
        ? 0
        : (
            await ctx.db
              .query("authSessions")
              .withIndex("userId", (q) => q.eq("userId", userId))
              .take(SWEEP)
          ).filter((s) => s._id !== sessionId).length;
    return {
      sessionId,
      createdAt: session._creationTime,
      expirationTime: session.expirationTime,
      permanent: pref === null,
      otherSessions,
    };
  },
});

/**
 * End the session on every other device, keeping this one signed in.
 * Deletes all of the user's other authSessions rows together with their
 * refresh tokens, verification records, and opt-out markers — the same
 * sweep eraseAccount performs per session. The current session survives so
 * the person stays right where they are.
 */
export const signOutOtherSessions = mutation({
  handler: async (ctx: MutationCtx) => {
    const userId = await getAuthUserId(ctx);
    const currentSessionId = await getAuthSessionId(ctx);
    if (userId === null || currentSessionId === null) {
      throw new ConvexError("Not signed in.");
    }
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .take(SWEEP);
    let ended = 0;
    for (const session of sessions) {
      if (session._id === currentSessionId) {
        continue;
      }
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const token of tokens) {
        await ctx.db.delete(token._id);
      }
      // authVerifiers has no sessionId index — scan and filter, matching
      // the erasure sweep's approach.
      const verifiers = await ctx.db.query("authVerifiers").collect();
      for (const verifier of verifiers) {
        if (verifier.sessionId === session._id) {
          await ctx.db.delete(verifier._id);
        }
      }
      const pref = await ctx.db
        .query("sessionPrefs")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .first();
      if (pref !== null) {
        await ctx.db.delete(pref._id);
      }
      await ctx.db.delete(session._id);
      ended++;
    }
    return { ended };
  },
});
