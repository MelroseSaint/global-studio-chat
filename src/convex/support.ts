import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { mutation, query } from "./_generated/server";

export const createTicket = mutation({
  args: {
    subject: v.string(),
    message: v.string(),
    postId: v.optional(v.id("posts")),
    offenderId: v.optional(v.id("users")),
    violation: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    if (args.subject.trim().length === 0 || args.message.trim().length === 0) {
      throw new Error("Subject and message are required.");
    }
    return await ctx.db.insert("supportTickets", {
      userId,
      subject: args.subject.trim(),
      message: args.message.trim(),
      postId: args.postId,
      offenderId: args.offenderId,
      violation: args.violation,
      status: "open",
    });
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
    const result = await ctx.db
      .query("supportTickets")
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (t) => ({
        ...t,
        user: await ctx.db.get(t.userId),
        post: t.postId ? await ctx.db.get(t.postId) : null,
        offender: t.offenderId ? await ctx.db.get(t.offenderId) : null,
      })),
    );
    return { ...result, page };
  },
});

export const respondToTicket = mutation({
  args: {
    ticketId: v.id("supportTickets"),
    reply: v.string(),
    status: v.optional(
      v.union(v.literal("open"), v.literal("in_review"), v.literal("resolved")),
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
    await ctx.db.patch(ticketId, {
      reply,
      status: status ?? "resolved",
    });
    const ticket = await ctx.db.get(ticketId);
    if (ticket !== null) {
      await ctx.db.insert("notifications", {
        userId: ticket.userId,
        type: "ticket",
        actorId: userId,
        message: reply,
        read: false,
      });
    }
  },
});
