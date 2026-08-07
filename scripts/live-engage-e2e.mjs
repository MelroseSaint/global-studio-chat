#!/usr/bin/env node
/**
 * Live follow + like end-to-end check against the production deployment.
 *
 * Proves the denormalized counters stay truthful end-to-end: a second
 * account (harness-minted under the reserved qa_ prefix — a real session
 * driving the exact same `users.follow` / `posts.likePost` mutations the
 * UI calls) follows the admin and likes the admin's post. Then asserts:
 *
 *   1. the admin's followersCount and the post's likeCount actually
 *      incremented (read back through the live API),
 *   2. the count-drift gates (reconcileFollowCounts + reconcileEngagement
 *      Counts) report ZERO drift — counters exactly match the follows /
 *      likes tables,
 *   3. after `cleanup` (full admin removeAccount sweep) every counter
 *      returns to baseline and the gates are still clean — proving erasure
 *      recomputes counts instead of leaving stale numbers.
 *
 * Run (harness-gated, like the other production QAs):
 *
 *   TEST_HARNESS_SECRET=<secret> node scripts/live-engage-e2e.mjs setup
 *   … watch the counters in the browser …
 *   TEST_HARNESS_SECRET=<secret> node scripts/live-engage-e2e.mjs cleanup
 *
 * Overrides: CONVEX_URL, ADMIN_USERNAME (default adminmelrose).
 * Exit codes: 0 all assertions passed, 1 any failed.
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { assertAdminIpVerified } from "./lib/qa-admin-ip.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "adminmelrose";
const SEED_FILE = join(
  import.meta.dirname,
  "..",
  "..",
  ".freebuff",
  ".live-engage.json",
);

const SECRET = process.env.TEST_HARNESS_SECRET;
if (!SECRET) {
  console.error("TEST_HARNESS_SECRET is not set — cannot use the QA harness.");
  process.exit(1);
}

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

async function mintAdmin() {
  const client = new ConvexHttpClient(CONVEX_URL);
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  const adminClient = new ConvexHttpClient(CONVEX_URL);
  adminClient.setAuth(admin.token);
  // Backend-verified device gate: bind the minted admin session to the
  // backend-observed IP or admin-gated calls are refused.
  await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: admin.token });
  return { admin, adminClient };
}

/** Assert the drift gates report zero drift right now. */
async function assertNoDrift(label) {
  const client = new ConvexHttpClient(CONVEX_URL);
  const { fixed: followFixed, orphanFollows } = await client.mutation(
    api.testHarness.reconcileFollowCounts,
    { secret: SECRET },
  );
  check(
    `${label}: follows tables consistent (no drift, no orphans)`,
    followFixed.length === 0 && orphanFollows.length === 0,
    followFixed.length > 0
      ? `followers drift: ${JSON.stringify(followFixed)}`
      : orphanFollows.length > 0
        ? `orphan follows: ${JSON.stringify(orphanFollows)}`
        : "",
  );
  const {
    fixed: engageFixed,
    orphanLikes,
    orphanComments,
    orphanShares,
  } = await client.mutation(api.testHarness.reconcileEngagementCounts, {
    secret: SECRET,
  });
  check(
    `${label}: engagement tables consistent (no drift, no orphans)`,
    engageFixed.length === 0 &&
      orphanLikes.length === 0 &&
      orphanComments.length === 0 &&
      orphanShares.length === 0,
    engageFixed.length > 0
      ? `post drift: ${JSON.stringify(engageFixed)}`
      : orphanLikes.length + orphanComments.length + orphanShares.length > 0
        ? `orphan engagement: ${orphanLikes.length} likes, ${orphanComments.length} comments, ${orphanShares.length} shares`
        : "",
  );
}

