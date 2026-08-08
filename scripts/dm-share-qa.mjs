#!/usr/bin/env node
/**
 * PureWire production DM share QA.
 *
 * Drives the two-user share-a-post-into-a-DM flow end to end against the
 * live deployment — the exact path the DM share feature (sharedPostId on
 * messages, composer preview, shared-post card, dm-share notification)
 * protects. Harness-gated like the shadowban/reinstate/phishing checks.
 *
 * Backend half (deterministic):
 *   1. Creates two throwaway qa_ accounts and registers real P-256 keys.
 *   2. A creates a post and opens the 1:1 conversation with B.
 *   3. A sends a card-only share, a caption+share, and a plain message.
 *   4. B's message list round-trips sharedPostId on the share rows (and
 *      not on the plain row); the shared post resolves via getPost.
 *   5. B's bell: unreadCount includes the rows and a "dm-share"
 *      notification carries postId + conversationId (regression-guards the
 *      notification feature).
 *   6. Negative: a share referencing a nonexistent post is rejected.
 *
 * Browser half (Playwright, best-effort against bot protection):
 *   7. A's composer (seeded session + device keys) shows the live sharing
 *      preview via the ?share= deep link and sends a real encrypted
 *      message.
 *   8. B's thread shows the DM text (decrypted) plus the shared-post card
 *      with a View post link.
 *   A Vercel Security Checkpoint (bot-protection 403 page served to
 *   headless browsers) marks the browser half as skipped — it isn't the
 *   app and can't produce a signal, so it must not red the gate.
 *
 * Run:
 *   TEST_HARNESS_SECRET=<secret> npm run qa:dm-share
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

/** A real extractable P-256 ECDH keypair, exported as JSON JWK strings. */
async function makeKeypair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  return {
    publicJwk: JSON.stringify(publicJwk),
    privateJwk: JSON.stringify(privateJwk),
  };
}

/**
 * Backend half: the full server-side round trip of a post shared into a DM.
 * Returns the fixtures the browser half reuses (users, keys, ids).
 */
