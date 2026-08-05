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

    const [posts, comments, stories, followsOut, followsIn, blocks, notifs] =
      await Promise.all([
        ctx.db
          .query("posts")
          .withIndex("by_author", (q) => q.eq("authorId", userId))
          .collect(),
        ctx.db
          .query("comments")
          .withIndex("by_author", (q) => q.eq("authorId", userId))
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

    return {
      exportedAt: new Date().toISOString(),
      platform: "PureWire",
      profile: publicUser(me),
      stats: {
        posts: posts.length,
        comments: comments.length,
        stories: stories.length,
        following: followsOut.length,
        followers: followsIn.length,
        blocks: blocks.length,
        notifications: notifs.length,
      },
      posts: posts.map((p) => ({
        id: p._id,
        createdAt: p._creationTime,
        content: p.content,
        media: p.media,
        location: p.location,
        likeCount: p.likeCount,
        commentCount: p.commentCount,
      })),
      comments: comments.map((c) => ({
        id: c._id,
        postId: c.postId,
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
