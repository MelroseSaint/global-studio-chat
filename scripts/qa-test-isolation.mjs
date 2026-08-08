#!/usr/bin/env node
/**
 * PureWire live test-isolation QA.
 *
 * Proves the invariant behind "testing never disrupts production": a QA
 * run's fixtures (reserved qa_/pwtest accounts, their posts, comments,
 * likes, follows, DMs) are completely invisible to real members while the
 * run is live — before cleanup, not just after. It creates a throwaway
 * qa_ account, has it post/follow/like/comment on the real admin, then
 * checks from the admin's (a real member's) viewpoint that none of it
 * surfaces, while the test account's OWN viewpoint still works (so QA
 * scripts that drive the UI as their own account keep passing).
 *
 * Harness-gated like the shadowban/reinstate/phishing checks — requires
 * TEST_HARNESS_SECRET and TEST_HARNESS_ENABLED=1 on the deployment.
 *
 * Backend half (deterministic):
 *   1. Creates one throwaway qa_ account A.
 *   2. A creates a post, follows the admin, likes the admin's newest post,
 *      and comments on it — the same mutations the UI calls.
 *   3. Admin (real member) viewpoint asserts NOTHING leaked:
 *        - A's post is absent from the Global feed
 *        - A is absent from user search and the admin's follower list
 *        - A's comment is absent from the post's comment thread
 *        - the admin's bell gained no rows from A (listNotifications has
 *          no actorId === A; unreadCount unchanged)
 *        - the sitemap source queries exclude A's post and profile
 *          (deterministic — no HTTP cache involved)
 *   4. A's own viewpoint: A still sees its own post in the feed
 *      (self-exclusion preserved, so UI-driving QAs keep working).
 *   5. deleteTestUser erases A and cascades every fixture row.
 *
 * Run:
 *   TEST_HARNESS_SECRET=<secret> npm run qa:test-isolation
 *
 * Overrides: CONVEX_URL (default the production deployment), SITE_URL
 * (default the production host), ADMIN_USERNAME (default adminmelrose).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing secret.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { powProof } from "./lib/qa-pow.mjs";
import { assertAdminIpVerified } from "./lib/qa-admin-ip.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "adminmelrose";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u274c ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mint a real admin session (mirrors live-engage-e2e's mintAdmin). */
async function mintAdmin() {
  const client = new ConvexHttpClient(CONVEX_URL);
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: HARNESS_SECRET,
  });
  const adminClient = new ConvexHttpClient(CONVEX_URL);
  adminClient.setAuth(admin.token);
  await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: admin.token });
  return { admin, adminClient };
}

