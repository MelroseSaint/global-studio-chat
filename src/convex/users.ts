import { paginationOptsValidator } from "convex/server";
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
import { scanBlockedContent } from "./blocklist";
import { scanForRacism } from "@/lib/racism-guard";
import {
  enforceActive,
  enforceRateLimit,
  escalateSilently,
  hiddenAuthorIds,
  isSandboxed,
  silencedAuthorIds,
} from "./security";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";

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

/**
 * Normalize a profile link for scanning so the scanner always sees a real
 * destination: bare hostnames AND scheme-less host+path forms ("twitter.com/me",
 * "bit.ly/xyz", "purewire-login.xyz/verify") get https:// — the sloppy
 * paste is exactly how a scammer would dodge an https://-only check.
 * Non-web schemes (mailto:, tel:) are left alone.
 */
function normalizeProfileUrl(raw: string): string {
  const u = raw.trim();
  if (u.length === 0) return u;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (u.startsWith("www.") || (!/\s/.test(u) && u.includes("."))) {
    return `https://${u}`;
  }
  return u;
}

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
    // Granular DM permission: who may open a conversation with this user.
    dmPermission: v.optional(
      v.union(
        v.literal("everyone"),
        v.literal("following"),
        v.literal("nobody"),
      ),
    ),
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
    // Phishing and account-integrity enforcement: profiles are prime real
    // estate for credential and money harvesting ("free followers, link in
    // bio"), so the bio and every link are scanned before the edit lands.
    // The rejection is a structured result, NOT a throw — the quiet-flag
    // escalation must commit, and Convex rolls every write back when a
    // mutation throws. Same atomicity pattern as createPost.
    // Racism scan on display name: the name is a public identity surface.
    if (args.name !== undefined && args.name.trim().length > 0) {
      const nameScan = scanForRacism(args.name);
      if (nameScan.status === "blocked") {
        await escalateSilently(ctx, userId, 5, "harassment", "racism-block-profile");
        return {
          ok: false,
          error: `That display name can't be used — ${nameScan.reason}.`,
        };
      }
      if (nameScan.status === "review") {
        await escalateSilently(ctx, userId, 2, "harassment", "racism-review-profile");
        return {
          ok: false,
          error: `That display name can't be used — ${nameScan.reason}.`,
        };
      }
    }
    // Racism scan on bio: the same public identity surface as the name.
    if (args.bio !== undefined && args.bio.trim().length > 0) {
      const bioRacismScan = scanForRacism(args.bio);
      if (bioRacismScan.status === "blocked") {
        await escalateSilently(ctx, userId, 5, "harassment", "racism-block-profile");
        return {
          ok: false,
          error: `That bio can't be used — ${bioRacismScan.reason}.`,
        };
      }
      if (bioRacismScan.status === "review") {
        await escalateSilently(ctx, userId, 2, "harassment", "racism-review-profile");
        return {
          ok: false,
          error: `That bio can't be used — ${bioRacismScan.reason}.`,
        };
      }
    }
    if (args.bio !== undefined && args.bio.trim().length > 0) {
      const bioScan = await scanBlockedContent(ctx, args.bio);
      if (bioScan.status !== "clean") {
        await escalateSilently(
          ctx,
          userId,
          bioScan.status === "blocked" ? 3 : 2,
          "scam",
          bioScan.status === "blocked"
            ? "phish-block-profile"
            : "phish-review-profile",
        );
        return {
          ok: false,
          error:
            bioScan.status === "blocked"
              ? (bioScan.message ??
                "That bio looks like a phishing or scam message — it can't be saved.")
              : "That bio can't be saved as-is — please rephrase. Some links and phrases aren't allowed on profiles for your safety.",
        };
      }
    }
    if (args.links !== undefined && args.links.length > 0) {
      for (const link of args.links) {
        const linkScan = await scanBlockedContent(
          ctx,
          normalizeProfileUrl(link.url),
        );
        if (linkScan.status !== "clean") {
          await escalateSilently(
            ctx,
            userId,
            linkScan.status === "blocked" ? 3 : 2,
            "scam",
            linkScan.status === "blocked"
              ? "phish-block-profile"
              : "phish-review-profile",
          );
          return {
            ok: false,
            error:
              linkScan.status === "blocked"
                ? (linkScan.message ??
                  "That link looks like a phishing or scam link — it can't be added to your profile.")
                : "That link can't be added to your profile — use the direct link instead of a shortened or hidden one.",
          };
        }
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
      // The qa_/pwtest prefixes are reserved for the QA harness's
      // throwaway accounts. A real user claiming one would make the
      // test-trace sweep (purgeTestTraces) unable to tell their removal
      // from a test erasure — so the prefixes are never assignable here.
      if (/^(qa_|pwtest)/i.test(username)) {
        throw new Error("That username isn't available — pick another.");
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
    return updated ? { ok: true as const, user: publicUser(updated) } : null;
  },
});

/**
 * Granular DM permission: who may open a conversation with this user.
 * Enforced in dms.openConversation BEFORE any key derivation.
 */
