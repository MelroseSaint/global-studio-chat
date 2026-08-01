import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { AI_MEDIA_STATUS, scanText } from "./aiContent";
import { publicUser } from "./privacy";
import {
  enforceActive,
  enforceRateLimit,
  escalateSilently,
  hiddenAuthorIds,
  isSandboxed,
  silencedAuthorIds,
} from "./security";

import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/**
 * Simple FNV-1a fingerprint used to verify content originality.
 * Every post is checked against recent posts before it goes live:
 * PureWire only allows verified original content on the feed.
 */
function fingerprint(content: string): string {
  let hash = 0x811c9dc5;
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

async function isDuplicate(
  ctx: MutationCtx,
  authorId: Id<"users">,
  fp: string,
): Promise<{ kind: "stolen" } | { kind: "own-recent" } | null> {
  const recent = await ctx.db
    .query("posts")
    .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fp))
    .filter((row) =>
      row.gte(row.field("_creationTime"), Date.now() - 7 * 24 * 3600_000),
    )
    .take(5);
  for (const post of recent) {
    // Prevent stealing another user's content and oversaturation.
    if (post.authorId !== authorId) {
      return { kind: "stolen" };
    }
  }
  const own = recent.find((p) => p.authorId === authorId);
  if (own && Date.now() - own._creationTime < 5 * 60_000) {
    return { kind: "own-recent" };
  }
  return null;
}

/** Resolve @username mentions in content to user ids and notify them. */
async function notifyMentions(
  ctx: MutationCtx,
  content: string,
  authorId: Id<"users">,
  postId: Id<"posts">,
) {
  const mentions = [...content.matchAll(/@([a-z0-9_]{3,24})/gi)].map((m) =>
    m[1].toLowerCase(),
  );
  const unique = [...new Set(mentions)];
  for (const username of unique) {
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    if (target !== null && target._id !== authorId) {
      await ctx.db.insert("notifications", {
        userId: target._id,
        type: "mention",
        actorId: authorId,
        postId,
        read: false,
      });
    }
  }
}

export const createPost = mutation({
  args: {
    content: v.string(),
    media: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          kind: v.union(
            v.literal("image"),
            v.literal("video"),
            v.literal("audio"),
          ),
        }),
      ),
    ),
    // Verdict from the client-side scan action (api.aiContent.scanMediaForAi),
    // which reads the uploaded bytes — the only place storage reads exist.
    aiMediaStatus: v.optional(AI_MEDIA_STATUS),
  },
  handler: async (ctx, { content, media, aiMediaStatus }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const text = content.trim();
    if (text.length === 0 && (media === undefined || media.length === 0)) {
      throw new Error("Post must contain text or media.");
    }
    if (text.length > 1000) {
      throw new Error("Post is too long (max 1000 characters).");
    }
    // Quiet sandbox: a shadowbanned or pending-review account's post is
    // accepted so nothing looks wrong to them, but silencedAuthorIds keeps
    // it invisible to everyone else until a human reviews the account.
    if (await isSandboxed(ctx, userId)) {
      const postId = await ctx.db.insert("posts", {
        authorId: userId,
        content: text,
        media,
        aiStatus: "clean",
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
      });
      const me = await ctx.db.get(userId);
      await ctx.db.patch(userId, { postsCount: (me?.postsCount ?? 0) + 1 });
      return postId;
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "post");
    const fp = text.length > 0 ? fingerprint(text) : undefined;
    if (fp !== undefined) {
      const blocked = await isDuplicate(ctx, userId, fp);
      if (blocked !== null) {
        // Reposting someone else's content is a strong spam signal — count
        // it toward a quiet shadowban. Your own recent re-posts are a gentle
        // nudge, never an escalation.
        if (blocked.kind === "stolen") {
          await escalateSilently(ctx, userId, 3);
        }
        throw new Error(
          blocked.kind === "stolen"
            ? "This content already exists on PureWire. Only original posts are allowed."
            : "You've posted this recently. Please wait a moment.",
        );
      }
    }
    // Anti-AI enforcement: block clear AI content, flag suspicious text
    // for a human review in the admin dashboard.
    const textScan = scanText(text);
    if (textScan.status === "blocked") {
      throw new Error(
        "AI-generated content isn't allowed on PureWire. Say it yourself — in your own words.",
      );
    }
    if (aiMediaStatus === "blocked") {
      throw new Error(
        "This media looks AI-generated, which isn't allowed on PureWire. Upload your own original work.",
      );
    }
    // If media is present but no scan verdict was provided (e.g. a client
    // that never ran the scan action), send it to the human review queue
    // instead of trusting it as clean.
    const mediaVerdict: "clean" | "review" | "blocked" =
      media !== undefined && media.length > 0 && aiMediaStatus === undefined
        ? "review"
        : (aiMediaStatus ?? "clean");
    const needsReview =
      textScan.status === "review" || mediaVerdict === "review";
    if (needsReview) {
      // Repeated suspicious content moves an account toward a quiet
      // shadowban instead of an abrupt ban.
      await escalateSilently(ctx, userId, 2);
    }
    const postId = await ctx.db.insert("posts", {
      authorId: userId,
      content: text,
      media,
      fingerprint: fp,
      // Only claim originality when a fingerprint check actually ran.
      originalityVerified: fp !== undefined,
      aiStatus: needsReview ? "review" : "clean",
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
    });
    const me = await ctx.db.get(userId);
    await ctx.db.patch(userId, { postsCount: (me?.postsCount ?? 0) + 1 });
    if (text.length > 0) {
      await notifyMentions(ctx, text, userId, postId);
    }
    return postId;
  },
});

