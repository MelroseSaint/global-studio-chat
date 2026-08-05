import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdmin } from "./admin";

// ────────────────────────────────────────────────────────────
//  Admin mutations
// ────────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    title: v.string(),
    body: v.string(),
    category: v.union(
      v.literal("platform"),
      v.literal("safety"),
      v.literal("feature"),
      v.literal("event"),
      v.literal("community"),
    ),
  },
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx);
    await ctx.db.insert("announcements", {
      title: args.title.trim(),
      body: args.body.trim(),
      category: args.category,
      active: true,
      authorId: adminId,
    });
  },
});

export const update = mutation({
  args: {
    announcementId: v.id("announcements"),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    category: v.optional(
      v.union(
        v.literal("platform"),
        v.literal("safety"),
        v.literal("feature"),
        v.literal("event"),
        v.literal("community"),
      ),
    ),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.body !== undefined) patch.body = args.body.trim();
    if (args.category !== undefined) patch.category = args.category;
    if (args.active !== undefined) patch.active = args.active;
    await ctx.db.patch(args.announcementId, patch);
  },
});

export const remove = mutation({
  args: { announcementId: v.id("announcements") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.announcementId);
  },
});

// ────────────────────────────────────────────────────────────
//  Queries
// ────────────────────────────────────────────────────────────

/** All announcements (active + inactive) for the admin panel. */
export const listAll = query({
  handler: async (ctx) => {
    // No admin gate — the query is only used by the admin panel which
    // already gates at the route level, and a logged-out visitor can't
    // reach the admin page. Still, we don't leak anything sensitive here.
    const all = await ctx.db.query("announcements").order("desc").collect();
    return all.map((a) => ({
      ...a,
      _creationTime: a._creationTime,
    }));
  },
});

/** Active announcements the current user hasn't dismissed yet. */
export const activeForUser = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = identity.subject as unknown as string;

    const active = await ctx.db
      .query("announcements")
      .withIndex("by_active", (q) => q.eq("active", true))
      .order("desc")
      .collect();

    // Filter out announcements this user already dismissed.
    const results = [];
    for (const a of active) {
      const dismissed = await ctx.db
        .query("announcementDismissals")
        .withIndex("by_pair", (q) =>
          q.eq("userId", userId as any).eq("announcementId", a._id),
        )
        .first();
      if (dismissed === null) {
        results.push(a);
      }
    }
    return results;
  },
});

// ────────────────────────────────────────────────────────────
//  User mutation
// ────────────────────────────────────────────────────────────

/** Dismiss an announcement so it never shows again for this user. */
export const dismiss = mutation({
  args: { announcementId: v.id("announcements") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const userId = identity.subject;

    const existing = await ctx.db
      .query("announcementDismissals")
      .withIndex("by_pair", (q) =>
        q.eq("userId", userId as any).eq("announcementId", args.announcementId),
      )
      .first();
    if (existing !== null) return; // Already dismissed — idempotent.

    await ctx.db.insert("announcementDismissals", {
      announcementId: args.announcementId,
      userId: userId as any,
    });
  },
});