export const setDmPermission = mutation({
  args: {
    dmPermission: v.union(
      v.literal("everyone"),
      v.literal("following"),
      v.literal("nobody"),
    ),
  },
  handler: async (ctx, { dmPermission }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    await ctx.db.patch(userId, { dmPermission });
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

/**
 * Shared tail for the follow-list queries (listFollowers / listFollowing):
 * hide accounts the viewer can't see (blocked in either direction, quietly
 * shadowbanned, pending-approval, restricted, or banned), optionally filter
 * by the search text, resolve the avatar, and mark which accounts the
 * viewer follows and which is the viewer themself. `limit` caps the page;
 * in browse mode the caller passes the paginated page, in search mode the
 * bounded scan result.
 */
async function withFollowListMeta(
  ctx: QueryCtx,
  viewerId: Id<"users"> | null,
  people: Doc<"users">[],
  query: string,
  limit = 100,
) {
  const q = query.toLowerCase().trim();
  const hidden = new Set<Id<"users">>([
    ...(await hiddenAuthorIds(ctx, viewerId)),
    ...(await silencedAuthorIds(ctx, viewerId)),
  ]);
  // Batch the viewer's own follow state in one pass over their follows,
  // instead of one lookup per row.
  const following = new Set<Id<"users">>();
  if (viewerId !== null) {
    const mine = await ctx.db
      .query("follows")
      .withIndex("by_follower", (q) => q.eq("followerId", viewerId))
      .take(500);
    for (const f of mine) {
      following.add(f.followingId);
    }
  }
  const matches = people
    .filter(
      (u) =>
        // The same visibility rule every other user-listing surface uses
        // (searchUsers, suggestedUsers): nothing pending approval,
        // restricted, banned, or quietly shadowbanned appears — and
        // blocked accounts (either direction) are excluded too.
        !hidden.has(u._id) &&
        u.shadowban !== true &&
        (u.accountStatus === undefined || u.accountStatus === "active") &&
        (q.length === 0 ||
          (u.username ?? "").includes(q) ||
          (u.name ?? "").toLowerCase().includes(q)),
    )
    .slice(0, limit);
  return Promise.all(
    matches.map(async (u) => ({
      ...publicUser(u),
      // Dual-mode: an external Cloudinary URL wins; otherwise resolve the
      // Convex storage id (legacy/fallback path).
      avatarUrl:
        u.avatarUrl ??
        (u.avatarStorageId ? await ctx.storage.getUrl(u.avatarStorageId) : null),
      isFollowing: following.has(u._id),
      isViewer: u._id === viewerId,
    })),
  );
}

/**
 * Search mode for a follow list: a bounded scan of the most recent follows,
 * filtered by name/@username and capped at a small result set — fast,
 * because finding one person in a big list is what search is for. Returns a
 * one-shot page that is immediately done, so the client never tries to
 * scroll deeper into a search.
 */
async function followListSearch(
  ctx: QueryCtx,
  viewerId: Id<"users"> | null,
  q: string,
  rows: Doc<"follows">[],
  resolve: (r: Doc<"follows">) => Id<"users">,
) {
  const people = (
    await Promise.all(rows.map((r) => ctx.db.get(resolve(r))))
  ).filter((u): u is Doc<"users"> => u !== null);
  const page = await withFollowListMeta(ctx, viewerId, people, q, 50);
  return { page, isDone: true, continueCursor: "" };
}

/** The people following a profile, searchable by name or @username. */
export const listFollowers = query({
  args: {
    username: v.string(),
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { username, query, paginationOpts }) => {
    const viewerId = await getAuthUserId(ctx);
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (target === null || !(await canViewTarget(ctx, viewerId, target))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const q = (query ?? "").trim();
    if (q.length > 0) {
      // Search: bounded scan of the most recent followers.
      const rows = await ctx.db
        .query("follows")
        .withIndex("by_following", (x) => x.eq("followingId", target._id))
        .take(300);
      return followListSearch(ctx, viewerId, q, rows, (r) => r.followerId);
    }
    // Browse: paginate the follower rows, newest first — no fixed cap, so a
    // celebrity-scale circle can be scrolled end to end. Each page is
    // filtered for visibility after pagination (same cost cap as
    // listComments) and the client keeps loading while pages remain.
    const result = await ctx.db
      .query("follows")
      .withIndex("by_following", (x) => x.eq("followingId", target._id))
      .order("desc")
      .paginate(paginationOpts);
    const people = (
      await Promise.all(result.page.map((r) => ctx.db.get(r.followerId)))
    ).filter((u): u is Doc<"users"> => u !== null);
    const page = await withFollowListMeta(ctx, viewerId, people, "", people.length);
    return { ...result, page };
  },
});

/** The people a profile follows, searchable by name or @username. */
export const listFollowing = query({
  args: {
    username: v.string(),
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { username, query, paginationOpts }) => {
    const viewerId = await getAuthUserId(ctx);
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (target === null || !(await canViewTarget(ctx, viewerId, target))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const q = (query ?? "").trim();
    if (q.length > 0) {
      // Search: bounded scan of the most recent people followed.
      const rows = await ctx.db
        .query("follows")
        .withIndex("by_follower", (x) => x.eq("followerId", target._id))
        .take(300);
      return followListSearch(ctx, viewerId, q, rows, (r) => r.followingId);
    }
    // Browse: paginate, newest first.
    const result = await ctx.db
      .query("follows")
      .withIndex("by_follower", (x) => x.eq("followerId", target._id))
      .order("desc")
      .paginate(paginationOpts);
    const people = (
      await Promise.all(result.page.map((r) => ctx.db.get(r.followingId)))
    ).filter((u): u is Doc<"users"> => u !== null);
    const page = await withFollowListMeta(ctx, viewerId, people, "", people.length);
    return { ...result, page };
  },
});

/**
 * The same shadowban gate getProfile uses: a quietly shadowbanned profile's
 * lists are only visible to the account itself and admins, so the list
 * queries can't be used to enumerate a hidden user's circle directly.
 */
async function canViewTarget(
  ctx: QueryCtx,
  viewerId: Id<"users"> | null,
  target: Doc<"users">,
): Promise<boolean> {
  if (target.shadowban !== true) {
    return true;
  }
  if (viewerId === target._id) {
    return true;
  }
  const viewer = viewerId !== null ? await ctx.db.get(viewerId) : null;
  return viewer?.role === "admin";
}

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
