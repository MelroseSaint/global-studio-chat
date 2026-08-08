import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { cleanupMediaItems } from "./mediaCleanup";
import { requireProof } from "./pow";
import { publicUser } from "./privacy";
import { enforceActive, enforceRateLimit, hiddenAuthorIds } from "./security";

import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";

import type { Doc, Id } from "./_generated/dataModel";

/**
 * PureWire's end-to-end-encrypted direct messages.
 *
 * The server is a ciphertext mailbox: it routes opaque AES-GCM blobs
 * between participants and remembers who messaged whom, when. It never
 * sees a message body, a media byte, or a key — those exist only in the
 * participants' browsers (see src/lib/dm-crypto.ts). Even a full database
 * dump is unreadable, which is the point: there is nothing to pull.
 *
 * Everything here is metadata: the pair of participant ids, timestamps,
 * and ciphertext. Account status, blocks, and the DM activity budget are
 * enforced on every write so the mailbox can't be abused as a spam pipe.
 */

/** One encrypted attachment on a message — dual-mode like post media. */
const dmMediaValidator = v.object({
  storageId: v.optional(v.id("_storage")),
  url: v.optional(v.string()),
  key: v.optional(v.string()),
  iv: v.string(),
  mime: v.optional(v.string()),
  kind: v.union(
    v.literal("image"),
    v.literal("video"),
    v.literal("audio"),
  ),
});

/** Cap per sweep so one mutation never exceeds a write budget. */
const SWEEP = 500;

/** A stored JWK public key is a small JSON object — sanity-size it. */
const PUBLIC_KEY_MAX_LENGTH = 4000;

/**
 * Validate a plausible JWK public key before storing it. The server can't
 * cryptographically verify it (that's the browser's job) but it must be a
 * small JSON object containing the P-256 fields — anything else is either
 * a broken client or garbage in, garbage out.
 */
function plausiblePublicKey(value: string): boolean {
  if (value.length === 0 || value.length > PUBLIC_KEY_MAX_LENGTH) {
    return false;
  }
  if (!value.startsWith("{")) {
    return false;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return (
      parsed.kty === "EC" &&
      parsed.crv === "P-256" &&
      typeof parsed.x === "string" &&
      typeof parsed.y === "string"
    );
  } catch {
    return false;
  }
}

/** The two participant ids in a stable sorted order. */
function sortedPair(a: Id<"users">, b: Id<"users">): [Id<"users">, Id<"users">] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Every conversation a user is in: two indexed lookups, concatenated.
 * A user is one side of a conversation or the other, never both, so there
 * is no overlap to dedupe.
 */
async function myConversations(
  ctx: QueryCtx,
  userId: Id<"users">,
  limit: number,
): Promise<Doc<"dmConversations">[]> {
  const [asA, asB] = await Promise.all([
    ctx.db
      .query("dmConversations")
      .withIndex("by_participant_a", (q) => q.eq("participantA", userId))
      .take(limit),
    ctx.db
      .query("dmConversations")
      .withIndex("by_participant_b", (q) => q.eq("participantB", userId))
      .take(limit),
  ]);
  return [...asA, ...asB];
}

/**
 * The conversation for a specific pair, if one already exists. Scans the
 * (bounded) candidates from both sides so even a race-created duplicate
 * pair resolves to an existing thread instead of stacking a new one.
 */
async function findConversation(
  ctx: QueryCtx,
  a: Id<"users">,
  b: Id<"users">,
): Promise<Doc<"dmConversations"> | null> {
  const [asA, asB] = await Promise.all([
    ctx.db
      .query("dmConversations")
      .withIndex("by_participant_a", (q) => q.eq("participantA", a))
      .take(SWEEP),
    ctx.db
      .query("dmConversations")
      .withIndex("by_participant_a", (q) => q.eq("participantA", b))
      .take(SWEEP),
  ]);
  for (const conversation of [...asA, ...asB]) {
    if (
      (conversation.participantA === a && conversation.participantB === b) ||
      (conversation.participantA === b && conversation.participantB === a)
    ) {
      return conversation;
    }
  }
  return null;
}

