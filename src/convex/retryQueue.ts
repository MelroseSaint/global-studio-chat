import { v } from "convex/values";

import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requireAdmin } from "./admin";

import type { Doc } from "./_generated/dataModel";

type JobDoc = Doc<"jobRetries">;

const MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = 60_000; // 1 minute between retries.
const PRUNE_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000; // Keep dead letters 7 days.

/**
 * Dead-letter queue for external jobs that fail — Resemble v2 detection,
 * OCR, C2PA verification, link previews, Cloudinary cleanups. When an
 * external call times out or loses connectivity, the job is filed here
 * instead of stalling (or silently dropping) the pipeline, and the retry
 * sweep picks it up later. After MAX_ATTEMPTS it becomes a dead letter an
 * admin can inspect — never silently lost, never stuck forever.
 */

/** Record a failed job for later retry. Returns the row id. */
export async function enqueueRetry(
  ctx: MutationCtx,
  jobType: string,
  payload: unknown,
  errorMessage: string,
): Promise<JobDoc["_id"]> {
  return ctx.db.insert("jobRetries", {
    jobType,
    payload: payload as never,
    attempts: 0,
    lastError: errorMessage,
    nextRetryAt: Date.now() + RETRY_BACKOFF_MS,
    dead: false,
  });
}

/** Internal: insert a failed job (actions call this via runMutation). */
export const enqueueInternal = internalMutation({
  args: {
    jobType: v.string(),
    payload: v.any(),
    lastError: v.string(),
  },
  handler: async (ctx, { jobType, payload, lastError }) => {
    await ctx.db.insert("jobRetries", {
      jobType,
      payload,
      attempts: 0,
      lastError,
      nextRetryAt: Date.now() + RETRY_BACKOFF_MS,
      dead: false,
    });
  },
});

/**
 * Retry sweep: run by a scheduled job (or the health check). For every due
 * row it increments `attempts`; once a job has exhausted its retry budget
 * it is marked dead (a dead letter an admin can inspect) instead of being
 * retried forever. Also prunes dead letters past the retention window so
 * the table never grows without bound.
 *
 * Re-running the actual job is job-specific — the sweep advances the
 * lifecycle; each job type's caller (e.g. the media scanner) re-invokes
 * its work when it sees the due rows. This keeps the queue generic.
 */
export const retrySweep = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();
    // nextRetryAt is optional — index-range queries can't express that
    // directly, so filter over the by_dead index instead (dead rows are
    // the stable slice; pending rows are few).
    const due = await ctx.db
      .query("jobRetries")
      .withIndex("by_dead", (q) => q.eq("dead", false))
      .filter((q) => q.lte(q.field("nextRetryAt") ?? 0, now))
      .take(50);
    let retried = 0;
    let dead = 0;
    for (const job of due) {
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // Retry budget exhausted — a permanent dead letter, surfaced to
        // the admin queue instead of silently lost.
        await ctx.db.patch(job._id, {
          attempts,
          dead: true,
          nextRetryAt: undefined,
        });
        dead++;
      } else {
        // Eligible again: bump the attempt counter and schedule the next
        // window. The caller re-invokes the real work on its next pass.
        await ctx.db.patch(job._id, {
          attempts,
          nextRetryAt: now + RETRY_BACKOFF_MS,
        });
        retried++;
      }
    }
    // Prune dead letters past the retention window so the table never grows
    // without bound.
    const oldDead = await ctx.db
      .query("jobRetries")
      .withIndex("by_dead", (q) => q.eq("dead", true))
      .filter((q) => q.lte(q.field("_creationTime"), now - PRUNE_OLDER_THAN_MS))
      .take(200);
    for (const d of oldDead) {
      await ctx.db.delete(d._id);
    }
    return { due: due.length, retried, dead, pruned: oldDead.length };
  },
});

/** Mark a job as dead after its retry budget is exhausted. */
export async function markDead(
  ctx: MutationCtx,
  jobId: JobDoc["_id"],
): Promise<void> {
  await ctx.db.patch(jobId, {
    dead: true,
    nextRetryAt: undefined,
  });
}

/** Admin: inspect the current queue (dead + pending). */
export const listJobs = query({
  handler: async (ctx) => {
    // Strictly admin-gated — the payloads hold Convex storage IDs of
    // failed-media jobs, which must never be enumerable by any caller.
    await requireAdmin(ctx);
    const rows = await ctx.db.query("jobRetries").order("desc").take(100);
    return rows.map((r) => ({
      ...r,
      payload: r.payload,
    }));
  },
});

/** Admin: clear a dead letter (or a resolved job) from the queue. */
export const removeJob = mutation({
  args: { jobId: v.id("jobRetries") },
  handler: async (ctx, { jobId }) => {
    await requireAdmin(ctx);
    await ctx.db.delete(jobId);
  },
});
