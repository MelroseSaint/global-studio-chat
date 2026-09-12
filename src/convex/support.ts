import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { isStandardId } from "@/lib/standard";

import { assertAdminIpVerified } from "./adminIp";
import { publicUser } from "./privacy";
import { enforceRateLimit } from "./security";

import { mutation, query } from "./_generated/server";

export const createTicket = mutation({
  args: {
    subject: v.string(),
    message: v.string(),
    postId: v.optional(v.id("posts")),
    offenderId: v.optional(v.id("users")),
    violation: v.optional(v.string()),
    standardId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    if (args.subject.trim().length === 0 || args.message.trim().length === 0) {
      throw new Error("Subject and message are required.");
    }
    // A report/ticket can only cite a real PureWire Standard principle.
    if (args.standardId !== undefined && !isStandardId(args.standardId)) {
      throw new Error("That isn't a principle of the PureWire Standard.");
    }
    // Reports are an anti-abuse surface — budget them like every other
    // activity so a malicious member can't flood the admin queue with
    // one-tap reports (10/hour is far beyond genuine reporting).
    await enforceRateLimit(ctx, userId, "ticket");
    // Dedupe: the same member reporting the same target under the same
    // principle twice (double-tap, a second device) returns the existing
    // open ticket instead of inserting a duplicate.
    const mine = await ctx.db
      .query("supportTickets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const existing = mine.find(
      (t) =>
        t.status === "open" &&
        t.standardId === args.standardId &&
        (t.postId ?? null) === (args.postId ?? null) &&
        (t.offenderId ?? null) === (args.offenderId ?? null),
    );
    if (existing !== undefined) {
      return existing._id;
    }
    const ticketId = await ctx.db.insert("supportTickets", {
      userId,
      subject: args.subject.trim(),
      message: args.message.trim(),
      postId: args.postId,
      offenderId: args.offenderId,
      violation: args.violation,
      standardId: args.standardId,
      status: "open",
    });
    // Increment the post's report count — a live signal of member concern
    // that admins see in the queue beside the automated scan evidence.
    if (args.postId !== undefined) {
      const post = await ctx.db.get(args.postId);
      if (post !== null) {
        await ctx.db.patch(args.postId, {
          reportCount: (post.reportCount ?? 0) + 1,
        });
      }
    }
    return ticketId;
  },
});

export const myTickets = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    return await ctx.db
      .query("supportTickets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const listTickets = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") {
      throw new Error("Admins only");
    }
    // Backend-verified device gate (see adminIp.ts).
    await assertAdminIpVerified(ctx);
    const result = await ctx.db
      .query("supportTickets")
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (t) => {
        const user = await ctx.db.get(t.userId);
        const offender = t.offenderId ? await ctx.db.get(t.offenderId) : null;
        return {
          ...t,
          user: user ? publicUser(user) : null,
          post: t.postId ? await ctx.db.get(t.postId) : null,
          offender: offender ? publicUser(offender) : null,
        };
      }),
    );
    return { ...result, page };
  },
});

export const respondToTicket = mutation({
  args: {
    ticketId: v.id("supportTickets"),
    reply: v.string(),
    status: v.optional(
      v.union(v.literal("open"), v.literal("in_review"), v.literal("resolved"), v.literal("dismissed")),
    ),
  },
  handler: async (ctx, { ticketId, reply, status }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") {
      throw new Error("Admins only");
    }
    // Backend-verified device gate (see adminIp.ts).
    await assertAdminIpVerified(ctx);
    const ticket = await ctx.db.get(ticketId);
    if (ticket === null) {
      throw new Error("Ticket not found.");
    }
    // Effective status covers the default: when the admin doesn't touch
    // the dropdown the patch still resolves the ticket, and the decrement
    // guard below must see that effective value, not undefined.
    const effective = status ?? "resolved";
    await ctx.db.patch(ticketId, {
      reply,
      status: effective,
    });
    // When a ticket targeting a post is closed (resolved or dismissed),
    // decrement the post's report count so the signal ages off correctly.
    if (
      ticket.postId !== undefined &&
      effective !== "open" &&
      effective !== "in_review" &&
      ticket.status !== "resolved" &&
      ticket.status !== "dismissed"
    ) {
      const post = await ctx.db.get(ticket.postId);
      if (post !== null) {
        await ctx.db.patch(ticket.postId, {
          reportCount: Math.max(0, (post.reportCount ?? 0) - 1),
        });
      }
    }
    await ctx.db.insert("notifications", {
      userId: ticket.userId,
      type: "ticket",
      actorId: userId,
      message: reply,
      read: false,
    });
  },
});