/**
 * Record (or refresh) this device's public key for the signed-in account.
 * Called by the client the first time Messages opens, after generating the
 * keypair in the browser. The private half never arrives here.
 */
export const setDmPublicKey = mutation({
  args: { publicKey: v.string() },
  handler: async (ctx, { publicKey }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    if (!plausiblePublicKey(publicKey)) {
      throw new Error("That doesn't look like a valid encryption key.");
    }
    await ctx.db.patch(userId, { dmPublicKey: publicKey });
  },
});

/**
 * Find or create the 1:1 conversation between the caller and `userId`.
 * Returns the conversation id plus a minimal peer profile so the client can
 * derive the shared encryption key without another round trip.
 */
export const openConversation = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await getAuthUserId(ctx);
    if (me === null) {
      throw new Error("Not authenticated");
    }
    if (userId === me) {
      throw new Error("You can't message yourself.");
    }
    await enforceActive(ctx, me);
    const target = await ctx.db.get(userId);
    if (target === null) {
      throw new Error("User not found");
    }
    if (target.accountStatus === "banned") {
      throw new Error("You can't message this account right now.");
    }
    // Blocks are mutual hiding: if either side blocked the other (or the
    // target is banned), no conversation can open.
    const hidden = await hiddenAuthorIds(ctx, me);
    if (hidden.includes(userId)) {
      throw new Error("You can't message this account right now.");
    }
    // Granular DM permissions: the target decides who may open a
    // conversation with them, enforced BEFORE any encryption key is
    // derived or ciphertext stored.
    const permission = target.dmPermission ?? "everyone";
    if (permission === "nobody") {
      throw new Error("This member isn't accepting messages right now.");
    }
    if (permission === "following") {
      // Only accounts the target follows may message them.
      const targetFollowsMe = await ctx.db
        .query("follows")
        .withIndex("by_pair", (q) =>
          q.eq("followerId", userId).eq("followingId", me),
        )
        .first();
      if (targetFollowsMe === null) {
        throw new Error(
          "This member only accepts messages from people they follow.",
        );
      }
    }
    const [a, b] = sortedPair(me, userId);
    const existing = await findConversation(ctx, a, b);
    const conversationId =
      existing?._id ??
      (await ctx.db.insert("dmConversations", {
        participantA: a,
        participantB: b,
      }));
    const avatarUrl =
      target.avatarUrl ??
      (target.avatarStorageId
        ? await ctx.storage.getUrl(target.avatarStorageId)
        : null);
    return {
      conversationId,
      peer: {
        ...publicUser(target),
        avatarUrl,
        dmPublicKey: target.dmPublicKey ?? null,
      },
    };
  },
});

/** The caller's conversations, newest activity first, with peer + unread. */
export const listConversations = query({
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    if (me === null) {
      return [];
    }
    const mine = await myConversations(ctx, me, 200);
    const rows = await Promise.all(
      mine.map(async (conversation) => {
        const peerId =
          conversation.participantA === me
            ? conversation.participantB
            : conversation.participantA;
        const peer = peerId !== undefined ? await ctx.db.get(peerId) : null;
        const read = await ctx.db
          .query("dmReads")
          .withIndex("by_user_conversation", (q) =>
            q.eq("userId", me).eq("conversationId", conversation._id),
          )
          .first();
        const lastMessageAt = conversation.lastMessageAt ?? conversation._creationTime;
        const unread =
          conversation.lastMessageSenderId !== me &&
          lastMessageAt > (read?.lastReadAt ?? 0);
        return {
          conversationId: conversation._id,
          lastMessageAt,
          unread,
          peer:
            peer === null
              ? null
              : {
                  ...publicUser(peer),
                  avatarUrl:
                    peer.avatarUrl ??
                    (peer.avatarStorageId
                      ? await ctx.storage.getUrl(peer.avatarStorageId)
                      : null),
                  dmPublicKey: peer.dmPublicKey ?? null,
                },
        };
      }),
    );
    return rows
      .filter((r) => r.peer !== null)
      .sort((x, y) => y.lastMessageAt - x.lastMessageAt);
  },
});

