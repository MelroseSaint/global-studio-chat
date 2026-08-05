import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
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
    // Unix ms timestamp. When set to a future time, the announcement is
    // "scheduled" and goes live automatically when that time arrives.
    // Omit (or set to a past time) for an immediately-active announcement.
    scheduledAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx);
    const now = Date.now();
    const isScheduled =
      args.scheduledAt !== undefined && args.scheduledAt > now;

    await ctx.db.insert("announcements", {
      title: args.title.trim(),
      body: args.body.trim(),
      category: args.category,
      status: isScheduled ? "scheduled" : "active",
      scheduledAt: args.scheduledAt,
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
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("scheduled"),
        v.literal("inactive"),
      ),
    ),
    scheduledAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.body !== undefined) patch.body = args.body.trim();
    if (args.category !== undefined) patch.category = args.category;
    if (args.status !== undefined) patch.status = args.status;
    if (args.scheduledAt !== undefined) patch.scheduledAt = args.scheduledAt;
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
//  Auto-activation: called on every home-page load so scheduled
//  announcements go live without a cron setup. Minimal work —
//  only fetches rows whose scheduledAt <= now and patches them.
// ────────────────────────────────────────────────────────────

export const activateScheduled = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();
    // Fetch all scheduled announcements whose time has come.
    // The by_scheduled index is ordered, so we can scan from the
    // earliest scheduled time up to now.
    const due = await ctx.db
      .query("announcements")
      .withIndex("by_status", (q) => q.eq("status", "scheduled"))
      .filter((q) => q.lte(q.field("scheduledAt"), now))
      .collect();

    for (const a of due) {
      await ctx.db.patch(a._id, { status: "active" });
    }
  },
});

// ────────────────────────────────────────────────────────────
//  Queries
// ────────────────────────────────────────────────────────────

/** All announcements (active + scheduled + inactive) for the admin panel. */
export const listAll = query({
  handler: async (ctx) => {
    const all = await ctx.db.query("announcements").order("desc").collect();
    return all.map((a) => ({
      ...a,
      _creationTime: a._creationTime,
    }));
  },
});

/** Active announcements the current user hasn't dismissed yet.
 *  Includes scheduled announcements whose time has come (treated as
 *  active by the query filter — the actual status promotion happens
 *  via the internal activateScheduled mutation, called from a cron or
 *  admin action). */
export const activeForUser = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = identity.subject as unknown as string;
    const now = Date.now();

    // Get active announcements.
    const active = await ctx.db
      .query("announcements")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .order("desc")
      .collect();

    // Get scheduled announcements whose time has come (not yet promoted
    // to "active" by the cron — we show them immediately on first load).
    const due = await ctx.db
      .query("announcements")
      .withIndex("by_status", (q) => q.eq("status", "scheduled"))
      .filter((q) => q.lte(q.field("scheduledAt"), now))
      .collect();

    const allVisible = [...active, ...due];

    // Filter out announcements this user already dismissed.
    const results = [];
    for (const a of allVisible) {
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
    if (existing !== null) return;

    await ctx.db.insert("announcementDismissals", {
      announcementId: args.announcementId,
      userId: userId as any,
    });
  },
});
