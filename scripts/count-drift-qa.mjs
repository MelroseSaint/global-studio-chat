#!/usr/bin/env node
/**
 * PureWire counter-drift QA (posts + follows + engagement).
 *
 * `users.postsCount`, `followersCount`, `followingCount` and
 * `posts.likeCount` / `commentCount` / `shareCount` / `reportCount` are
 * denormalized counters: incremented on create/follow/engage, decremented
 * on remove/unfollow/close. Past bugs let them drift — the user-facing
 * deletePost removed the row without decrementing postsCount, follow rows
 * referencing deleted accounts (orphans) could survive account erasure,
 * post deletions could leave orphan likes/comments/shares behind, and
 * erasing a reporter's account deleted their tickets without recomputing
 * the target posts' reportCount.
 *
 * This QA runs the harness-gated `reconcilePostsCounts`,
 * `reconcileFollowCounts`, and `reconcileEngagementCounts` mutations
 * against production and FAILS if any counter drifted or any orphan row
 * existed — each mutation self-heals the derived state first
 * (idempotent), then the checks report exactly what changed so the gate
 * surfaces the regression instead of silently absorbing it.
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
  console.log(
    `\nPureWire counter-drift QA (posts + follows + engagement + test traces) (${CONVEX_URL})\n`,
  );
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

  const {
    orphanLikes,
    orphanComments,
    orphanShares,
    likesSeen,
    commentsSeen,
    sharesSeen,
    fixed: engageFixed,
    postsSeen,
  } = await client.mutation(api.testHarness.reconcileEngagementCounts, {
    secret: SECRET,
  });
  check(
    "engagement reconciliation ran over the posts/likes/comments/shares tables",
    likesSeen >= 0 && commentsSeen >= 0 && sharesSeen >= 0,
  );
  check(
    "no orphan like rows (likes on deleted posts)",
    orphanLikes.length === 0,
    orphanLikes.length > 0
      ? `${orphanLikes.length} swept: ${orphanLikes
          .map((o) => `like ${o.rowId} on deleted post ${o.postId}`)
          .join(" | ")}`
      : `all ${likesSeen} likes reference live posts`,
  );
  check(
    "no orphan comment rows (comments on deleted posts)",
    orphanComments.length === 0,
    orphanComments.length > 0
      ? `${orphanComments.length} swept: ${orphanComments
          .map((o) => `comment ${o.rowId} on deleted post ${o.postId}`)
          .join(" | ")}`
      : `all ${commentsSeen} comments reference live posts`,
  );
  check(
    "no orphan share rows (shares on deleted posts)",
    orphanShares.length === 0,
    orphanShares.length > 0
      ? `${orphanShares.length} swept: ${orphanShares
          .map((o) => `share ${o.rowId} on deleted post ${o.postId}`)
          .join(" | ")}`
      : `all ${sharesSeen} shares reference live posts`,
  );
  check(
    "no post's like/comment/share/report counts drifted from the real tables",
    engageFixed.length === 0,
    engageFixed.length > 0
      ? `${engageFixed.length} fixed: ${engageFixed
          .map(
            (f) =>
              `post ${f.postId} ${JSON.stringify(f.was)}→${JSON.stringify(f.now)}`,
          )
          .join(" | ")}`
      : `all ${postsSeen} posts consistent`,
  );

  // Never keep test stuff on the site: reserved-prefix (qa_/pwtest) users
  // and removal-log entries must both be zero. A leftover test account or a
  // test erasure polluting the one-way audit log fails the gate.
  const traces = await client.query(api.testHarness.getTestTraceCounts, {
    secret: SECRET,
  });
  check(
    "no test users on the deployment",
    traces.testUsers.length === 0,
    traces.testUsers.length > 0 ? `found: ${traces.testUsers.join(", ")}` : "",
  );
  check(
    "no test entries in the removal log",
    traces.testRemovalEntries.length === 0,
    traces.testRemovalEntries.length > 0
      ? `found: ${traces.testRemovalEntries.join(", ")}`
      : "",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nCount-drift QA crashed:", e.message ?? e);
  process.exit(1);
});
