import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import {
  internalMutation,
  type MutationCtx,
} from "./_generated/server";

/**
 * Migrations runner for the nightly CI job.
 *
 * The nightly `migrations.yml` workflow calls ONE function —
 * `internal.migrationsRunner.runAllMigrations` — which runs every
 * registered migration in order and returns an aggregate report. New
 * backfills never require touching the workflow: add the migration to the
 * `steps` list below and it runs on the next push/nightly cycle.
 *
 * Lives in its own module (not migrations.ts) because a Convex function
 * may not call an internal function defined in the same file — the
 * generated types recurse (the same split mediaCleanup.ts documents).
 *
 * Safety contract for migrations run here:
 * - Each step MUST be idempotent — it runs on every push to `main` and
 *   every night, so re-running must be a no-op on already-migrated rows.
 * - Steps run in registration order, but are treated as independent: a
 *   failure in one is reported and the rest still run, so an isolated
 *   problem never blocks unrelated backfills.
 */
export const runAllMigrations = internalMutation({
  args: {
    // Optional: run only a named migration. Handy when a step needs a
    // re-run outside the nightly cadence without running everything.
    only: v.optional(v.string()),
  },
  handler: async (ctx, { only }) => {
    const steps: Array<{
      name: string;
      run: (c: MutationCtx) => Promise<unknown>;
    }> = [
      {
        name: "rehashEmailHashes",
        run: (c) => c.runMutation(internal.migrations.rehashEmailHashes),
      },
      {
        name: "backfillRemovalLog",
        run: (c) => c.runMutation(internal.migrations.backfillRemovalLog),
      },
      {
        name: "backfillCommentLikeCounts",
        run: (c) => c.runMutation(internal.migrations.backfillCommentLikeCounts),
      },
    ];

    const results: Record<string, unknown> = {};
    const failures: Array<{ name: string; error: string }> = [];

    for (const step of steps) {
      if (only !== undefined && step.name !== only) {
        continue;
      }
      try {
        const result = await step.run(ctx);
        results[step.name] = {
          ok: true,
          ...(result as Record<string, unknown>),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[step.name] = { ok: false, error: message };
        failures.push({ name: step.name, error: message });
      }
    }

    if (failures.length > 0) {
      // ConvexError so the message survives the CLI boundary (a plain
      // Error shows up as a masked "Server Error" in the workflow log).
      throw new ConvexError(
        `Migration(s) failed: ${failures
          .map((f) => `${f.name} → ${f.error}`)
          .join("; ")}`,
      );
    }

    return { ok: true, results };
  },
});
