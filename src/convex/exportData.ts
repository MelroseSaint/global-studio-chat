import { getAuthUserId } from "@convex-dev/auth/server";

import { publicUser } from "./privacy";
import { query } from "./_generated/server";

/**
 * User Data Export — Privacy-Preserving Transparency.
 *
 * One call returns everything the signed-in user has ever created:
 * profile, posts, comments, stories, follows, blocks, notifications.
 * The client assembles it into a downloadable JSON archive. This is a
 * read-only query (a data read, not a write), so it costs nothing to run
 * repeatedly and holds no state. Content is returned in full — it's the
 * user's own data, and they're entitled to every byte of it.
 */
export const exportMyData = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const me = await ctx.db.get(userId);
    if (me === null) throw new Error("Account not found");

    const [
      posts,
      comments,
      commentLikes,
      stories,
      followsOut,
      followsIn,
      blocks,
      notifs,
    ] = await Promise.all([
      ctx.db
        .query("posts")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .collect(),
      ctx.db
        .query("comments")
        .withIndex("by_author", (q) => q.eq("authorId", userId))
        .collect(),
      ctx.db
        .query("commentLikes")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
        ctx.db
          .query("stories")
          .withIndex("by_author", (q) => q.eq("authorId", userId))
          .collect(),
        ctx.db
          .query("follows")
          .withIndex("by_follower", (q) => q.eq("followerId", userId))
          .collect(),
        ctx.db
          .query("follows")
          .withIndex("by_following", (q) => q.eq("followingId", userId))
          .collect(),
        ctx.db
          .query("blocks")
          .withIndex("by_blocker", (q) => q.eq("blockerId", userId))
          .collect(),
        ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .collect(),
      ]);

    // Resolve every media item to a downloadable URL (Cloudinary wins,
    // Convex storage as the legacy/fallback) so the client can drop the
    // actual files into the export ZIP without re-deriving storage URLs.
    const postsWithMedia = await Promise.all(
      posts.map(async (p) => ({
        id: p._id,
        createdAt: p._creationTime,
        content: p.content,
        media: await Promise.all(
          (p.media ?? []).map(async (m) => ({
            kind: m.kind,
            url:
              m.url ??
              (m.storageId ? await ctx.storage.getUrl(m.storageId) : null),
          })),
        ),
        location: p.location,
        likeCount: p.likeCount,
        commentCount: p.commentCount,
      })),
    );
    const mediaCount = postsWithMedia.reduce(
      (n, p) => n + p.media.length,
      0,
    );

    return {
      exportedAt: new Date().toISOString(),
      platform: "PureWire",
      profile: publicUser(me),
      // Account preferences. videoAutoplay lives on the users row (synced
      // from the device on every change), so the export covers it even
      // though the browser keeps a local cache copy.
      preferences: {
        videoAutoplay: me.videoAutoplay ?? "auto",
      },
      stats: {
        posts: posts.length,
        comments: comments.length,
        commentLikes: commentLikes.length,
        stories: stories.length,
        following: followsOut.length,
        followers: followsIn.length,
        blocks: blocks.length,
        notifications: notifs.length,
        media: mediaCount,
      },
      posts: postsWithMedia,
      comments: comments.map((c) => ({
        id: c._id,
        postId: c.postId,
        // The top-level comment this replies to, when it's a reply.
        parentId: c.parentId ?? null,
        createdAt: c._creationTime,
        content: c.content,
      })),
      stories: stories.map((s) => ({
        id: s._id,
        createdAt: s._creationTime,
        caption: s.caption,
      })),
      following: followsOut.map((f) => f.followingId),
      followers: followsIn.map((f) => f.followerId),
      blocked: blocks.map((b) => b.blockedId),
    };
  },
});
