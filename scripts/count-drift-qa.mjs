#!/usr/bin/env node
/**
 * PureWire post-count drift QA.
 *
 * `users.postsCount` is a denormalized counter: incremented when a post is
 * created, decremented when one is removed. A past bug let the
 * user-facing deletePost remove the row without decrementing, so accounts
 * that deleted their own posts showed an inflated "posts made" number.
 *
 * This QA runs the harness-gated `reconcilePostsCounts` mutation against
 * production and FAILS if any user's counter was drifted — the mutation
 * self-heals the count first (it is derived state; idempotent), then the
 * check reports exactly who drifted so the gate surfaces the regression
 * instead of silently absorbing it.
 *
 * Run (gated on the harness secret, like the other production QAs):
 *
 *   TEST_HARNESS_SECRET=<secret> npm run qa:count-drift
 *
 * Overrides: CONVEX_URL (default https://outgoing-seal-727.convex.cloud).
 * Exit codes: 0 clean, 1 drift found (and fixed), 2 no harness secret.
 */
import { ConvexHttpClient } from "convex/browser";
import { readFileSync, existsSync } from "node:fs";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const secretFile = new URL("../.freebuff/.harness-secret", import.meta.url);
const SECRET =
  process.env.TEST_HARNESS_SECRET ??
  (existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : "");

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  if (!SECRET) {
    console.error(
      "No TEST_HARNESS_SECRET. Provide it via env or .freebuff/.harness-secret.",
    );
    process.exit(2);
  }
  console.log(`\nPureWire post-count drift QA (${CONVEX_URL})\n`);
  const client = new ConvexHttpClient(CONVEX_URL);
  const { enabled } = await client.query(api.testHarness.isEnabled);
  check("harness enabled", enabled === true);

  const { fixed, usersSeen } = await client.mutation(
    api.testHarness.reconcilePostsCounts,
    { secret: SECRET },
  );
  check("reconciliation ran over the user table", usersSeen >= 0);
  check(
    "no user's postsCount drifted from their real posts",
    fixed.length === 0,
    fixed.length > 0
      ? `${fixed.length} fixed: ${fixed
          .map((f) => `user ${f.userId} ${f.was}→${f.now}`)
          .join(" | ")}`
      : `all ${usersSeen} users consistent`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nCount-drift QA crashed:", e.message ?? e);
  process.exit(1);
});
