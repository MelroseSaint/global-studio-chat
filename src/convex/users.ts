import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { ADMIN_EMAIL } from "./auth";
import {
  cleanLocationLabel,
  coarsenLocation,
  homeLocationValidator,
} from "./location";
import { keyFromPublicUrl } from "./media";
import { publicUser } from "./privacy";
import {
  detectFollowChurn,
  detectReciprocalFollow,
} from "./farmNetwork";
import { enforceActive, enforceRateLimit, isSandboxed } from "./security";

import { internal } from "./_generated/api";
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
      // Dual-mode: an external Cloudinary URL wins; otherwise resolve the
      // Convex storage id (legacy/fallback path).
      user.avatarUrl ??
        (user.avatarStorageId ? ctx.storage.getUrl(user.avatarStorageId) : null),
      user.bannerUrl ??
        (user.bannerStorageId ? ctx.storage.getUrl(user.bannerStorageId) : null),
    ]);
    return {
      ...publicUser(user),
      avatarUrl,
      bannerUrl,
      // Lets the client lock the owner's identity fields (name, handle,
      // deletion) so they're disabled in the UI, not just rejected by the
      // server. Derived from the email here so no surface needs the
      // plain-text address.
      isOwner: user.email === ADMIN_EMAIL,
    };
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
      // Dual-mode: an external Cloudinary URL wins; otherwise resolve the
      // Convex storage id (legacy/fallback path).
      user.avatarUrl ??
        (user.avatarStorageId ? ctx.storage.getUrl(user.avatarStorageId) : null),
      user.bannerUrl ??
        (user.bannerStorageId ? ctx.storage.getUrl(user.bannerStorageId) : null),
    ]);
    return {
      ...publicUser(user),
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
    // Dual-mode profile artwork: a Convex storage id (legacy/fallback) OR
    // an external Cloudinary URL (primary path once CLOUDINARY_* is set).
    // Pass null to clear the field entirely.
    avatarStorageId: v.optional(v.union(v.null(), v.id("_storage"))),
    bannerStorageId: v.optional(v.union(v.null(), v.id("_storage"))),
    avatarUrl: v.optional(v.union(v.null(), v.string())),
    bannerUrl: v.optional(v.union(v.null(), v.string())),
    // Home location: a public label plus coordinates. The coordinates are
    // never stored precisely — they are coarsened to a ~1 km cell on write
    // (never the point) and stripped from every client response, matching
    // the plain-text email treatment. They exist server-side only so the
    // Local feed can center itself when live browser geolocation isn't
    // granted. Pass null to remove the location entirely.
    location: v.optional(
      v.union(v.null(), homeLocationValidator),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    // Banned/restricted accounts can't keep changing their identity.
    await enforceActive(ctx, userId);
    const current = await ctx.db.get(userId);
    // The owner account is unalterable: its identity fields — the handle
    // and the display name — can never be changed, even by the owner. The
    // Settings form always submits both, so only a change is rejected;
    // an unchanged re-save (e.g. editing the bio) still goes through.
    // Cosmetic fields (bio, links, artwork, location) stay editable so the
    // owner personalizes the account like anyone else — but the identity
    // anchor itself is fixed for the life of the platform.
    if (current?.email === ADMIN_EMAIL) {
      const nextName = args.name !== undefined ? args.name.trim() : undefined;
      const nextUsername =
        args.username !== undefined
          ? args.username.toLowerCase().replace(/[^a-z0-9_]/g, "")
          : undefined;
      if (
        (nextName !== undefined && nextName !== (current.name ?? "").trim()) ||
        (nextUsername !== undefined && nextUsername !== (current.username ?? ""))
      ) {
        throw new Error("The owner account cannot be changed.");
      }
    }
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.bio !== undefined) patch.bio = args.bio;
    if (args.links !== undefined) patch.links = args.links;
    if (args.avatarStorageId !== undefined) {
      patch.avatarStorageId = args.avatarStorageId;
      // Setting a new avatar clears the other mode's reference so the two
      // never fight over which URL wins on read.
      patch.avatarUrl = null;
    }
    if (args.avatarUrl !== undefined) {
      patch.avatarUrl = args.avatarUrl;
      patch.avatarStorageId = null;
    }
    if (args.bannerStorageId !== undefined) {
      patch.bannerStorageId = args.bannerStorageId;
      patch.bannerUrl = null;
    }
    if (args.bannerUrl !== undefined) {
      patch.bannerUrl = args.bannerUrl;
      patch.bannerStorageId = null;
    }
    // The old avatar/banner files are only ever replaced, never leaked.
    // But only when artwork is actually being set/cleared this call — a
    // plain profile save (name/bio/links/location) must NOT delete the
    // current picture. Convex storage ids delete inline (mutations can);
    // external Cloudinary keys go through the fire-and-forget batch delete.
    const artworkChanging =
      args.avatarStorageId !== undefined ||
      args.avatarUrl !== undefined ||
      args.bannerStorageId !== undefined ||
      args.bannerUrl !== undefined;
    if (artworkChanging) {
      const oldKeys: string[] = [];
      if (current?.avatarStorageId) {
        await ctx.storage.delete(current.avatarStorageId);
      }
      if (current?.bannerStorageId) {
        await ctx.storage.delete(current.bannerStorageId);
      }
      if (current?.avatarUrl) {
        const key = keyFromPublicUrl(current.avatarUrl);
        if (key !== null) oldKeys.push(key);
      }
      if (current?.bannerUrl) {
        const key = keyFromPublicUrl(current.bannerUrl);
        if (key !== null) oldKeys.push(key);
      }
      if (oldKeys.length > 0) {
        // Profile artwork is always an image asset.
        await ctx.scheduler.runAfter(0, internal.mediaStorage.deleteExternalKeys, {
          keys: oldKeys.map((key) => ({ key, resourceType: "image" })),
        });
      }
    }
    if (args.location !== undefined) {
      patch.location =
        args.location === null
          ? null
          : coarsenLocation({
              // Clients never receive coordinates (publicUser strips
              // them). Preserve the stored anchor only when the label is
              // UNCHANGED (a plain re-save of an existing place); a
              // changed label without fresh coordinates is a new place,
              // so the old neighborhood anchor must not carry over — the
              // Local feed would stay centered on a stale area.
              latitude:
                args.location.latitude ??
                (cleanLocationLabel(args.location.label) ===
                  current?.location?.label
                  ? current?.location?.latitude
                  : undefined),
              longitude:
                args.location.longitude ??
                (cleanLocationLabel(args.location.label) ===
                  current?.location?.label
                  ? current?.location?.longitude
                  : undefined),
              label: cleanLocationLabel(args.location.label),
            });
    }
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
    const updated = await ctx.db.get(userId);
    return updated ? publicUser(updated) : null;
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
            createdAt: Date.now(),
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
      createdAt: Date.now(),
    });
    await detectReciprocalFollow(ctx, followerId, target._id);
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
    await detectFollowChurn(ctx, followerId, existing.createdAt);
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
        ...publicUser(u),
        // Dual-mode: an external Cloudinary URL wins; otherwise resolve the
        // Convex storage id (legacy/fallback path).
        avatarUrl:
          u.avatarUrl ??
          (u.avatarStorageId ? await ctx.storage.getUrl(u.avatarStorageId) : null),
        bannerUrl:
          u.bannerUrl ??
          (u.bannerStorageId ? await ctx.storage.getUrl(u.bannerStorageId) : null),
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
          // Dual-mode: an external Cloudinary URL wins; otherwise resolve the
          // Convex storage id (legacy/fallback path).
          u.avatarUrl ??
            (u.avatarStorageId ? ctx.storage.getUrl(u.avatarStorageId) : null),
          u.bannerUrl ??
            (u.bannerStorageId ? ctx.storage.getUrl(u.bannerStorageId) : null),
        ]);
        return { ...publicUser(u), avatarUrl, bannerUrl };
      }),
    );
  },
});
