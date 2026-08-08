#!/usr/bin/env node
/**
 * PureWire shared-post video autoplay QA.
 *
 * Builds a real fixture — two QA users, a post with a video, a DM share —
 * then renders B's thread AND the main feed (as the author, so the post is
 * visible there) in an iPhone emulation and a desktop context and asserts
 * the video's autoplay attribute follows the platform-wide policy
 * (src/lib/video-autoplay.ts): OFF on iOS (cellular + Safari's gesture
 * rule), ON on desktop. Guards the useDevice()-driven autoplay policy on
 * BOTH surfaces (shared-post previews and the feed's inline cards) so a
 * regression (autoplaying on iPhone, or never autoplaying on desktop)
 * surfaces on the next push.
 *
 * Run:
 *   TEST_HARNESS_SECRET=<secret> npm run qa:shared-video-autoplay
 *   # locally, against a production preview: PROBE_SITE_URL=http://localhost:4173 ...
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing secret.
 */
import { chromium, devices } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api.js";
import { powProof } from "./lib/qa-pow.mjs";

const CONVEX_URL = process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
// Default: the live production site (CI). Local runs against a production
// preview can override via PROBE_SITE_URL.
const SITE_URL = process.env.PROBE_SITE_URL ?? "https://purewire.vercel.app";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;
const ns = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");
// A small, reliable public sample video for the fixture.
const VIDEO_URL =
  "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

// A minimal-but-real MP4 container (ftyp header) — enough for the upload
// pipeline and a <video> element to mount with a provider-hosted URL.
const MINI_MP4 = Buffer.from(
  "AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAAAAAAAAA=",
  "base64",
);