/** Unread DM count for the nav badge. */
export const unreadDmCount = query({
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    if (me === null) {
      return 0;
    }
    const mine = await myConversations(ctx, me, 200);
    let unread = 0;
    for (const conversation of mine) {
      if (conversation.lastMessageSenderId === me) {
        continue;
      }
      const read = await ctx.db
        .query("dmReads")
        .withIndex("by_user_conversation", (q) =>
          q.eq("userId", me).eq("conversationId", conversation._id),
        )
        .first();
      if (
        (conversation.lastMessageAt ?? conversation._creationTime) >
        (read?.lastReadAt ?? 0)
      ) {
        unread++;
      }
    }
    return unread;
  },
});

/** Messages in a conversation, oldest first, paginated. */
export const listMessages = query({
  args: {
    conversationId: v.id("dmConversations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { conversationId, paginationOpts }) => {
    const me = await getAuthUserId(ctx);
    if (me === null) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const conversation = await ctx.db.get(conversationId);
    if (
      conversation === null ||
      (conversation.participantA !== me && conversation.participantB !== me)
    ) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    // Newest first so the initial page is the LIVE end of the thread; the
    // client reverses the concatenated pages for chronological display and
    // loadMore pulls progressively older pages.
    const result = await ctx.db
      .query("dmMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .paginate(paginationOpts);
    // Resolve attachment URLs (a Convex storage id becomes a readable URL;
    // Cloudinary items already carry one). The bytes stay encrypted either
    // way — this only points the client at where to fetch the ciphertext.
    const page = await Promise.all(
      result.page.map(async (message) => ({
        ...message,
        media:
          message.media === undefined
            ? undefined
            : {
                url:
                  message.media.url ??
                  (message.media.storageId
                    ? await ctx.storage.getUrl(message.media.storageId)
                    : null),
                iv: message.media.iv,
                mime: message.media.mime ?? null,
                kind: message.media.kind,
              },
      })),
    );
    return { ...result, page };
  },
});

/**
 * Store one encrypted message. The ciphertext arrives pre-encrypted from
 * the sender's browser — the server validates the caller, budgets the
 * write, and files the blob. It also nudges the recipient's notification
 * inbox (metadata only: who, when — never content).
 */
export const sendMessage = mutation({
  args: {
    conversationId: v.id("dmConversations"),
    ciphertext: v.string(),
    iv: v.string(),
    media: v.optional(dmMediaValidator),
    // The id of a post being shared into the thread (see schema.ts — the
    // reference is public metadata; only a text caption would be encrypted).
    sharedPostId: v.optional(v.id("posts")),
    // Client-side proof-of-work, same scheme as createPost. DM spam is the
    // classic bot attack vector — a puzzle per message multiplies with the
    // per-action rate limit.
    powChallenge: v.optional(v.string()),
    powNonce: v.optional(v.string()),
    powIssuedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    {
      conversationId,
      ciphertext,
      iv,
      media,
      sharedPostId,
      powChallenge,
      powNonce,
      powIssuedAt,
    },
  ) => {
    const me = await getAuthUserId(ctx);
    if (me === null) {
      throw new Error("Not authenticated");
    }
    await requireProof(powChallenge, powNonce, powIssuedAt);
    await enforceActive(ctx, me);
    const conversation = await ctx.db.get(conversationId);
    if (
      conversation === null ||
      (conversation.participantA !== me && conversation.participantB !== me)
    ) {
      throw new Error("Conversation not found");
    }
    // A block placed after the conversation opened still cuts the line —
    // no DMs through a block, in either direction.
    const hidden = await hiddenAuthorIds(ctx, me);
    const recipientId =
      conversation.participantA === me
        ? conversation.participantB
        : conversation.participantA;
    if (
      recipientId === undefined ||
      hidden.includes(recipientId) ||
      // No empty husks: every message carries encrypted text, an encrypted
      // attachment, or a shared post reference (or any combination).
      (ciphertext.length === 0 &&
        media === undefined &&
        sharedPostId === undefined) ||
      ciphertext.length > 200_000 ||
      iv.length > 64
    ) {
      throw new Error("Message could not be sent");
    }
    // A shared post must exist at send time — a preview that instantly
    // breaks is worse than a rejection. (It can still be deleted later;
    // the recipient's preview then degrades to "no longer available".)
    if (
      sharedPostId !== undefined &&
      (await ctx.db.get(sharedPostId)) === null
    ) {
      throw new Error("That post is no longer available");
    }
    await enforceRateLimit(ctx, me, "dm");
    const now = Date.now();
    const messageId = await ctx.db.insert("dmMessages", {
      conversationId,
      senderId: me,
      ciphertext,
      iv,
      ...(media !== undefined ? { media } : {}),
      ...(sharedPostId !== undefined ? { sharedPostId } : {}),
    });
    await ctx.db.patch(conversationId, {
      lastMessageAt: now,
      lastMessageSenderId: me,
    });
    // A message that shares a post gets a distinct "dm-share" notification
    // (post + conversation attached) so the bell can say "shared a post
    // with you" and open the exact thread — instead of the generic DM
    // ping. Only the reference is metadata; the caption stays encrypted.
    await ctx.db.insert("notifications", {
      userId: recipientId,
      type: sharedPostId !== undefined ? "dm-share" : "dm",
      actorId: me,
      ...(sharedPostId !== undefined
        ? { postId: sharedPostId, conversationId }
        : {}),
      read: false,
    });
    return { messageId };
  },
});

/** Mark a conversation read up to now for the caller. */
export const markConversationRead = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, { conversationId }) => {
    const me = await getAuthUserId(ctx);
    if (me === null) {
      return;
    }
    const conversation = await ctx.db.get(conversationId);
    if (
      conversation === null ||
      (conversation.participantA !== me && conversation.participantB !== me)
    ) {
      return;
    }
    const existing = await ctx.db
      .query("dmReads")
      .withIndex("by_user_conversation", (q) =>
        q.eq("userId", me).eq("conversationId", conversationId),
      )
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { lastReadAt: Date.now() });
    } else {
      await ctx.db.insert("dmReads", {
        conversationId,
        userId: me,
        lastReadAt: Date.now(),
      });
    }
  },
});