export const deletePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const post = await ctx.db.get(postId);
    if (post === null) {
      return;
    }
    const user = await ctx.db.get(userId);
    if (post.authorId !== userId && user?.role !== "admin") {
      throw new Error("You can only delete your own posts.");
    }
    await ctx.db.delete(postId);
  },
});

async function withMedia(ctx: QueryCtx, user: Doc<"users"> | null) {
  if (user === null) {
    return null;
  }
  const [avatarUrl, bannerUrl] = await Promise.all([
    user.avatarStorageId ? ctx.storage.getUrl(user.avatarStorageId) : null,
    user.bannerStorageId ? ctx.storage.getUrl(user.bannerStorageId) : null,
  ]);
  return { ...publicUser(user), avatarUrl, bannerUrl };
}

async function withAuthor(
  ctx: QueryCtx,
  post: Doc<"posts">,
  viewerId: Id<"users"> | null,
) {
  const author = await withMedia(ctx, await ctx.db.get(post.authorId));
  let likedByMe = false;
  if (viewerId !== null) {
    const like = await ctx.db
      .query("likes")
      .withIndex("by_pair", (q) =>
        q.eq("userId", viewerId).eq("postId", post._id),
      )
      .first();
    likedByMe = like !== null;
  }
  const mediaUrls = post.media
    ? await Promise.all(
        post.media.map(async (m) => ({
          ...m,
          url: await ctx.storage.getUrl(m.storageId),
        })),
      )
    : undefined;
  return {
    ...post,
    author,
    likedByMe,
    mediaUrls,
  };
}