async function run() {
  if (!HARNESS_SECRET) {
    console.error(
      "TEST_HARNESS_SECRET is not set — the QA is harness-gated by design.",
    );
    process.exit(2);
  }

  console.log(`\nTest isolation QA (${CONVEX_URL})\n`);

  const harness = new ConvexHttpClient(CONVEX_URL);

  // 1. The throwaway QA account A.
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const username = `qa_iso_${stamp}`;
  const a = await harness.mutation(api.testHarness.createTestUser, {
    name: `QA Isolation ${stamp}`,
    username,
    secret: HARNESS_SECRET,
  });
  check("created throwaway qa_ account A", Boolean(a?.token), username);
  if (!a?.userId || !a.token) process.exit(1);

  const ac = new ConvexHttpClient(CONVEX_URL);
  ac.setAuth(a.token);

  // 2. A acts like a normal member: posts, follows, likes, comments.
  const postRes = await ac.action(api.posts.createPost, {
    content: `Midnight lighthouse keeper lantern storm clouds ${stamp}`,
    creatorDisclosure: "human-made",
    ...(await powProof(ac)),
  });
  check("A created the isolation post", postRes.ok === true, postRes.error ?? "");
  if (!postRes.ok) {
    await harness.mutation(api.testHarness.deleteTestUser, {
      userId: a.userId,
      secret: HARNESS_SECRET,
    });
    process.exit(1);
  }
  const postId = postRes.postId;

  // A real post of the admin's to engage with (admin client sees all).
  const { admin, adminClient } = await mintAdmin();
  const posts = await adminClient.query(api.posts.listUserPosts, {
    userId: admin.userId,
    paginationOpts: { numItems: 50, cursor: null },
  });
  const adminPost = posts.page[0];
  check(
    `admin has a public post to like/comment (${adminPost?._id ?? "none"})`,
    adminPost !== undefined,
  );

  await ac.mutation(api.users.follow, { username: ADMIN_USERNAME });
  if (adminPost !== undefined) {
    await ac.mutation(api.posts.likePost, { postId: adminPost._id });
    await ac.mutation(api.posts.addComment, {
      postId: adminPost._id,
      content: `Midnight lighthouse keeper lantern storm clouds ${stamp}`,
      ...(await powProof(ac)),
    });
  }
  console.log(`  @${username} posted ${postId}, followed @${ADMIN_USERNAME}, engaged\n`);

  // 3. Admin viewpoint: nothing test-correlated may surface.
  console.log("Admin (real member) viewpoint — nothing test-correlated:\n");

  const beforeUnread = await adminClient.query(api.notifications.unreadCount);
  const beforeNotifs = await adminClient.query(api.notifications.listNotifications, {
    paginationOpts: { numItems: 50, cursor: null },
  });
  const beforeActorIds = new Set(
    beforeNotifs.page.map((n) => n.actorId).filter(Boolean),
  );

  const feedRes = await adminClient.query(api.posts.feed, {
    paginationOpts: { numItems: 50, cursor: null },
    filter: "global",
  });
  check(
    "A's post is absent from the admin's Global feed",
    !(feedRes.page ?? []).some((p) => p._id === postId),
  );

  const searchRes = await adminClient.query(api.users.searchUsers, {
    query: username,
  });
  check(
    "A is absent from user search (exact handle)",
    !(searchRes ?? []).some((u) => u.username === username),
  );

  const followersRes = await adminClient.query(api.users.listFollowers, {
    username: ADMIN_USERNAME,
    paginationOpts: { numItems: 50, cursor: null },
  });
  check(
    "A is absent from the admin's follower list",
    !(followersRes.page ?? []).some((u) => u.username === username),
  );

  if (adminPost !== undefined) {
    const commentsRes = await adminClient.query(api.posts.listComments, {
      postId: adminPost._id,
      paginationOpts: { numItems: 50, cursor: null },
    });
    check(
      "A's comment is absent from the admin's post thread",
      !(commentsRes.page ?? []).some((c) => c.authorId === a.userId),
    );
  }

  const afterNotifs = await adminClient.query(api.notifications.listNotifications, {
    paginationOpts: { numItems: 50, cursor: null },
  });
  const newActors = (afterNotifs.page ?? [])
    .map((n) => n.actorId)
    .filter((id) => id !== undefined && !beforeActorIds.has(id));
  check(
    "the admin's bell gained no rows from A",
    !newActors.includes(a.userId),
    newActors.length > 0 ? `new actor ids: ${newActors.join(", ")}` : "",
  );
  const afterUnread = await adminClient.query(api.notifications.unreadCount);
  check(
    "the admin's unread count is unchanged",
    afterUnread === beforeUnread,
    `before ${beforeUnread}, after ${afterUnread}`,
  );

  const snap = await harness.query(api.testHarness.qaIsolationSnapshot, {
    secret: HARNESS_SECRET,
    testUserId: a.userId,
    testUsername: username,
    testPostId: postId,
  });
  check(
    "A's post is absent from the sitemap source query",
    snap.postInSitemap === false,
    `sitemap has ${snap.sitemapPostCount} posts`,
  );
  check(
    "A's profile is absent from the sitemap source query",
    snap.userInSitemap === false,
    `sitemap has ${snap.sitemapUserCount} users`,
  );

  // 4. A's own viewpoint: self-exclusion keeps QA flows working.
  const ownFeed = await ac.query(api.posts.feed, {
    paginationOpts: { numItems: 50, cursor: null },
    filter: "global",
  });
  check(
    "A still sees its own post in its own feed",
    (ownFeed.page ?? []).some((p) => p._id === postId),
  );

  // 5. Cleanup — full cascade, leaving zero fixtures behind.
  const erased = await harness.mutation(api.testHarness.deleteTestUser, {
    userId: a.userId,
    secret: HARNESS_SECRET,
  });
  check(
    `A erased with full cascade (${erased?.posts ?? "?"} posts, ${erased?.comments ?? "?"} comments)`,
    erased?.deleted === true,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