async function backendChecks(client) {
  console.log("\n1. Backend round trip");
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const users = [
    { name: `QA DShare ${stamp}`, username: `qa_dshare_${stamp}` },
    { name: `QA DRecv ${stamp}`, username: `qa_drecv_${stamp}` },
  ];
  const [a, b] = await Promise.all(
    users.map((u) =>
      client.mutation(api.testHarness.createTestUser, { ...u, secret: HARNESS_SECRET }),
    ),
  );
  check("created two throwaway QA accounts", Boolean(a?.token && b?.token));
  if (!a?.userId || !b?.userId) return null;

  const [aKeys, bKeys] = await Promise.all([makeKeypair(), makeKeypair()]);
  // Register real public keys for both sides so the shared key derives.
  for (const [u, keys] of [
    [a, aKeys],
    [b, bKeys],
  ]) {
    const uc = new ConvexHttpClient(CONVEX_URL);
    uc.setAuth(u.token);
    await uc.mutation(api.dms.setDmPublicKey, { publicKey: keys.publicJwk });
  }

  // A creates the post to share. Content is unique per run and word-sets
  // are disjoint between the two posts so the near-duplicate gate can't
  // flag the QA's own fixture as stolen.
  const ac = new ConvexHttpClient(CONVEX_URL);
  ac.setAuth(a.token);
  const postRes = await ac.action(api.posts.createPost, {
    content: `Midnight lighthouse keeper lantern storm clouds ${stamp}`,
    creatorDisclosure: "human-made",
    ...(await powProof(client)),
  });
  check("A created the post to share", postRes.ok === true, postRes.error ?? "");
  if (!postRes.ok) return null;
  const postId = postRes.postId;

  const convo = await ac.mutation(api.dms.openConversation, { userId: b.userId });
  check("A opened the 1:1 conversation with B", typeof convo.conversationId === "string");
  const convoId = convo.conversationId;

  // Three messages: card-only share, caption+share, and a plain message.
  const cardOnly = await ac.mutation(api.dms.sendMessage, {
    conversationId: convoId,
    ciphertext: "",
    iv: "qa-iv",
    sharedPostId: postId,
    ...(await powProof(client)),
  });
  const caption = await ac.mutation(api.dms.sendMessage, {
    conversationId: convoId,
    ciphertext: "encrypted-caption",
    iv: "qa-iv",
    sharedPostId: postId,
    ...(await powProof(client)),
  });
  const plain = await ac.mutation(api.dms.sendMessage, {
    conversationId: convoId,
    ciphertext: "encrypted-plain",
    iv: "qa-iv",
    ...(await powProof(client)),
  });
  check("all three messages sent", Boolean(cardOnly?.messageId && caption?.messageId && plain?.messageId));

  // B's thread round-trips the reference.
  const bc = new ConvexHttpClient(CONVEX_URL);
  bc.setAuth(b.token);
  const list = await bc.query(api.dms.listMessages, {
    conversationId: convoId,
    paginationOpts: { numItems: 10, cursor: null },
  });
  const shares = list.page.filter((m) => m.sharedPostId === postId);
  const plainRows = list.page.filter((m) => m.sharedPostId === undefined);
  check("B sees the shared messages with sharedPostId", shares.length === 2, `got ${shares.length}`);
  check("the plain message carries no sharedPostId", plainRows.length === 1, `got ${plainRows.length}`);
  check(
    "the shared post resolves for B via getPost",
    (await bc.query(api.posts.getPost, { postId })) !== null,
  );

  // Bell: the share emitted a dm-share notification with post + convo.
  const unread = await bc.query(api.notifications.unreadCount);
  check("B's unread count includes the new rows", unread >= 3, `got ${unread}`);
  const notifs = await bc.query(api.notifications.listNotifications, {
    paginationOpts: { numItems: 10, cursor: null },
  });
  const shareNotif = notifs.page.find((n) => n.type === "dm-share");
  check("a dm-share notification was emitted", shareNotif !== undefined);
  check("dm-share carries the post id", shareNotif?.postId === postId);
  check("dm-share carries the conversation id", shareNotif?.conversationId === convoId);

  // Negative: a share pointing at a nonexistent post is rejected.
  let rejected = false;
  try {
    await ac.mutation(api.dms.sendMessage, {
      conversationId: convoId,
      ciphertext: "",
      iv: "qa-iv",
      sharedPostId: "ghost0000000000000000000",
      ...(await powProof(client)),
    });
  } catch {
    rejected = true;
  }
  check("a share of a nonexistent post is rejected", rejected);

  return { a, b, aKeys, bKeys, convoId, postId, stamp };
}

/**
 * Browser half: A's composer preview + send, B's thread with the card.
 * Best-effort — a Vercel Security Checkpoint marks it skipped, never red.
 */
