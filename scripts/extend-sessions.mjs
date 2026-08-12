#!/usr/bin/env node
/**
 * PureWire permanent-session migration.
 *
 * One-time migration that pushes every existing auth session and refresh
 * token out to the permanent 10-year horizon, so accounts that were signed
 * in before the `session` config in convex/auth.ts took effect don't hit
 * the library's old 30-day cap and get logged out automatically.
 *
 * Idempotent — rows already beyond the horizon are left untouched, so
 * re-running is harmless.
 *
 * Uses the same harness gates as the other QA scripts (a script can't sign
 * in through the UI), so to run:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/extend-sessions.mjs
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Overrides: CONVEX_URL (default: the production deployment), TEST_HARNESS_SECRET.
 * Exit codes: 0 all done, 2 harness disabled / secret missing.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SECRET = process.env.TEST_HARNESS_SECRET;
const client = new ConvexHttpClient(CONVEX_URL);

async function main() {
  console.log(`\nPureWire session-lifetime migration — ${CONVEX_URL}\n`);

  if (!SECRET) {
    console.log(
      "TEST_HARNESS_SECRET is not set. Set it locally to the same value you set in the deployment env.",
    );
    process.exit(2);
  }

  const { enabled } = await client.query(api.testHarness.isEnabled);
  if (!enabled) {
    console.log("The QA harness is disabled on this deployment. Enable it:");
    console.log("  npx convex env set TEST_HARNESS_ENABLED 1");
    console.log("  npx convex env set TEST_HARNESS_SECRET <random>");
    console.log("Then re-run this script, and remove both env vars afterwards.");
    process.exit(2);
  }

  // The mutation extends a bounded batch per call (a single mutation may
  // read at most 4096 docs, and each extension is a read + a write), so
  // loop until a call reports the tables converged. The horizon is
  // computed ONCE and passed to every pass — a fresh Date.now() per call
  // would move the target a few ms forward each time and re-find every
  // row it just patched (infinite loop). Each pass is otherwise
  // independent and idempotent — rows already at the horizon are skipped.
  const horizonMs = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10;
  let totalSessions = 0;
  let totalTokens = 0;
  let totalPrefs = 0;
  for (let pass = 1; pass <= 200; pass++) {
    const result = await client.mutation(
      api.testHarness.extendSessionLifetimes,
      { secret: SECRET, horizonMs },
    );
    totalSessions += result.sessions;
    totalTokens += result.tokens;
    totalPrefs += result.prefs;
    process.stdout.write(
      `  pass ${pass}: +${result.sessions} sessions, +${result.tokens} tokens` +
        (result.prefs > 0 ? `, +${result.prefs} prefs` : "") + "\r",
    );
    if (result.done) break;
    // Small pause so a runaway loop can't hammer the deployment.
    await new Promise((r) => setTimeout(r, 50));
  }
  process.stdout.write("\n");
  console.log(
    `Extended ${totalSessions} sessions and ${totalTokens} refresh tokens to the permanent horizon.`,
  );
  if (totalPrefs > 0) {
    console.log(`Swept ${totalPrefs} orphaned session preference rows.`);
  }
  console.log(
    totalSessions === 0 && totalTokens === 0
      ? "Nothing needed extending — every session is already permanent."
      : "Done. Existing sessions no longer expire on a timeout.",
  );
}

main().catch((e) => {
  console.error("\nMigration run crashed:", e);
  process.exit(1);
});
