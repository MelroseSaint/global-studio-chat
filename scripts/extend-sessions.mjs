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

  const result = await client.mutation(api.testHarness.extendSessionLifetimes, {
    secret: SECRET,
  });
  console.log(
    `Extended ${result.sessions} sessions and ${result.tokens} refresh tokens to the permanent horizon.`,
  );
  console.log(
    result.sessions === 0 && result.tokens === 0
      ? "Nothing needed extending — every session is already permanent."
      : "Done. Existing sessions no longer expire on a timeout.",
  );
}

main().catch((e) => {
  console.error("\nMigration run crashed:", e);
  process.exit(1);
});
