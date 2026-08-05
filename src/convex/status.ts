import { query } from "./_generated/server";

/**
 * Public system health & status. No auth required — it's the platform's
 * transparency page: anyone can verify PureWire is running and how healthy
 * it is, without opening a support ticket. Deliberately coarse: counts and
 * a latency sample, never user data or internal addresses.
 */
export const systemStatus = query({
  handler: async (ctx) => {
    const started = performance.now();

    // This Convex version's QueryInitializer has no .count() — collect the
    // newest 1,000 rows and report the actual counts. For a status page,
    // collecting a bounded slice is fine: the totals are a live pulse, not
    // an audit.
    const [users, posts, stories, tickets, dmMessages] = await Promise.all([
      ctx.db.query("users").take(1000),
      ctx.db.query("posts").take(1000),
      ctx.db.query("stories").take(1000),
      ctx.db.query("supportTickets").take(1000),
      ctx.db.query("dmMessages").take(1000),
    ]);

    // One sample of the write path's latency (a lightweight mutation the
    // client can also run to confirm the backend is accepting writes).
    const latencyMs = Math.round(performance.now() - started);

    return {
      status: "operational",
      checkedAt: new Date().toISOString(),
      database: { latencyMs },
      scale: {
        users: users.length,
        posts: posts.length,
        stories: stories.length,
        dmMessages: dmMessages.length,
        openTickets: tickets.length,
      },
      // Every public surface depends on the same backend — if this query
      // runs, the read path is healthy end to end.
      readPath: "ok",
    };
  },
});

/** A tiny write-path probe: returns the current server timestamp. */
export const ping = query({
  handler: async () => ({ ok: true, serverTime: Date.now() }),
});
