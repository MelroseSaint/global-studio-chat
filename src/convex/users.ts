import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { enforceActive, enforceRateLimit, isSandboxed } from "./security";

import { mutation, query } from "./_generated/server";

export const getCurrentUser = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      return null;
    }
    const [avatarUrl, bannerUrl] = await Promise.all([
      user.avatarStorageId ? ctx.storage.getUrl(user.avatarStorageId) : null,
      user.bannerStorageId ? ctx.storage.getUrl(user.bannerStorageId) : null,
    ]);
    return { ...user, avatarUrl, bannerUrl };
  },
});

export const getProfile = query({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (user === null) {
      return null;
    }
    const viewerId = await getAuthUserId(ctx);
    // A quietly shadowbanned account's profile is invisible to everyone
    // except the account itself and admins — same silence as their posts.
    if (user.shadowban === true) {
      const viewer = viewerId !== null ? await ctx.db.get(viewerId) : null;
      if (viewerId !== user._id && viewer?.role !== "admin") {
        return null;
      }
    }
    let isFollowing = false;
    let isSelf = false;
    if (viewerId !== null) {
      isSelf = viewerId === user._id;
      if (!isSelf) {
        const follow = await ctx.db
          .query("follows")
          .withIndex("by_pair", (q) =>
            q.eq("followerId", viewerId).eq("followingId", user._id),
          )
          .first();
        isFollowing = follow !== null;
      }
    }
    const [avatarUrl, bannerUrl] = await Promise.all([
      user.avatarStorageId ? ctx.storage.getUrl(user.avatarStorageId) : null,
      user.bannerStorageId ? ctx.storage.getUrl(user.bannerStorageId) : null,
    ]);
    return {
      ...user,
      avatarUrl,
      bannerUrl,
      isFollowing,
      isSelf,
    };
  },
});

export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    username: v.optional(v.string()),
    bio: v.optional(v.string()),
    links: v.optional(
      v.array(v.object({ platform: v.string(), url: v.string() })),
    ),
    avatarStorageId: v.optional(v.id("_storage")),
    bannerStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    // Banned/restricted accounts can't keep changing their identity.
    await enforceActive(ctx, userId);
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.bio !== undefined) patch.bio = args.bio;
    if (args.links !== undefined) patch.links = args.links;
    if (args.avatarStorageId !== undefined)
      patch.avatarStorageId = args.avatarStorageId;
    if (args.bannerStorageId !== undefined)
      patch.bannerStorageId = args.bannerStorageId;
    if (args.username !== undefined) {
      const username = args.username.toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (username.length < 3) {
        throw new Error("Username must be at least 3 characters.");
      }
      const existing = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .first();
      if (existing !== null && existing._id !== userId) {
        throw new Error("That username is already taken.");
      }
      patch.username = username;
    }
    await ctx.db.patch(userId, patch);
    return await ctx.db.get(userId);
  },
});

export const follow = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const followerId = await getAuthUserId(ctx);
    if (followerId === null) {
      throw new Error("Not authenticated");
    }
    // A sandboxed account's follow is silently absorbed — a phantom follow
    // row keeps their UI looking normal, but it never reaches the target's
    // counts or notifications.
    if (await isSandboxed(ctx, followerId)) {
      const target = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
        .first();
      if (target !== null && target._id !== followerId) {
        const existing = await ctx.db
          .query("follows")
          .withIndex("by_pair", (q) =>
            q.eq("followerId", followerId).eq("followingId", target._id),
          )
          .first();
        if (existing === null) {
          await ctx.db.insert("follows", {
            followerId,
            followingId: target._id,
          });
        }
      }
      return;
    }
    await enforceActive(ctx, followerId);
    await enforceRateLimit(ctx, followerId, "follow");
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (target === null) {
      throw new Error("User not found");
    }
    if (target._id === followerId) {
      throw new Error("You cannot follow yourself");
    }
    const existing = await ctx.db
      .query("follows")
      .withIndex("by_pair", (q) =>
        q.eq("followerId", followerId).eq("followingId", target._id),
      )
      .first();
    if (existing !== null) {
      return;
    }
    await ctx.db.insert("follows", {
      followerId,
      followingId: target._id,
    });
    await ctx.db.patch(target._id, {
      followersCount: (target.followersCount ?? 0) + 1,
    });
    const me = await ctx.db.get(followerId);
    await ctx.db.patch(followerId, {
      followingCount: (me?.followingCount ?? 0) + 1,
    });
    await ctx.db.insert("notifications", {
      userId: target._id,
      type: "follow",
      actorId: followerId,
      read: false,
    });
  },
});