export const feed = query({
  args: {
    paginationOpts: paginationOptsValidator,
    // PureWire has no algorithmic feed — users choose what they see.
    // "global" and "latest" both show the platform in time order today;
    // they stay distinct tabs so users control their view, and so a future
    // ranking layer can never be silently forced on anyone.
    filter: v.union(
      v.literal("global"),
      v.literal("following"),
      v.literal("latest"),
      v.literal("media"),
    ),
  },
  handler: async (ctx, { paginationOpts, filter }) => {
    const viewerId = await getAuthUserId(ctx);
    // Pick the tab's base query first…
    let base = ctx.db.query("posts");
    if (filter === "following" && viewerId !== null) {
      const follows = await ctx.db
        .query("follows")
        .withIndex("by_follower", (q) => q.eq("followerId", viewerId))
        .take(100);
      const authorIds = new Set([
        viewerId,
        ...follows.map((f) => f.followingId),
      ]);
      if (authorIds.size > 1) {
        base = ctx.db
          .query("posts")
          .filter((q) =>
            q.or(...[...authorIds].map((id) => q.eq(q.field("authorId"), id))),
          );
      }
      // Viewer follows nobody — keep the full feed as the base.
    } else if (filter === "media") {
      // media is either undefined or a non-empty array (enforced in createPost)
      base = ctx.db
        .query("posts")
        .filter((q) => q.neq(q.field("media"), undefined));
    }
    // …then apply the safety exclusions on every tab: accounts the viewer
    // blocked, accounts that blocked the viewer, banned accounts, accounts
    // awaiting admin approval, and quietly shadowbanned accounts — in both
    // directions. A silenced user still sees their own posts.
    const hiddenIds = await hiddenAuthorIds(ctx, viewerId);
    const silencedIds = await silencedAuthorIds(ctx, viewerId);
    const excludedIds = [...hiddenIds, ...silencedIds];
    if (excludedIds.length > 0) {
      base = base.filter((q) =>
        q.not(q.or(...excludedIds.map((id) => q.eq(q.field("authorId"), id)))),
      );
    }
    // Posts awaiting a human AI-review are kept out of public feeds.
    base = base.filter((q) => q.neq(q.field("aiStatus"), "review"));
    const result = await base.order("desc").paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map((p) => withAuthor(ctx, p, viewerId)),
    );
    return { ...result, page };
  },
});

export const getPost = query({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const viewerId = await getAuthUserId(ctx);
    const post = await ctx.db.get(postId);
    if (post === null) {
      return null;
    }
    // Blocked, blocking, banned, pending-review, and shadowbanned authors
    // are invisible to the viewer.
    const hiddenIds = await hiddenAuthorIds(ctx, viewerId);
    const silencedIds = await silencedAuthorIds(ctx, viewerId);
    if (hiddenIds.includes(post.authorId) || silencedIds.includes(post.authorId)) {
      return null;
    }
    // Posts awaiting AI review are only visible to their author and admins.
    if (post.aiStatus === "review") {
      const viewer = viewerId !== null ? await ctx.db.get(viewerId) : null;
      const isAuthor = viewerId === post.authorId;
      if (!isAuthor && viewer?.role !== "admin") {
        return null;
      }
    }
    return await withAuthor(ctx, post, viewerId);
  },
});

export const likePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    // A sandboxed account's like is silently absorbed — it counts for the
    // liker's UI but never reaches the author or the public count.
    if (await isSandboxed(ctx, userId)) {
      const post = await ctx.db.get(postId);
      if (post !== null) {
        const absorbed = await ctx.db
          .query("likes")
          .withIndex("by_pair", (q) => q.eq("userId", userId).eq("postId", postId))
          .first();
        if (absorbed === null) {
          await ctx.db.insert("likes", { userId, postId });
        }
      }
      return;
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "like");
    const post = await ctx.db.get(postId);
    if (post === null) {
      throw new Error("Post not found");
    }
    const existing = await ctx.db
      .query("likes")
      .withIndex("by_pair", (q) => q.eq("userId", userId).eq("postId", postId))
      .first();
    if (existing !== null) {
      return;
    }
    await ctx.db.insert("likes", { userId, postId });
    await ctx.db.patch(postId, { likeCount: post.likeCount + 1 });
    if (post.authorId !== userId) {
      await ctx.db.insert("notifications", {
        userId: post.authorId,
        type: "like",
        actorId: userId,
        postId,
        read: false,
      });
    }
  },
});

export const unlikePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const post = await ctx.db.get(postId);
    if (post === null) {
      return;
    }
    const existing = await ctx.db
      .query("likes")
      .withIndex("by_pair", (q) => q.eq("userId", userId).eq("postId", postId))
      .first();
    if (existing === null) {
      return;
    }
    await ctx.db.delete(existing._id);
    await ctx.db.patch(postId, {
      likeCount: Math.max(0, post.likeCount - 1),
    });
  },
});

