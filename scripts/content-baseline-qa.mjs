#!/usr/bin/env node
/**
 * Content-baseline canary — the catastrophic-wipe alarm.
 *
 * Invariant: production ALWAYS has at least one real user (the owner) and
 * at least one public post (the idempotent `npm run seed:posts` keeps the
 * floor stocked; the CI seed workflow re-runs it on demand). A production
 * database at zero posts is by definition a catastrophic content wipe —
 * the 2026-09-12 S1 (#129) was first visible as a sitemap with zero post
 * URLs; this guard turns that symptom into a hard, named CI failure.
 *
 * What it asserts (against the live deployment, via the admin dashboard):
 *   1. The owner/admin account still exists.
 *   2. `dashboardStats.users` is at least CONTENT_FLOOR_USERS (default 1).
 *   3. `dashboardStats.posts` is at least CONTENT_FLOOR_POSTS  (default 1).
 *   4. The public sitemap carries at least one /post/ URL (the crawlable
 *      surface the SEO guard and dynamic-render check depend on).
 *
 * Harness-gated (TEST_HARNESS_SECRET) like the other live QAs — the
 * dashboard queries are admin-gated. The sitemap check is plain HTTP.
 *
 * Run:
 *   TEST_HARNESS_SECRET=<secret> npm run qa:content-baseline
 *
 * Exit codes: 0 baseline holds, 1 baseline violated (S1-class alarm),
 * 2 missing secret / harness disabled.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://jovial-axolotl-209.convex.cloud";
const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const SECRET = process.env.TEST_HARNESS_SECRET;
const FLOOR_USERS = Number(process.env.CONTENT_FLOOR_USERS ?? 1);
const FLOOR_POSTS = Number(process.env.CONTENT_FLOOR_POSTS ?? 1);

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "🚨"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  if (!SECRET) {
    console.error(
      "TEST_HARNESS_SECRET is not set — the canary is harness-gated by design.",
    );
    process.exit(2);
  }
  console.log(`\nContent-baseline canary (${CONVEX_URL})\n`);

  const client = new ConvexHttpClient(CONVEX_URL);
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check("minted an admin session (owner account exists)", Boolean(admin?.token));
  if (!admin?.token) process.exit(1);
  client.setAuth(admin.token);

  const stats = await client.query(api.admin.dashboardStats);
  check(
    `user count ≥ ${FLOOR_USERS}`,
    stats.users >= FLOOR_USERS,
    `users: ${stats.users}`,
  );
  check(
    `post count ≥ ${FLOOR_POSTS}`,
    stats.posts >= FLOOR_POSTS,
    `posts: ${stats.posts}` +
      (stats.posts === 0
        ? " — CATASTROPHIC CONTENT WIPE; restore per docs/backup-restore.md, then reseed with npm run seed:posts"
        : ""),
  );
  check(
    `comment count consistent with posts (0 posts ⇒ 0 comments)`,
    stats.posts > 0 ? true : stats.comments === 0,
    `comments: ${stats.comments}`,
  );

  // Zero-test-posts invariant (the "always delete any test posts" rule):
  // the baseline canary doubles as the last line of defense against test
  // content surviving on production. Any post or comment authored by a
  // QA test account means the cleanup sweep failed somewhere — visible
  // here even if the sweep job itself was skipped.
  const leftovers = await client.query(api.testHarness.countTestAuthorPosts, {
    secret: SECRET,
  });
  check(
    `zero test posts/comments (test content is always deleted)`,
    leftovers.posts === 0 && leftovers.comments === 0,
    `${leftovers.posts} test post(s), ${leftovers.comments} test comment(s)` +
      (leftovers.posts + leftovers.comments > 0
        ? ` owned by ${leftovers.testAuthors} test author(s) — run npm run qa:cleanup-test-users`
        : ""),
  );

  // The crawlable surface: the sitemap must carry the seeded posts.
  const res = await fetch(`${SITE_URL}/sitemap.xml`, {
    headers: { "Cache-Control": "no-cache" },
  });
  check("sitemap is reachable (HTTP 200)", res.status === 200, `HTTP ${res.status}`);
  const xml = await res.text();
  const postUrls = (xml.match(/\/post\//g) ?? []).length;
  check(
    `sitemap carries ≥ 1 post URL`,
    postUrls >= 1,
    `post URLs: ${postUrls}` +
      (postUrls === 0 ? " (seed with npm run seed:posts, then re-run)" : ""),
  );

  console.log(`\n${failed === 0 ? "baseline holds" : failed + " baseline check(s) FAILED"}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("canary crashed:", err.message);
  process.exit(2);
});