async function browserChecks(client, fx) {
  console.log("\n2. Browser half (two users, real encryption)");
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.log("  (skip) Playwright browsers not installed —", String(err).slice(0, 120));
    return;
  }
  const ns = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");

  // Mint fresh session pairs (JWT + refresh token) for browser seeding.
  const mint = async (username) => {
    const m = await client.mutation(api.testHarness.mintSessionForQaUsername, {
      username,
      secret: HARNESS_SECRET,
    });
    return { token: m.token, refreshToken: m.refreshToken };
  };
  const [aSession, bSession] = await Promise.all([
    mint(fx.a.username),
    mint(fx.b.username),
  ]);

  const seed = (page, session, userId, keys) =>
    page.addInitScript(
      (s) => {
        try {
          localStorage.setItem(`__convexAuthJWT_${s.ns}`, s.token);
          localStorage.setItem(`__convexAuthRefreshToken_${s.ns}`, s.refreshToken);
          localStorage.setItem(`purewire_dm_priv_${s.userId}`, s.priv);
          localStorage.setItem(`purewire_dm_pub_${s.userId}`, s.pub);
        } catch (_) {}
      },
      {
        ns,
        token: session.token,
        refreshToken: session.refreshToken,
        userId,
        priv: keys.privateJwk,
        pub: keys.publicJwk,
      },
    );

  const isCheckpoint = async (page) => {
    const title = await page.title().catch(() => "");
    return title.includes("Security Checkpoint");
  };

  try {
    // ── A: composer preview via the ?share= deep link, then send ──────
    const aCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const aPage = await aCtx.newPage();
    await seed(aPage, aSession, fx.a.userId, fx.aKeys);
    await aPage.goto(
      `${SITE_URL}/messages?convo=${fx.convoId}&share=${fx.postId}`,
      { waitUntil: "networkidle", timeout: 90000 },
    );
    if (await isCheckpoint(aPage)) {
      console.log("  (skipped) Vercel Security Checkpoint blocked the browser half");
      await aCtx.close();
      return;
    }
    // The Messages composer is the page's only textarea (its placeholder
    // is "Say it anyway — encrypted…" once the key derives).
    const composer = aPage.locator("textarea").first();
    await composer.waitFor({ state: "visible", timeout: 30000 });
    const aBody = (await aPage.locator("body").innerText()) ?? "";
    check(
      "A's composer shows the sharing preview",
      aBody.includes("Sharing a post") || aBody.includes(`Midnight lighthouse keeper lantern storm clouds ${fx.stamp}`),
    );
    const removeBtn = await aPage
      .locator('button[aria-label="Remove shared post"]')
      .isVisible()
      .catch(() => false);
    check("A's preview has a remove button", removeBtn);

    // Type a caption and send — this message is E2E-encrypted for real.
    await composer.fill(`Sharing this with you ${fx.stamp}`);
    const sendBtn = aPage.locator('button[aria-label="Send"]').first();
    await sendBtn.click();
    await aPage.waitForTimeout(3000);
    // The composer itself clears (the sent text legitimately appears in
    // the thread above — assert the textarea, not the body).
    const draftAfter = await composer.inputValue().catch(() => "");
    check("A's shared message was sent (composer cleared)", draftAfter.trim() === "");
    await aCtx.close();

    // ── B: the thread shows the text (decrypted) + the card ───────────
    const bCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const bPage = await bCtx.newPage();
    await seed(bPage, bSession, fx.b.userId, fx.bKeys);
    await bPage.goto(`${SITE_URL}/messages?convo=${fx.convoId}`, {
      waitUntil: "networkidle",
      timeout: 90000,
    });
    if (await isCheckpoint(bPage)) {
      console.log("  (skipped) Vercel Security Checkpoint blocked the browser half");
      await bCtx.close();
      return;
    }
    await bPage
      .locator("textarea")
      .first()
      .waitFor({ state: "visible", timeout: 30000 });
    await bPage.waitForTimeout(2500);
    const bBody = (await bPage.locator("body").innerText()) ?? "";
    check(
      "B sees the decrypted DM text",
      bBody.includes(`Sharing this with you ${fx.stamp}`),
    );
    check(
      "B sees the shared post preview card",
      bBody.includes(`Midnight lighthouse keeper lantern storm clouds ${fx.stamp}`),
    );
    const viewPost = await bPage
      .getByText("View post", { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    check("B's card has a View post link", viewPost);
    await bCtx.close();
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
  console.log(`\nPureWire production DM share QA (${CONVEX_URL})\n`);
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
    // Sweep fixtures: conversation, posts (author session still valid),
    // then the users. deleteTestUser now runs the full eraseAccount
    // cascade (posts, comments, engagement) — the explicit post deletion
    // here stays as a tidy first step so the feed never even briefly
    // shows the QA fixture while the account is being erased.
    if (fx?.a?.token) {
      const ac = new ConvexHttpClient(CONVEX_URL);
      ac.setAuth(fx.a.token);
      if (fx.convoId) {
        try {
          await ac.mutation(api.dms.deleteConversation, { conversationId: fx.convoId });
        } catch {
          /* best-effort */
        }
      }
      if (fx.postId) {
        try {
          await ac.mutation(api.posts.deletePost, { postId: fx.postId });
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
  console.error("\nDM share QA crashed:", e);
  process.exit(1);
});
