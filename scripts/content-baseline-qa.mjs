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
 *   3. `dashboardStats.posts` is at least CONTENT_FLOOR_POSTS.
 *   4. The public sitemap carries at least one /post/ URL.
 *
 * POST FLOOR: the owner removed the automation-seeded admin posts
 * (2026-09-12) and runs the site with an intentionally EMPTY feed — the
 * only posts on production are the ones the owner publishes themselves.
 * The floor therefore defaults to 0 and the sitemap post check is a
 * pass-with-warning at 0. Operators who WANT a seeded floor can set
 * CONTENT_FLOOR_POSTS=1 (+ CONTENT_SITEMAP_POSTS=1) in the environment —
 * at ≥1 a zero becomes the S1-class alarm again. Never re-seed production
 * by script: the owner deleted the seed workflow for exactly that reason.
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
// The owner runs production with an intentionally empty feed (the seeded
// posts were removed on purpose). A zero is normal today; operators can
// raise the floor to re-arm the S1-class wipe alarm.
const FLOOR_POSTS = Number(process.env.CONTENT_FLOOR_POSTS ?? 0);
// Same for the crawlable surface: warn-only at 0 by default, alarm at ≥1.
const SITEMAP_POST_FLOOR = Number(process.env.CONTENT_SITEMAP_POSTS ?? 0);

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
        ? FLOOR_POSTS > 0
          ? " — CATASTROPHIC CONTENT WIPE; restore per docs/backup-restore.md"
          : " (empty feed is the owner's chosen baseline; set CONTENT_FLOOR_POSTS=1 to re-arm the wipe alarm)"
        : ""),
  );
  check(
    `comment count consistent with posts (0 posts ⇒ 0 comments)`,
    stats.posts > 0 ? true : stats.comments === 0,
    `comments: ${stats.comments}`,
  );

  // The zero-test-posts invariant ("always delete any test posts") is
  // NOT asserted here: the canary runs in parallel with the QAs that
  // create qa_* fixtures, so a clean run would race live test content
  // (observed 2026-09-12: 6 in-flight posts flagged mid-run). The sweep
  // job enforces it after all peers settle — with always() so it still
  // runs when a peer fails — and opens an alert issue if anything leaked.

  // The crawlable surface: the sitemap must carry the seeded posts.
  const res = await fetch(`${SITE_URL}/sitemap.xml`, {
    headers: { "Cache-Control": "no-cache" },
  });
  check("sitemap is reachable (HTTP 200)", res.status === 200, `HTTP ${res.status}`);
  const xml = await res.text();
  const postUrls = (xml.match(/\/post\//g) ?? []).length;
  const postFloorOk = postUrls >= SITEMAP_POST_FLOOR;
  check(
    `sitemap carries ≥ ${SITEMAP_POST_FLOOR} post URL(s)`,
    postFloorOk,
    `post URLs: ${postUrls}` +
      (postUrls === 0
        ? SITEMAP_POST_FLOOR > 0
          ? " (floor raised by operator — sitemap must carry posts again)"
          : " (no public posts — fine while the feed is intentionally empty)"
        : ""),
  );

  console.log(`\n${failed === 0 ? "baseline holds" : failed + " baseline check(s) FAILED"}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("canary crashed:", err.message);
  process.exit(2);
});