/**
 * Permanently delete a conversation and every trace of it: all messages,
 * their encrypted media files (both storage modes), read watermarks, and
 * the conversation row. PureWire holds no plaintext and no keys, so a
 * deleted conversation exists nowhere — there is no copy anywhere to
 * recover. Either participant can do it; it removes the thread for both.
 */
export const deleteConversation = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx: MutationCtx, { conversationId }) => {
    const me = await getAuthUserId(ctx);
    if (me === null) {
      throw new Error("Not authenticated");
    }
    const conversation = await ctx.db.get(conversationId);
    if (
      conversation === null ||
      (conversation.participantA !== me && conversation.participantB !== me)
    ) {
      throw new Error("Conversation not found");
    }
    let deleted = 0;
    for (;;) {
      const messages = await ctx.db
        .query("dmMessages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .take(SWEEP);
      if (messages.length === 0) {
        break;
      }
      for (const message of messages) {
        if (message.media !== undefined) {
          await cleanupMediaItems(ctx, [message.media]);
        }
        await ctx.db.delete(message._id);
        deleted++;
      }
    }
    const reads = await ctx.db
      .query("dmReads")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .take(SWEEP);
    for (const read of reads) {
      await ctx.db.delete(read._id);
    }
    await ctx.db.delete(conversationId);
    return { deleted };
  },
});
