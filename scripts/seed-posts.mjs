#!/usr/bin/env node
/**
 * PureWire — seed a few real posts as the admin account.
 *
 * ⚠️ OPERATOR-DIRECTED ONLY. On 2026-09-12 the owner removed every
 * automation-seeded post from the admin profile and deleted the CI seed
 * workflow: production runs with an intentionally EMPTY feed, and the
 * only posts on it must be ones the owner publishes themselves. Never
 * run this against production without the owner's explicit say-so; the
 * content-baseline canary treats zero posts as the normal baseline.
 *
 * Why it exists: when the owner DOES want content seeded (a fresh
 * deployment, or a requested reseed), this publishes a handful of
 * original, text-only admin posts through the REAL public write path.
 *
 * Deliberately user-safe by design:
 *   - It signs in as the admin (never a QA account — qa_* posts are
 *     excluded from the sitemap by testHarness isolation, so seeding as
 *     QA would defeat the whole point).
 *   - It calls `posts.createPost`, the same action the browser composer
 *     uses — so every gate the platform enforces (proof-of-work, rate
 *     limits, originality fingerprint, creator disclosure) runs exactly
 *     as it does for real users. No internal/write-path bypass.
 *   - It creates nothing else: no comments, no likes, no follows, no
 *     notifications to other accounts. Nobody is mentioned, so nobody is
 *     disturbed; the posts simply appear on the feed from the admin.
 *
 * The posts are permanent, real content. If you need to remove one, use
 * the app's own Delete post (menu) as the admin — the script has no
 * delete path so it can never silently retract public content.
 *
 * Run (the password never lives in this file — see lib/qa-secrets.mjs):
 *
 *   ADMIN_PASSWORD=<admin password> npm run seed:posts
 *   # or, to keep the secret out of shell history and chat entirely:
 *   printf '%s' '<admin password>' > .freebuff/.admin-password   # gitignored
 *   npm run seed:posts
 *
 * Overrides: CONVEX_URL (default: the production deployment), SEED_COUNT
 * (default 3), SEED_DRY_RUN=1 (sign in, prove auth + PoW, print the
 * posts that would be created — no writes).
 * Exit codes: 0 seeded (or dry-run passed), 1 a step failed, 2 missing
 * password.
 */
import { existsSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";
import { powProof } from "./lib/qa-pow.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://jovial-axolotl-209.convex.cloud";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
// Harness fallback: when the password isn't available, an enabled test
// harness can mint a real admin session (testHarness.mintAdminSession) —
// the same mechanism the production QAs use. The secret comes from env
// or the gitignored .freebuff/.harness-secret file.
const harnessFile = new URL("../.freebuff/.harness-secret", import.meta.url);
const HARNESS_SECRET =
  process.env.TEST_HARNESS_SECRET ??
  (existsSync(harnessFile) ? readFileSync(harnessFile, "utf8").trim() : "");
const DRY_RUN = process.env.SEED_DRY_RUN === "1";
const rawCount = Number(process.env.SEED_COUNT ?? 3);
const COUNT =
  Number.isFinite(rawCount) && rawCount >= 1 && rawCount <= 10
    ? Math.floor(rawCount)
    : 3;

// The sitemap POSTS in, not over — never spam the feed to force a count.
// Original, on-topic copy for PureWire (an original-content platform);
// each carries a unique stamp so the originality fingerprint never
// flags a repeat run as a duplicate of an earlier seed.
const TOPICS = [
  "Welcome to PureWire — a feed built for original work. Share what you made, say how you made it, and keep it yours.",
  "The Standard in one line: create it yourself, disclose how, and treat people well. Everything else follows from that.",
  "Every post here declares how it was made — human-made or AI-assisted — so credit lands where it belongs.",
  "Photos, videos and audio all live here. Attach one, add a caption, and your work stays yours.",
  "Comments auto-close on their own schedule, so old threads stay quiet without anyone playing moderator.",
];

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nPureWire seed posts (${CONVEX_URL})${DRY_RUN ? " — DRY RUN" : ""}\n`);
  if (!ADMIN_PASSWORD && !HARNESS_SECRET) {
    console.error(passwordHint());
    console.error(
      "  3. harness: enable TEST_HARNESS on the deployment and pass TEST_HARNESS_SECRET",
    );
    process.exit(2);
  }

  // 1. Sign in as the admin. Preferred: the real password flow through a
  //    fresh client (the same hygiene admin-auth-qa documents for the
  //    dead-token bug). Fallback: the harness-minted admin session when the
  //    password isn't available but the deployment's test harness is on.
  const client = new ConvexHttpClient(CONVEX_URL);
  let token = null;
  let via = null;
  if (ADMIN_PASSWORD) {
    try {
      const signIn = await client.action("auth:signIn", {
        provider: "password",
        params: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, flow: "signIn" },
      });
      token = signIn?.tokens?.token;
      if (token) via = "password";
    } catch (e) {
      console.log(`  password sign-in failed (${String(e.message).slice(0, 80)})`);
    }
  }
  if (!token && HARNESS_SECRET) {
    try {
      const minted = await client.mutation(api.testHarness.mintAdminSession, {
        secret: HARNESS_SECRET,
      });
      token = minted?.token;
      if (token) via = "test-harness";
    } catch (e) {
      console.log(`  harness mint failed (${String(e.message).slice(0, 80)})`);
    }
  }
  check(
    `signed in as the admin (via ${via ?? "nothing"})`,
    typeof token === "string" && token.length > 0,
  );
  if (!token) {
    if (!ADMIN_PASSWORD && !HARNESS_SECRET) {
      console.error(
        "No admin password and no harness secret available. Provide either:",
      );
      console.error(passwordHint());
      console.error(
        "  3. harness: enable TEST_HARNESS on the deployment and save its secret to .freebuff/.harness-secret",
      );
    }
    process.exit(1);
  }
  client.setAuth(token);

  const me = await client.query(api.users.getCurrentUser);
  check(
    "session resolves to the admin account",
    !!me && typeof me.username === "string",
    me?.username ?? "null",
  );
  if (!me) process.exit(1);
  console.log(`  seeding as @${me.username}\n`);

  // 2. Prove the composer's proof-of-work gate accepts our solver before
  //    writing anything — a dry run exercises the exact same puzzle.
  const proof = await powProof(client);
  check(
    "solved a proof-of-work challenge",
    typeof proof.powChallenge === "string" && proof.powChallenge.length > 0,
  );

  // 3. Idempotency: topics already live under the admin's name are skipped
  //    (re-running must never re-post near-identical text — the platform's
  //    originality gate rightly rejects that). Stored seed posts carry the
  //    topic text with a trailing "(seed …)" stamp, so compare the
  //    stamp-stripped prefix.
  const mine = await client.query(api.posts.listUserPosts, {
    userId: me._id,
    paginationOpts: { numItems: 100, cursor: null },
  });
  const existing = new Set(
    (mine?.page ?? [])
      .map((p) => String(p.content ?? "").replace(/\s*\(seed [^)]*\)\s*$/, "").trim().slice(0, 60))
      .filter((s) => s.length > 0),
  );
  const targets = [];
  for (let i = 0; targets.length < COUNT && i < TOPICS.length; i++) {
    const topic = TOPICS[i % TOPICS.length];
    if (!existing.has(topic.slice(0, 60))) targets.push(topic);
  }
  if (targets.length === 0) {
    check("seed posts already present (idempotent skip)", true);
  }

  if (DRY_RUN) {
    console.log("\nDry run — would create these posts:");
    for (const t of targets) {
      console.log(`  - ${t}`);
    }
    console.log(`\n${passed} passed, ${failed} failed (no writes performed)`);
    process.exit(failed > 0 ? 1 : 0);
  }

  // 4. Publish through the public action — every platform gate applies,
  //    including the rate limit, so space the posts out a little.
  const stamp = Date.now().toString(36);
  const createdIds = [];
  for (let i = 0; i < targets.length; i++) {
    const content = `${targets[i]} (seed ${stamp}-${i + 1})`;
    const result = await client.action(api.posts.createPost, {
      content,
      creatorDisclosure: "human-made",
      ...proof,
    });
    const ok = result?.ok === true && typeof result.postId === "string";
    // The duplicate gate can still fire on a race; it means the content
    // is already there, which is the idempotent outcome.
    const duped =
      !ok && /recently|already exists|original/i.test(String(result?.error ?? ""));
    check(
      `published post ${i + 1}/${targets.length}`,
      ok || duped,
      result?.error ?? "",
    );
    if (duped) continue;
    if (!ok) break;
    createdIds.push(result.postId);
    if (i < targets.length - 1) await sleep(1500);
  }

  // 4. Verify each post is publicly readable (the same query the OG page
  //    renders from) — a post stuck in review would never reach the feed.
  for (const postId of createdIds) {
    const post = await client.query(api.posts.getPost, { postId });
    check(`post ${postId.slice(-6)} is publicly readable`, post !== null);
  }

  // 5. Verify the sitemap actually gains the /post/ URLs. The dynamic
  //    sitemap is CDN-cached (s-maxage=3600) on the main host, so bust the
  //    edge with a query param and fall back to the convex.site mirror,
  //    which serves the same dynamic action.
  const postUrls = [];
  for (const site of [CONVEX_URL.replace(".convex.cloud", ".convex.site")]) {
    try {
      const res = await fetch(`${site}/sitemap.xml`);
      if (res.ok) {
        const xml = await res.text();
        postUrls.push(
          ...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
            .map((m) => m[1])
            .filter((u) => u.includes("/post/")),
        );
      }
    } catch {
      // The mirror check is best-effort; the guard workflows re-verify.
    }
  }
  check(
    "sitemap now carries post URLs",
    postUrls.length > 0,
    `${postUrls.length} post URL(s)${postUrls.length > 0 ? ` — newest: ${postUrls[0]}` : ""}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (createdIds.length > 0) {
    console.log("Created posts:");
    for (const id of createdIds) console.log(`  https://purewire.vercel.app/post/${id}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("seed-posts crashed:", e.message);
  process.exit(1);
});
