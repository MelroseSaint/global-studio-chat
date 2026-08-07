#!/usr/bin/env node
/**
 * Top-comments sort + like-count visibility QA against the live production
 * site.
 *
 * Signs in as the admin through the real Auth form, then — using the same
 * mutations the UI calls — creates a throwaway post with four comments and
 * likes two of them, so the thread has distinct like tiers (1, 1, 0, 0).
 * Verifies end-to-end in a real Chromium:
 *
 *   1. API: listComments with sort "top" ranks the liked comments above the
 *      unliked ones, newest-first within equal like counts; "newest" stays
 *      strictly reverse-chronological; the two sorts differ.
 *   2. Browser: the post page defaults to Top order (liked comments rise),
 *      the Newest toggle flips to reverse-chronological, the comment popup's
 *      preview shows the best replies first — and the per-comment like
 *      labels are visibly rendered (not just sorted by) with the right
 *      plain-language wording in both surfaces ("1 like"/"N likes"/"Like").
 *
 * The throwaway post (and its comments/likes) is deleted at the end, so the
 * site is left exactly as found. Run (password never in this file — see
 * lib/qa-secrets.mjs):
 *
 *   ADMIN_PASSWORD=<admin password> node scripts/top-sort-qa.mjs
 *   # or: printf '%s' '<password>' > .freebuff/.admin-password   # gitignored
 *
 * Overrides: SITE_URL (default https://purewire.vercel.app), CONVEX_URL,
 * ADMIN_EMAIL (default monroedoses@gmail.com), HEADED=1 to watch the browser.
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing password.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { launchBrowser, signIn } from "./lib/qa-browser.mjs";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";
import { powProof } from "./lib/qa-pow.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
const HEADED = process.env.HEADED === "1";
const NAV_TIMEOUT = 45000;

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

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  console.log(`\nTop-comments sort + like-count visibility QA (${SITE_URL})\n`);
  const browser = await launchBrowser({ headed: HEADED });
  let client = null;
  let postId = null;
  try {
    // ── 1. Sign in through the real form and capture the session JWT ──────
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(20000);
    await signIn(page, {
      siteUrl: SITE_URL,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    check("signed in through the real Auth form", true);
    // The auth client namespaces its storage keys with the Convex URL
    // (__convexAuthJWT_<host>), so find the JWT by prefix.
    const token = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("__convexAuthJWT"),
      );
      return key === undefined ? null : localStorage.getItem(key);
    });
    check(
      "session JWT captured for API calls",
      !!token && token.startsWith("eyJ"),
      token ? "" : "no JWT in localStorage",
    );

    client = new ConvexHttpClient(CONVEX_URL);
    client.setAuth(token);

    // ── 2. Seed: post + four comments, like two of them ────────────────────
    const ts = Date.now().toString(36).slice(-6);
    const post = await client.action(api.posts.createPost, {
      content: `Top-sort QA post ${ts}`,
      creatorDisclosure: "human-made",
      ...(await powProof(client)),
    });
    check("throwaway post created", post.ok === true, post.error);
    postId = post.postId;

    // c1..c4 in creation order (c4 newest). "two" and "four" get one like
    // each, so top order must be [four, two, three, one] (1-like tier first,
    // newest within it; then the 0-like tier, newest within it).
    const labels = ["one", "two", "three", "four"];
    for (const label of labels) {
      const res = await client.mutation(api.posts.addComment, {
        postId,
        content: `${label} ${ts}`,
        ...(await powProof(client)),
      });
      check(`comment "${label}" posted`, res.ok === true, res.error);
      await sleep(250); // stay under the comment budget
    }
    // addComment returns { ok } only — resolve the ids from a newest query
    // (which lists c4, c3, c2, c1 in that order) and like "four" (c4) and
    // "two" (c2).
    const seeded = await client.query(api.posts.listComments, {
      postId,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    const [c4, , c2] = seeded.page;
    check("four comments seeded (c4 newest)", seeded.page.length === 4, String(seeded.page.length));
    await client.mutation(api.posts.likeComment, { commentId: c4._id });
    await client.mutation(api.posts.likeComment, { commentId: c2._id });
    check("liked 'four' and 'two' (one like each)", true);

    // ── 3. API ordering assertions ─────────────────────────────────────────
    const paginationOpts = { numItems: 20, cursor: null };
    const top = await client.query(api.posts.listComments, {
      postId,
      sort: "top",
      paginationOpts,
    });
    const topOrder = top.page.map((c) => c.content.split(" ")[0]);
    check(
      "top: liked comments rise above unliked",
      topOrder[0] === "four" && topOrder[1] === "two",
      JSON.stringify(topOrder),
    );
    check(
      "top: unliked comments follow, newest first",
      topOrder[2] === "three" && topOrder[3] === "one",
      JSON.stringify(topOrder),
    );
    check(
      "top: like counts descend (1,1,0,0)",
      JSON.stringify(top.page.map((c) => c.likeCount)) === "[1,1,0,0]",
      JSON.stringify(top.page.map((c) => c.likeCount)),
    );
    const newest = await client.query(api.posts.listComments, {
      postId,
      sort: "newest",
      paginationOpts,
    });
    const newestOrder = newest.page.map((c) => c.content.split(" ")[0]);
    check(
      "newest: strictly reverse-chronological",
      JSON.stringify(newestOrder) === JSON.stringify(["four", "three", "two", "one"]),
      JSON.stringify(newestOrder),
    );
    check(
      "top and newest orders genuinely differ",
      JSON.stringify(topOrder) !== JSON.stringify(newestOrder),
      "",
    );

    // ── 4. Browser: thread order + toggle + popup preview ──────────────────
    await page.goto(`${SITE_URL}/post/${postId}`, { waitUntil: "domcontentloaded" });
    await page.getByText(`four ${ts}`, { exact: false }).first().waitFor({
      timeout: NAV_TIMEOUT,
    });

    const readOrder = async (scope) =>
      scope.evaluate((root) =>
        [...root.querySelectorAll("p")]
          .map((p) => (p.textContent ?? "").trim())
          .filter((t) => /^(one|two|three|four) /.test(t))
          .map((t) => t.split(" ")[0]),
      );

    // The like count must be VISIBLY rendered next to each heart, not just
    // used to sort: read the comment like buttons in DOM order and capture
    // whether they're liked and the number shown. Buttons are matched by
    // their exact aria-label so the post card's "Comment on this post" and
    // the "Comment actions" menus never leak in.
    const readCounts = async (scope) =>
      scope.evaluate((root) =>
        [...root.querySelectorAll("button")]
          .filter((b) => {
            const a = b.getAttribute("aria-label") ?? "";
            return a === "Like this comment" || a === "Unlike this comment";
          })
          .map((b) => {
            const span = b.querySelector("span");
            const cs = span ? getComputedStyle(span) : null;
            return {
              liked: (b.getAttribute("aria-label") ?? "").startsWith("Unlike"),
              count: (b.textContent ?? "").trim(),
              // The number must be styled to be clearly visible, not a
              // whisper: semibold (600) at 13px.
              weight: cs ? cs.fontWeight : "",
              size: cs ? cs.fontSize : "",
            };
          }),
      );

    const defaultOrder = await readOrder(page.locator("body"));
    check(
      "browser: thread defaults to Top (liked first)",
      JSON.stringify(defaultOrder) === JSON.stringify(["four", "two", "three", "one"]),
      JSON.stringify(defaultOrder),
    );

    // The per-comment like labels must be visible on the thread: top order
    // shows "1 like", "1 like", "Like", "Like" and the first two hearts
    // are filled (liked).
    const threadCounts = await readCounts(page.locator("body"));
    check(
      "browser: thread shows plain-language like labels (1 like, 1 like, Like, Like)",
      JSON.stringify(threadCounts.map((c) => c.count)) ===
        JSON.stringify(["1 like", "1 like", "Like", "Like"]),
      JSON.stringify(threadCounts),
    );
    check(
      "browser: liked comments render a filled heart in the thread",
      JSON.stringify(threadCounts.map((c) => c.liked)) === JSON.stringify([true, true, false, false]),
      JSON.stringify(threadCounts),
    );
    // The count must be *styled* to be clearly visible — at least semibold
    // and 13px — not a whisper. Thresholds (not exact Tailwind values) keep
    // the check honest but resilient to later sizing tweaks.
    check(
      "browser: counts styled prominently (≥semibold, ≥13px)",
      threadCounts.length === 4 &&
        threadCounts.every(
          (c) => parseInt(c.weight, 10) >= 600 && parseFloat(c.size) >= 13,
        ),
      JSON.stringify(threadCounts.map((c) => ({ weight: c.weight, size: c.size }))),
    );

    await page.getByRole("button", { name: "Newest" }).click();
    await page.waitForTimeout(600); // let the query reset + refetch
    const newestUi = await readOrder(page.locator("body"));
    check(
      "browser: Newest toggle flips to reverse-chronological",
      JSON.stringify(newestUi) === JSON.stringify(["four", "three", "two", "one"]),
      JSON.stringify(newestUi),
    );

    // Open the comment popup — its preview must surface the best replies.
    await page.getByRole("button", { name: "Comment on this post" }).click();
    const dialog = page.locator('[data-slot="dialog-content"]');
    await dialog.waitFor({ timeout: NAV_TIMEOUT });
    await dialog.getByText(`three ${ts}`, { exact: false }).first().waitFor({
      timeout: NAV_TIMEOUT,
    });
    const preview = await readOrder(dialog);
    check(
      "browser: popup preview shows the best replies first (top 3)",
      JSON.stringify(preview) === JSON.stringify(["four", "two", "three"]),
      JSON.stringify(preview),
    );

    // The popup preview must show the labels too: top 3 comments render
    // "1 like", "1 like", "Like" with the liked hearts filled.
    const previewCounts = await readCounts(dialog);
    check(
      "browser: popup preview shows plain-language like labels (1 like, 1 like, Like)",
      JSON.stringify(previewCounts.map((c) => c.count)) ===
        JSON.stringify(["1 like", "1 like", "Like"]),
      JSON.stringify(previewCounts),
    );
    check(
      "browser: popup preview renders liked hearts filled",
      JSON.stringify(previewCounts.map((c) => c.liked)) === JSON.stringify([true, true, false]),
      JSON.stringify(previewCounts),
    );

    // The popup's post preview must show the post's own like count too
    // (previously omitted). The throwaway post has no post-likes, so its
    // label is "0 likes" — a string that can only come from the post
    // preview, since the comment like buttons never render "0 likes".
    check(
      "browser: popup post preview shows the post's like count (0 likes)",
      (await dialog.getByText("0 likes").count()) >= 1,
    );
    // The same meta row must show the post's comment count too ("4
    // comments" — unique to the post preview, since the comment labels and
    // the "Comments" header never render that string).
    check(
      "browser: popup post preview shows the post's comment count (4 comments)",
      (await dialog.getByText("4 comments").count()) >= 1,
    );

    // ── 5. Threaded replies ───────────────────────────────────────────────
    // Close the popup so the thread behind is interactive again.
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(400);

    // Reply to c4 ("four") through the same mutation the UI calls. The
    // reply must stay OUT of the top-level list, bump four's replyCount to
    // 1, and be returned by listReplies under four.
    const replyRes = await client.mutation(api.posts.addComment, {
      postId,
      parentId: c4._id,
      content: `reply to four ${ts}`,
      ...(await powProof(client)),
    });
    check("reply to 'four' posted", replyRes.ok === true, replyRes.error);
    await sleep(400);
    const topAfter = await client.query(api.posts.listComments, {
      postId,
      sort: "top",
      paginationOpts,
    });
    check(
      "top-level list excludes the reply",
      topAfter.page.every((c) => c.content.split(" ")[0] !== "reply"),
      JSON.stringify(topAfter.page.map((c) => c.content.split(" ")[0])),
    );
    check(
      "four's replyCount is 1",
      topAfter.page[0].replyCount === 1,
      JSON.stringify(topAfter.page.map((c) => c.replyCount)),
    );
    const replies = await client.query(api.posts.listReplies, {
      postId,
      parentId: c4._id,
      sort: "newest",
      paginationOpts,
    });
    check(
      "listReplies returns the reply under four",
      replies.page.length === 1 &&
        replies.page[0].content.startsWith("reply to four"),
      JSON.stringify(replies.page.map((c) => c.content)),
    );

    // Browser: the thread shows "View 1 reply" under four; expanding shows
    // the reply nested beneath it.
    await page
      .getByText("View 1 reply")
      .first()
      .waitFor({ timeout: NAV_TIMEOUT });
    check("browser: 'View 1 reply' appears under the comment", true);
    await page.getByText("View 1 reply").first().click();
    await page
      .getByText(`reply to four ${ts}`)
      .first()
      .waitFor({ timeout: NAV_TIMEOUT });
    check("browser: expanding shows the reply nested under four", true);

    // Popup: reopening shows the reply under four too.
    await page.getByRole("button", { name: "Comment on this post" }).click();
    await dialog.waitFor({ timeout: NAV_TIMEOUT });
    await dialog
      .getByText("View 1 reply")
      .first()
      .waitFor({ timeout: NAV_TIMEOUT });
    check("browser: popup preview shows 'View 1 reply' under four", true);
    await dialog.getByText("View 1 reply").first().click();
    await dialog
      .getByText(`reply to four ${ts}`)
      .first()
      .waitFor({ timeout: NAV_TIMEOUT });
    check("browser: popup reply list shows the reply", true);

    // Deleting the reply drops replyCount back to 0 — count bookkeeping
    // stays honest end to end.
    await client.mutation(api.posts.deleteComment, {
      commentId: replies.page[0]._id,
    });
    await sleep(400);
    const afterDelete = await client.query(api.posts.listComments, {
      postId,
      sort: "top",
      paginationOpts,
    });
    check(
      "replyCount returns to 0 after deleting the reply",
      afterDelete.page[0].replyCount === 0,
      String(afterDelete.page[0].replyCount),
    );
  } finally {
    // ── 5. Cleanup: the throwaway post dies with its comments and likes ────
    if (client !== null && postId !== null) {
      try {
        await client.mutation(api.posts.deletePost, { postId });
        console.log("  🧹 Throwaway post + comments + likes deleted");
      } catch (e) {
        console.log(`  ⚠ cleanup failed: ${e.message}`);
      }
    }
    await browser.close();
  }
  finish();
}

main().catch((e) => {
  console.error("\nTop-sort QA crashed:", e);
  process.exit(1);
});
