import { v } from "convex/values";

import {
  internalMutation,
  internalQuery,
} from "./_generated/server";

/**
 * Deploy-commit ledger for the drift-gated backend redeploy.
 *
 * The nightly `redeploy-drift.yml` job keeps the Vercel frontend pinned to
 * main HEAD by comparing the live deployment's githubCommitSha against
 * GITHUB_SHA — but Convex exposes no equivalent "what commit is deployed"
 * API to a deploy key. So the backend records its own: `migrations.yml`
 * runs `internal.deployStatus.recordDeploy` with GITHUB_SHA right after
 * `convex deploy` succeeds, and the drift job reads it back with
 * `internal.deployStatus.getDeployedSha` (via `npx convex run`, which a
 * deploy key is allowed to do). If the recorded SHA drifts from main HEAD —
 * a migrations deploy that silently failed, a dashboard redeploy of an
 * older commit, or a deploy that never happened — the drift job re-runs
 * `convex deploy` and re-records, so the backend can never silently lag
 * the repo.
 *
 * Single-row table (key "latest"), matching the sessionPrefs pattern:
 * the row is upserted, never appended, so the ledger stays one document.
 */
export const recordDeploy = internalMutation({
  args: { sha: v.string() },
  handler: async (ctx, { sha }) => {
    const existing = await ctx.db
      .query("deployStatus")
      .withIndex("by_key", (q) => q.eq("key", "latest"))
      .first();
    if (existing === null) {
      await ctx.db.insert("deployStatus", {
        key: "latest",
        sha,
        recordedAt: Date.now(),
      });
    } else {
      await ctx.db.patch(existing._id, { sha, recordedAt: Date.now() });
    }
  },
});

export const getDeployedSha = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("deployStatus")
      .withIndex("by_key", (q) => q.eq("key", "latest"))
      .first();
    return row?.sha ?? null;
  },
});
