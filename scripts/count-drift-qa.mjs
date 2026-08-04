#!/usr/bin/env node
/**
 * PureWire counter-drift QA (posts + follows).
 *
 * `users.postsCount`, `followersCount`, and `followingCount` are
 * denormalized counters: incremented on create/follow, decremented on
 * remove/unfollow. Past bugs let them drift — the user-facing deletePost
 * removed the row without decrementing postsCount, and follow rows
 * referencing deleted accounts (orphans) could survive account erasure
 * while counters diverged from the follows table.
 *
 * This QA runs the harness-gated `reconcilePostsCounts` and
 * `reconcileFollowCounts` mutations against production and FAILS if any
 * user's counter was drifted or any orphan follow row existed — each
 * mutation self-heals the derived state first (idempotent), then the
 * checks report exactly what changed so the gate surfaces the regression
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
  console.log(`\nPureWire counter-drift QA (posts + follows) (${CONVEX_URL})\n`);
  const client = new ConvexHttpClient(CONVEX_URL);
  const { enabled } = await client.query(api.testHarness.isEnabled);
  check("harness enabled", enabled === true);

  const { fixed, usersSeen } = await client.mutation(
    api.testHarness.reconcilePostsCounts,
    { secret: SECRET },
  );
  check("post reconciliation ran over the user table", usersSeen >= 0);
  check(
    "no user's postsCount drifted from their real posts",
    fixed.length === 0,
    fixed.length > 0
      ? `${fixed.length} fixed: ${fixed
          .map((f) => `user ${f.userId} ${f.was}→${f.now}`)
          .join(" | ")}`
      : `all ${usersSeen} users consistent`,
  );

  const {
    orphanFollows,
    followsSeen,
    fixed: followFixed,
    usersSeen: followUsersSeen,
  } = await client.mutation(api.testHarness.reconcileFollowCounts, {
    secret: SECRET,
  });
  check("follow reconciliation ran over the follows table", followsSeen >= 0);
  check(
    "no orphan follow rows (follows of deleted accounts)",
    orphanFollows.length === 0,
    orphanFollows.length > 0
      ? `${orphanFollows.length} swept: ${orphanFollows
          .map(
            (o) =>
              `row ${o.rowId} (${o.followerId}→${o.followingId}) pointed at a deleted account`,
          )
          .join(" | ")}`
      : `all ${followsSeen} follows reference live accounts`,
  );
  check(
    "no user's followersCount/followingCount drifted from the follows table",
    followFixed.length === 0,
    followFixed.length > 0
      ? `${followFixed.length} fixed: ${followFixed
          .map(
            (f) =>
              `user ${f.userId} followers ${f.wasFollowers}→${f.nowFollowers}, following ${f.wasFollowing}→${f.nowFollowing}`,
          )
          .join(" | ")}`
      : `all ${followUsersSeen} users consistent`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nCount-drift QA crashed:", e.message ?? e);
  process.exit(1);
});
