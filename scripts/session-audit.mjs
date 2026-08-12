#!/usr/bin/env node
/**
 * PureWire permanent-session CI audit.
 *
 * Calls the harness-gated `testHarness.auditSessionLifetimes` query and
 * fails (exit 1) if any authSessions or authRefreshTokens row expires
 * within the next year. That is the regression gate behind "a session ends
 * only when you choose to end it": if the `session` config in
 * convex/auth.ts is ever reverted to the library's 30-day default, or a
 * session escapes the migration, this check catches it on the next push
 * instead of on the next surprise logout.
 *
 * Deliberate exceptions never trip the gate:
 * - "Keep me signed in" opt-out sessions (sessionPrefs row) — a user's
 *   explicit choice of a 30-day session.
 * - QA-harness sessions minted for qa_ throwaway accounts, which use a
 *   short TTL by design and are deleted at the end of each QA run.
 *
 * Needs the QA harness enabled on the deployment (permanently, so the CI
 * gate can run on every push):
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *
 * and the same secret passed locally / in CI:
 *
 *   TEST_HARNESS_SECRET=<random> npm run qa:session-audit
 *
 * Overrides: CONVEX_URL (default: the production deployment).
 * Exit codes: 0 all sessions permanent, 1 violations found, 2 harness not
 * configured / secret missing.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SECRET = process.env.TEST_HARNESS_SECRET;
const client = new ConvexHttpClient(CONVEX_URL);

async function main() {
  console.log(`\nPureWire permanent-session audit — ${CONVEX_URL}\n`);

  if (!SECRET) {
    console.log(
      "TEST_HARNESS_SECRET is not set. Set it to the same value configured in the deployment env.",
    );
    process.exit(2);
  }

  const { enabled } = await client.query(api.testHarness.isEnabled);
  if (!enabled) {
    console.log("The QA harness is disabled on this deployment. Enable it:");
    console.log("  npx convex env set TEST_HARNESS_ENABLED 1");
    console.log("  npx convex env set TEST_HARNESS_SECRET <random>");
    console.log("Then re-run this script.");
    process.exit(2);
  }

  const report = await client.query(
    api.testHarness.auditSessionLifetimes,
    { secret: SECRET },
  );
  const horizonYears = report.horizonMs / (1000 * 60 * 60 * 24 * 365);

  console.log(
    `Scanned ${report.sessions} at-risk sessions and ${report.tokens} at-risk ` +
      `refresh tokens (rows expiring within ${horizonYears} year) — any ` +
      `non-exempt one is a violation.\n`,
  );

  if (report.violations.length === 0) {
    console.log(
      "  \u2705 No session or refresh token expires within a year — " +
        "the permanent-session guarantee holds.",
    );
    process.exit(0);
  }

  const shown = report.violations.length;
  console.log(
    `  \u274c ${shown} row(s) expire within a year — ` +
      "the permanent-session guarantee has regressed:",
  );
  for (const v of report.violations) {
    const days = Math.max(
      0,
      Math.round((v.expirationTime - report.checkedAt) / (1000 * 60 * 60 * 24)),
    );
    const who = v.userId ?? v.sessionId ?? "?";
    console.log(
      `     - ${v.table} ${v.id} (${who}) expires in ~${days} days ` +
        `(${new Date(v.expirationTime).toISOString()})`,
    );
  }
  if (report.truncated) {
    console.log(
      `     … and more (the report is capped at ${shown} rows — the sweep is failing at scale).`,
    );
  }
  console.log(
    "\nFix: restore the 10-year `session` config in convex/auth.ts and re-run",
    "`npm run qa:extend-sessions` to converge existing rows. Opt-out sessions",
    "(sessionPrefs) and qa_ harness sessions are deliberately exempt.",
  );
  process.exit(1);
}

main().catch((e) => {
  console.error("\nSession audit crashed:", e);
  process.exit(1);
});
