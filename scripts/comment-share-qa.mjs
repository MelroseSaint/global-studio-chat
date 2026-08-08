#!/usr/bin/env node
/**
 * PureWire production comment-share QA.
 *
 * Drives the share-a-post-into-a-comment flow end to end against the live
 * deployment — the exact path the comment share feature (sharedPostId on
 * comments, the attach-a-post composer, the shared-post card in threads)
 * protects. Harness-gated like the shadowban/reinstate/phishing checks.
 *
 * Backend half (deterministic):
 *   1. Creates two throwaway qa_ accounts.
 *   2. A creates the post to share and a destination post to comment on.
 *   3. A comments card-only, caption+share, and plain text.
 *   4. B's listComments round-trips sharedPostId on the share rows (and
 *      not on the plain row); the shared post resolves via getPost.
 *   5. Negative: a share referencing a nonexistent post is rejected, and
 *      an empty husk (no text, no share) is still rejected.
 *
 * Browser half (Playwright, best-effort against bot protection):
 *   6. A's post page (?share= deep link) shows the live sharing preview
 *      with a remove button; A types a caption, posts the comment, and
 *      the thread renders the caption plus the shared-post card with a
 *      View post link.
 *   A Vercel Security Checkpoint (bot-protection 403 page served to
 *   headless browsers) marks the browser half as skipped — it isn't the
 *   app and can't produce a signal, so it must not red the gate.
 *
 * Run:
 *   TEST_HARNESS_SECRET=<secret> npm run qa:comment-share
 *
 * Overrides: CONVEX_URL (default the production deployment), SITE_URL
 * (default the production host). Exit codes: 0 all checks passed, 1 a
 * check failed, 2 missing harness secret.
 */
import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { powProof } from "./lib/qa-pow.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;

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

/**
 * Backend half: the full server-side round trip of a post shared into a
 * comment. Returns the fixtures the browser half reuses (users, ids).
 */
async function backendChecks(client) {
  console.log("\n1. Backend round trip");
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const users = [
    { name: `QA CShare ${stamp}`, username: `qa_cshare_${stamp}` },
    { name: `QA CRecv ${stamp}`, username: `qa_crecv_${stamp}` },
  ];
  const [a, b] = await Promise.all(
    users.map((u) =>
      client.mutation(api.testHarness.createTestUser, { ...u, secret: HARNESS_SECRET }),
    ),
  );
  check("created two throwaway QA accounts", Boolean(a?.token && b?.token));
  if (!a?.userId || !b?.userId) return null;

  // A creates both posts. Content is unique per run and word-sets are
  // disjoint between the two posts so the near-duplicate gate can't flag
  // the QA's own fixture as stolen.
  const ac = new ConvexHttpClient(CONVEX_URL);
  ac.setAuth(a.token);
  const sharedRes = await ac.action(api.posts.createPost, {
    content: `Midnight lighthouse keeper lantern storm clouds ${stamp}`,
    creatorDisclosure: "human-made",
    ...(await powProof(client)),
  });
  check("A created the post to share", sharedRes.ok === true, sharedRes.error ?? "");
  if (!sharedRes.ok) return null;
  const sharedPostId = sharedRes.postId;

  const destRes = await ac.action(api.posts.createPost, {
    content: `Granite canyon river boulders pine fog ${stamp}`,
    creatorDisclosure: "human-made",
    ...(await powProof(client)),
  });
  check("A created the destination post", destRes.ok === true, destRes.error ?? "");
  if (!destRes.ok) return null;
  const destPostId = destRes.postId;

  // Three comments: card-only share, caption+share, and plain text.
  const cardOnly = await ac.mutation(api.posts.addComment, {
    postId: destPostId,
    content: "",
    sharedPostId,
    ...(await powProof(client)),
  });
  const caption = await ac.mutation(api.posts.addComment, {
    postId: destPostId,
    content: `Look at this one ${stamp}`,
    sharedPostId,
    ...(await powProof(client)),
  });
  const plain = await ac.mutation(api.posts.addComment, {
    postId: destPostId,
    content: `Just saying hi ${stamp}`,
    ...(await powProof(client)),
  });
  check(
    "all three comments posted",
    Boolean(cardOnly?.ok && caption?.ok && plain?.ok),
    JSON.stringify({ cardOnly, caption, plain }).slice(0, 120),
  );

  // B's thread round-trips the reference.
  const bc = new ConvexHttpClient(CONVEX_URL);
  bc.setAuth(b.token);
  const list = await bc.query(api.posts.listComments, {
    postId: destPostId,
    paginationOpts: { numItems: 10, cursor: null },
    sort: "newest",
  });
  const shares = list.page.filter((c) => c.sharedPostId === sharedPostId);
  const plainRows = list.page.filter((c) => c.sharedPostId === undefined);
  check("B sees the shared comments with sharedPostId", shares.length === 2, `got ${shares.length}`);
  check("the plain comment carries no sharedPostId", plainRows.length === 1, `got ${plainRows.length}`);
  check(
    "the shared post resolves for B via getPost",
    (await bc.query(api.posts.getPost, { postId: sharedPostId })) !== null,
  );

  // Negative: a share pointing at a nonexistent post is rejected.
  let ghostRejected = false;
  try {
    await ac.mutation(api.posts.addComment, {
      postId: destPostId,
      content: "",
      sharedPostId: "ghost0000000000000000000",
      ...(await powProof(client)),
    });
  } catch {
    ghostRejected = true;
  }
  check("a share of a nonexistent post is rejected", ghostRejected);

  // Negative: an empty husk (no text, no share) is still rejected.
  let huskRejected = false;
  try {
    await ac.mutation(api.posts.addComment, {
      postId: destPostId,
      content: "",
      ...(await powProof(client)),
    });
  } catch {
    huskRejected = true;
  }
  check("an empty husk (no text, no share) is rejected", huskRejected);

  return { a, b, sharedPostId, destPostId, stamp };
}