async function setup() {
  const client = new ConvexHttpClient(CONVEX_URL);
  console.log(`\nLive follow+like E2E — setup (${CONVEX_URL})\n`);

  // 1. Create the second account (real session, qa_ prefix enforced).
  const ts = Date.now().toString(36).slice(-8);
  const username = `qa_flow${ts}`;
  const created = await client.mutation(api.testHarness.createTestUser, {
    name: "Flow Test",
    username,
    secret: SECRET,
  });
  check("second account created with a real session", !!created.token);
  const userClient = new ConvexHttpClient(CONVEX_URL);
  userClient.setAuth(created.token);

  // 2. Resolve the admin's post id (admin client sees everything).
  const { admin, adminClient } = await mintAdmin();
  const posts = await adminClient.query(api.posts.listUserPosts, {
    userId: admin.userId,
    paginationOpts: { numItems: 50, cursor: null },
  });
  const post = posts.page[0];
  check(
    `admin has a public post to like (${post?._id ?? "none"})`,
    post !== undefined,
  );

  // 3. The second account follows the admin and likes the post — the same
  //    mutations the Follow and Heart buttons call.
  await userClient.mutation(api.users.follow, { username: ADMIN_USERNAME });
  await userClient.mutation(api.posts.likePost, { postId: post._id });
  console.log(`  @${username} followed @${ADMIN_USERNAME} and liked post ${post._id}`);

  // 4. Read the counters back through the live API.
  const profile = await adminClient.query(api.users.getProfile, {
    username: ADMIN_USERNAME,
  });
  check(
    `admin followersCount incremented 0 → ${profile?.followersCount}`,
    (profile?.followersCount ?? 0) === 1,
    `actual ${profile?.followersCount}`,
  );
  const postNow = await adminClient.query(api.posts.getPost, { postId: post._id });
  check(
    `post likeCount incremented 0 → ${postNow?.likeCount}`,
    (postNow?.likeCount ?? 0) === 1,
    `actual ${postNow?.likeCount}`,
  );

  // 5. The gates agree: counters exactly match the follows/likes tables.
  await assertNoDrift("after follow+like");

  writeFileSync(
    SEED_FILE,
    JSON.stringify(
      { userId: created.userId, username, postId: post._id },
      null,
      2,
    ),
  );
  console.log(`Identity saved to ${SEED_FILE} for the cleanup run.`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

async function cleanup() {
  const client = new ConvexHttpClient(CONVEX_URL);
  console.log(`\nLive follow+like E2E — cleanup (${CONVEX_URL})\n`);

  let state;
  try {
    state = JSON.parse(readFileSync(SEED_FILE, "utf8"));
  } catch {
    console.error(`No seed file at ${SEED_FILE} — cannot identify the test user.`);
    process.exit(1);
  }

  // 1. Erase the second account with the full admin sweep (posts, follows,
  //    likes, auth sessions, notifications — everything), citing a Standard
  //    principle like the real remove-account dialog does.
  const { adminClient } = await mintAdmin();
  await adminClient.mutation(api.admin.removeAccount, {
    userId: state.userId,
    standardId: "no-spam",
    note: "Live follow+like E2E cleanup.",
  });
  check(`@${state.username} removed with the full sweep`, true);

  // 2. Baseline restored: counters return to 0, tables empty of the rows.
  const profile = await adminClient.query(api.users.getProfile, {
    username: ADMIN_USERNAME,
  });
  check(
    "admin followersCount back to 0 after erasure",
    (profile?.followersCount ?? 0) === 0,
    `actual ${profile?.followersCount}`,
  );
  const postNow = await adminClient.query(api.posts.getPost, {
    postId: state.postId,
  });
  check(
    "post likeCount back to 0 after erasure",
    (postNow?.likeCount ?? 0) === 0,
    `actual ${postNow?.likeCount}`,
  );

  // 3. And the gates still agree — erasure recomputed, not left stale.
  await assertNoDrift("after erasure");

  rmSync(SEED_FILE, { force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

const mode = process.argv[2] ?? "setup";
if (mode === "setup") {
  await setup();
} else if (mode === "cleanup") {
  await cleanup();
} else {
  console.error(`Unknown mode: ${mode} (expected "setup" or "cleanup")`);
  process.exit(1);
}