const client = new ConvexHttpClient(CONVEX_URL);
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  if (!HARNESS_SECRET) {
    console.log("TEST_HARNESS_SECRET required");
    process.exit(2);
  }
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const aName = `qa_avs_${stamp}`;
  const bName = `qa_avr_${stamp}`;
  const [a, b] = await Promise.all([
    client.mutation(api.testHarness.createTestUser, {
      name: `QA AV S ${stamp}`,
      username: aName,
      secret: HARNESS_SECRET,
    }),
    client.mutation(api.testHarness.createTestUser, {
      name: `QA AV R ${stamp}`,
      username: bName,
      secret: HARNESS_SECRET,
    }),
  ]);
  // A's API client authenticates directly with the token createTestUser
  // returned (same pattern as dm-share-qa).
  const ac = new ConvexHttpClient(CONVEX_URL);
  ac.setAuth(a.token);

  // Upload the video exactly like the app: prepareUpload for the ticket,
  // then POST the bytes. In Cloudinary mode the unsigned preset may reject
  // a synthetic file, so use the ticket's Convex fallbackUrl — the same
  // fallback MediaUpload.tsx uses — which stores the bytes in Convex
  // storage and returns a storageId (provider-hosted, satisfying the gate).
  const ticket = await ac.action(api.media.prepareUpload, {
    contentType: "video/mp4",
  });
  const targetUrl = ticket.mode === "convex" ? ticket.uploadUrl : ticket.fallbackUrl;
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: new Blob([MINI_MP4], { type: "video/mp4" }),
  });
  const data = await res.json();
  const videoMedia = { storageId: data.storageId, kind: "video", stripped: false };

  const postRes = await ac.action(api.posts.createPost, {
    content: `Autoplay policy fixture ${stamp}`,
    creatorDisclosure: "human-made",
    media: [videoMedia],
    ...(await powProof(client)),
  });
  if (!postRes.ok) {
    console.log("createPost failed:", postRes.error);
    process.exit(1);
  }
  const postId = postRes.postId;
  const convo = await ac.mutation(api.dms.openConversation, { userId: b.userId });
  await ac.mutation(api.dms.sendMessage, {
    conversationId: convo.conversationId,
    ciphertext: "",
    iv: "qa-iv",
    sharedPostId: postId,
    ...(await powProof(client)),
  });

  // Fresh session per context — Convex rotates a minted token once a
  // browser uses it (same discovery as the PWA-install-hint QA).
  const mintB = async () => {
    const m = await client.mutation(api.testHarness.mintSessionForQaUsername, {
      username: bName,
      secret: HARNESS_SECRET,
    });
    return { token: m.token, refreshToken: m.refreshToken };
  };
  // The feed check needs the AUTHOR's session: test-isolation hides other
  // test accounts' posts from B, but A always sees their own post.
  const mintA = async () => {
    const m = await client.mutation(api.testHarness.mintSessionForQaUsername, {
      username: aName,
      secret: HARNESS_SECRET,
    });
    return { token: m.token, refreshToken: m.refreshToken };
  };
  const seed = (page, session) =>
    page.addInitScript(
      (s) => {
        try {
          localStorage.setItem(`__convexAuthJWT_${s.ns}`, s.token);
          localStorage.setItem(`__convexAuthRefreshToken_${s.ns}`, s.refreshToken);
        } catch (_) {}
      },
      { ns, token: session.token, refreshToken: session.refreshToken },
    );

  const browser = await chromium.launch({ headless: true });
  const videoAutoplay = (page) =>
    page.evaluate(() => {
      const v = document.querySelector("video");
      return v ? v.autoplay : null;
    });
  // The "Autoplay off" chip surfaces exactly when the policy disables
  // autoplay, so an iOS/cellular viewer knows the video waits for a tap.
  const chipVisible = (page) =>
    page.evaluate(() => document.body.innerText.includes("Autoplay off"));

  try {
    // iPhone: autoplay must be OFF (policy default).
    {
      const ctx = await browser.newContext({ ...devices["iPhone 13"] });
      const page = await ctx.newPage();
      await seed(page, await mintB());
      await page.goto(`${SITE_URL}/messages?convo=${convo.conversationId}`, {
        waitUntil: "networkidle",
      });
      // Wait for the shared-post video to mount.
      for (let i = 0; i < 30; i++) {
        if ((await page.evaluate(() => document.querySelector("video"))) != null) break;
        await page.waitForTimeout(400);
      }
      const v = await videoAutoplay(page);
      check("iPhone: shared video does NOT autoplay", v === false, `autoplay=${v}`);
      check("iPhone: 'Autoplay off' chip is shown", (await chipVisible(page)) === true);
      await ctx.close();
    }

    // Desktop: autoplay must be ON (policy default).
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await seed(page, await mintB());
      await page.goto(`${SITE_URL}/messages?convo=${convo.conversationId}`, {
        waitUntil: "networkidle",
      });
      for (let i = 0; i < 30; i++) {
        if ((await page.evaluate(() => document.querySelector("video"))) != null) break;
        await page.waitForTimeout(400);
      }
      const v = await videoAutoplay(page);
      check("desktop: shared video autoplays", v === true, `autoplay=${v}`);
      check("desktop: no 'Autoplay off' chip (autoplay on)", (await chipVisible(page)) === false);
      await ctx.close();
    }

    // The main feed's inline cards follow the SAME policy.
    // iPhone: feed video must NOT autoplay.
    {
      const ctx = await browser.newContext({ ...devices["iPhone 13"] });
      const page = await ctx.newPage();
      await seed(page, await mintA());
      await page.goto(`${SITE_URL}/home`, { waitUntil: "networkidle" });
      for (let i = 0; i < 30; i++) {
        if ((await page.evaluate(() => document.querySelector("video"))) != null) break;
        await page.waitForTimeout(400);
      }
      const v = await videoAutoplay(page);
      check("iPhone: feed video does NOT autoplay", v === false, `autoplay=${v}`);
      check("iPhone: feed 'Autoplay off' chip is shown", (await chipVisible(page)) === true);
      await ctx.close();
    }

    // Desktop: feed video must autoplay.
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await seed(page, await mintA());
      await page.goto(`${SITE_URL}/home`, { waitUntil: "networkidle" });
      for (let i = 0; i < 30; i++) {
        if ((await page.evaluate(() => document.querySelector("video"))) != null) break;
        await page.waitForTimeout(400);
      }
      const v = await videoAutoplay(page);
      check("desktop: feed video autoplays", v === true, `autoplay=${v}`);
      check("desktop: no feed 'Autoplay off' chip (autoplay on)", (await chipVisible(page)) === false);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // Cleanup.
  try {
    await client.mutation(api.testHarness.deleteTestUser, {
      username: aName,
      secret: HARNESS_SECRET,
    });
    await client.mutation(api.testHarness.deleteTestUser, {
      username: bName,
      secret: HARNESS_SECRET,
    });
  } catch {
    /* best-effort */
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