export const unfollow = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const followerId = await getAuthUserId(ctx);
    if (followerId === null) {
      throw new Error("Not authenticated");
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (target === null) {
      throw new Error("User not found");
    }
    const existing = await ctx.db
      .query("follows")
      .withIndex("by_pair", (q) =>
        q.eq("followerId", followerId).eq("followingId", target._id),
      )
      .first();
    if (existing === null) {
      return;
    }
    await ctx.db.delete(existing._id);
    await ctx.db.patch(target._id, {
      followersCount: Math.max(0, (target.followersCount ?? 0) - 1),
    });
    const me = await ctx.db.get(followerId);
    await ctx.db.patch(followerId, {
      followingCount: Math.max(0, (me?.followingCount ?? 0) - 1),
    });
  },
});

export const isFollowing = query({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const viewerId = await getAuthUserId(ctx);
    if (viewerId === null) {
      return false;
    }
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (target === null) {
      return false;
    }
    const follow = await ctx.db
      .query("follows")
      .withIndex("by_pair", (q) =>
        q.eq("followerId", viewerId).eq("followingId", target._id),
      )
      .first();
    return follow !== null;
  },
});

export const suggestedUsers = query({
  handler: async (ctx) => {
    const viewerId = await getAuthUserId(ctx);
    if (viewerId === null) {
      return [];
    }
    const following = await ctx.db
      .query("follows")
      .withIndex("by_follower", (q) => q.eq("followerId", viewerId))
      .take(200);
    const followingIds = new Set(following.map((f) => f.followingId));
    const all = await ctx.db.query("users").take(200);
    // Suspicious (awaiting approval), restricted, banned, and quietly
    // shadowbanned accounts never appear as suggestions — they're off the
    // public surface until cleared.
    const visible = (u: {
      accountStatus?: string | undefined;
      shadowban?: boolean | null | undefined;
    }) =>
      u.shadowban !== true &&
      (u.accountStatus === undefined || u.accountStatus === "active");
    const candidates = all
      .filter(
        (u) =>
          u._id !== viewerId &&
          !followingIds.has(u._id) &&
          (u.username ?? "").length > 0 &&
          visible(u),
      )
      .sort((a, b) => (b.followersCount ?? 0) - (a.followersCount ?? 0))
      .slice(0, 5);
    return await Promise.all(
      candidates.map(async (u) => ({
        ...u,
        avatarUrl: u.avatarStorageId ? await ctx.storage.getUrl(u.avatarStorageId) : null,
        bannerUrl: u.bannerStorageId ? await ctx.storage.getUrl(u.bannerStorageId) : null,
      })),
    );
  },
});

export const searchUsers = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const q = query.toLowerCase().trim();
    if (q.length === 0) {
      return [];
    }
    const all = await ctx.db.query("users").take(500);
    // Suspicious/restricted/banned/shadowbanned accounts are invisible in search.
    const matches = all.filter(
      (u) =>
        u.shadowban !== true &&
        (u.accountStatus === undefined || u.accountStatus === "active") &&
        ((u.username ?? "").includes(q) ||
          (u.name ?? "").toLowerCase().includes(q)),
    );
    return await Promise.all(
      matches.slice(0, 10).map(async (u) => {
        const [avatarUrl, bannerUrl] = await Promise.all([
          u.avatarStorageId ? ctx.storage.getUrl(u.avatarStorageId) : null,
          u.bannerStorageId ? ctx.storage.getUrl(u.bannerStorageId) : null,
        ]);
        return { ...u, avatarUrl, bannerUrl };
      }),
    );
  },
});