/**
 * Browser half: A's composer preview via the ?share= deep link, then the
 * posted comment renders with the card. Best-effort — a Vercel Security
 * Checkpoint marks it skipped, never red.
 */
async function browserChecks(client, fx) {
  console.log("\n2. Browser half (composer preview + posted card)");
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.log("  (skip) Playwright browsers not installed —", String(err).slice(0, 120));
    return;
  }
  const ns = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");

  // Mint a fresh session pair (JWT + refresh token) for browser seeding.
  const mint = await client.mutation(api.testHarness.mintSessionForQaUsername, {
    username: fx.a.username,
    secret: HARNESS_SECRET,
  });

  const seed = (page) =>
    page.addInitScript(
      (s) => {
        try {
          localStorage.setItem(`__convexAuthJWT_${s.ns}`, s.token);
          localStorage.setItem(`__convexAuthRefreshToken_${s.ns}`, s.refreshToken);
        } catch (_) {}
      },
      {
        ns,
        token: mint.token,
        refreshToken: mint.refreshToken,
      },
    );

  const isCheckpoint = async (page) => {
    const title = await page.title().catch(() => "");
    return title.includes("Security Checkpoint");
  };

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await seed(page);
    await page.goto(
      `${SITE_URL}/post/${fx.destPostId}?share=${fx.sharedPostId}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    if (await isCheckpoint(page)) {
      console.log("  (skipped) Vercel Security Checkpoint blocked the browser half");
      await ctx.close();
      return;
    }
    // The comment composer is the page's comment textarea (its placeholder
    // prompts for a comment once the post loads).
    const composer = page.locator("textarea").first();
    await composer.waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(2000);
    const body = (await page.locator("body").innerText()) ?? "";
    check(
      "A's composer shows the sharing preview",
      body.includes(`Midnight lighthouse keeper lantern storm clouds ${fx.stamp}`) ||
        body.includes("Sharing a post"),
    );
    const removeBtn = await page
      .locator('button[aria-label="Remove shared post"]')
      .isVisible()
      .catch(() => false);
    check("A's preview has a remove button", removeBtn);

    // Type a caption and post the comment — it carries the shared post.
    await composer.fill(`Via the browser ${fx.stamp}`);
    const postBtn = page.locator('button[aria-label="Send comment"]').first();
    await postBtn.click();
    await page.waitForTimeout(3000);
    const bodyAfter = (await page.locator("body").innerText()) ?? "";
    check(
      "the comment posted with the caption",
      bodyAfter.includes(`Via the browser ${fx.stamp}`),
    );
    check(
      "the thread renders the shared-post card",
      bodyAfter.includes(`Midnight lighthouse keeper lantern storm clouds ${fx.stamp}`),
    );
    const viewPost = await page
      .getByText("View post", { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    check("the comment's card has a View post link", viewPost);
    // The composer clears (the caption lives in the thread, not the draft).
    const draftAfter = await composer.inputValue().catch(() => "");
    check("the composer cleared after posting", draftAfter.trim() === "");
    await ctx.close();
  } finally {
    if (browser) await browser.close();
  }
}

async function main() {
  if (!HARNESS_SECRET) {
    console.log(
      "TEST_HARNESS_SECRET is required (the harness mints throwaway QA sessions).",
    );
    process.exit(2);
  }
  console.log(`\nPureWire production comment-share QA (${CONVEX_URL})\n`);
  const client = new ConvexHttpClient(CONVEX_URL);
  const { enabled } = await client.query(api.testHarness.isEnabled);
  if (!enabled) {
    console.log("The QA harness is disabled on this deployment — enable it with");
    console.log("TEST_HARNESS_ENABLED=1 + TEST_HARNESS_SECRET to run this check.");
    process.exit(2);
  }

  let fx = null;
  try {
    fx = await backendChecks(client);
    if (fx) await browserChecks(client, fx);
  } finally {
    // Sweep fixtures: the destination post (cascades its comments) and the
    // shared post (author session still valid), then the users. deleteTestUser
    // does NOT cascade posts, so post deletion must happen first or orphaned
    // QA content lingers on the live feed (and trips the near-duplicate gate
    // on later runs).
    if (fx?.a?.token) {
      const ac = new ConvexHttpClient(CONVEX_URL);
      ac.setAuth(fx.a.token);
      for (const postId of [fx.destPostId, fx.sharedPostId]) {
        if (!postId) continue;
        try {
          await ac.mutation(api.posts.deletePost, { postId });
        } catch {
          /* best-effort */
        }
      }
    }
    for (const u of [fx?.a, fx?.b]) {
      if (!u?.userId) continue;
      try {
        await client.mutation(api.testHarness.deleteTestUser, {
          userId: u.userId,
          secret: HARNESS_SECRET,
        });
      } catch {
        /* best-effort */
      }
    }
    console.log("\nCleanup done.");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nComment share QA crashed:", e);
  process.exit(1);
});