export const addComment = mutation({
  args: { postId: v.id("posts"), content: v.string() },
  handler: async (ctx, { postId, content }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const text = content.trim();
    if (text.length === 0 || text.length > 500) {
      throw new Error("Comment must be between 1 and 500 characters.");
    }
    // A sandboxed account's comment is silently absorbed — stored for their
    // own UI but invisible to the author and everyone else.
    if (await isSandboxed(ctx, userId)) {
      const post = await ctx.db.get(postId);
      if (post !== null) {
        await ctx.db.insert("comments", {
          postId,
          authorId: userId,
          content: text,
        });
      }
      return;
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "comment");
    const textScan = scanText(text);
    if (textScan.status === "blocked") {
      throw new Error(
        "AI-generated content isn't allowed on PureWire. Say it in your own words.",
      );
    }
    const post = await ctx.db.get(postId);
    if (post === null) {
      throw new Error("Post not found");
    }
    await ctx.db.insert("comments", {
      postId,
      authorId: userId,
      content: text,
    });
    await ctx.db.patch(postId, { commentCount: post.commentCount + 1 });
    if (post.authorId !== userId) {
      await ctx.db.insert("notifications", {
        userId: post.authorId,
        type: "comment",
        actorId: userId,
        postId,
        read: false,
      });
    }
  },
});

export const deleteComment = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, { commentId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const comment = await ctx.db.get(commentId);
    if (comment === null) {
      return;
    }
    const user = await ctx.db.get(userId);
    if (comment.authorId !== userId && user?.role !== "admin") {
      throw new Error("You can only delete your own comments.");
    }
    const post = await ctx.db.get(comment.postId);
    if (post !== null) {
      await ctx.db.patch(post._id, {
        commentCount: Math.max(0, post.commentCount - 1),
      });
    }
    await ctx.db.delete(commentId);
  },
});

export const listComments = query({
  args: { postId: v.id("posts"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { postId, paginationOpts }) => {
    const viewerId = await getAuthUserId(ctx);
    const hidden = await hiddenAuthorIds(ctx, viewerId);
    const silenced = await silencedAuthorIds(ctx, viewerId);
    const excluded = [...hidden, ...silenced];
    const result = await ctx.db
      .query("comments")
      .withIndex("by_post", (q) => q.eq("postId", postId))
      .order("desc")
      .paginate(paginationOpts);
    const visible = result.page.filter((c) => !excluded.includes(c.authorId));
    const page = await Promise.all(
      visible.map(async (c) => {
        const author = await ctx.db.get(c.authorId);
        return { ...c, author: author ? publicUser(author) : null };
      }),
    );
    return { ...result, page };
  },
});

export const sharePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    // A sandboxed account's share is silently absorbed.
    if (await isSandboxed(ctx, userId)) {
      return;
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "share");
    const post = await ctx.db.get(postId);
    if (post === null) {
      throw new Error("Post not found");
    }
    const existing = await ctx.db
      .query("shares")
      .withIndex("by_pair", (q) => q.eq("userId", userId).eq("postId", postId))
      .first();
    if (existing !== null) {
      return;
    }
    await ctx.db.insert("shares", { postId, userId });
    await ctx.db.patch(postId, { shareCount: post.shareCount + 1 });
    if (post.authorId !== userId) {
      await ctx.db.insert("notifications", {
        userId: post.authorId,
        type: "share",
        actorId: userId,
        postId,
        read: false,
      });
    }
  },
});

export const listUserPosts = query({
  args: { userId: v.id("users"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { userId, paginationOpts }) => {
    const viewerId = await getAuthUserId(ctx);
    const viewer = viewerId !== null ? await ctx.db.get(viewerId) : null;
    // Blocked, blocking, banned, pending-review, and shadowbanned accounts
    // are invisible to the viewer.
    const hiddenIds = await hiddenAuthorIds(ctx, viewerId);
    const silencedIds = await silencedAuthorIds(ctx, viewerId);
    const hidden = hiddenIds.includes(userId) || silencedIds.includes(userId);
    if (hidden && viewer?.role !== "admin") {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const canSeePending = viewerId === userId || viewer?.role === "admin";
    let base = ctx.db
      .query("posts")
      .withIndex("by_author", (q) => q.eq("authorId", userId));
    if (!canSeePending) {
      // Posts awaiting AI review stay hidden from other users.
      base = base.filter((q) => q.neq(q.field("aiStatus"), "review"));
    }
    const result = await base.order("desc").paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map((p) => withAuthor(ctx, p, viewerId)),
    );
    return { ...result, page };
  },
});
