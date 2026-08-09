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
 * The desktop feed block also asserts the viewport-aware pause: an
 * autoplaying feed card pauses (IntersectionObserver) when scrolled out of
 * view and resumes when it returns, so off-screen videos don't keep
 * decoding frames (src/components/SharedPostEmbed.tsx AutoPauseVideo).
 *
 * The iPhone blocks assert the no-autoplay card is never a dark box: a
 * tap-to-play overlay ("Play video" button) is shown, the client-side
 * poster capture lands, and tapping the overlay actually starts playback.
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

// The playback-dependent checks (pause off-screen / resume on return)
// need a video that ACTUALLY decodes in headless Chromium, which lacks
// proprietary H.264 — so the fixture must be a WebM (VP9). Fetched at run
// time from MDN's CC0 sample. If the fetch ever fails, fall back to the
// synthetic MP4 (mounts but can't decode) and skip the playback-dependent
// checks rather than failing the whole gate on an external hiccup.
const WEBM_URL =
  "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm";
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
  // then POST the bytes. Prefer a real WebM so the video actually decodes
  // in headless Chromium (H.264 does not) — the pause/resume assertions
  // depend on genuine playback. On fetch failure, fall back to the
  // synthetic MP4 and skip the playback-dependent checks.
  let fixture = { bytes: MINI_MP4, contentType: "video/mp4", playable: false };
  try {
    const webm = await fetch(WEBM_URL);
    if (webm.ok) {
      fixture = {
        bytes: Buffer.from(await webm.arrayBuffer()),
        contentType: "video/webm",
        playable: true,
      };
    } else {
      console.log("  ⚠ WebM fixture fetch failed (" + webm.status + ") — playback checks will be skipped.");
    }
  } catch {
    console.log("  ⚠ WebM fixture fetch failed (network) — playback checks will be skipped.");
  }

  const ticket = await ac.action(api.media.prepareUpload, {
    contentType: fixture.contentType,
  });
  const targetUrl = ticket.mode === "convex" ? ticket.uploadUrl : ticket.fallbackUrl;
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": fixture.contentType },
    body: new Blob([fixture.bytes], { type: fixture.contentType }),
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
  // When autoplay is disabled the card must not be a dark box: a tap-to-
  // play overlay ("Play video" button) plus a captured poster frame.
  const playOverlayVisible = (page) =>
    page.evaluate(() => document.querySelector('[aria-label="Play video"]') != null);
  const posterReady = (page) =>
    page.evaluate(() => {
      const v = document.querySelector("video");
      return v ? (v.getAttribute("poster") || "").length > 0 : false;
    });
  const videoPlaying = (page) =>
    page.evaluate(() => {
      const v = document.querySelector("video");
      return v ? !v.paused : false;
    });
  // Poll a predicate for up to ~10s (poster capture needs the video to
  // load metadata, seek, and draw before the data-URL poster appears).
  const poll = async (page, fn) => {
    for (let i = 0; i < 25; i++) {
      if (await fn(page)) return true;
      await page.waitForTimeout(400);
    }
    return false;
  };

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
      check("iPhone: shared tap-to-play overlay is shown", (await playOverlayVisible(page)) === true);
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

      // The no-autoplay card must not be a dark box: a real poster frame
      // is captured client-side (first frame -> canvas -> data URL) and
      // the tap-to-play overlay starts playback on tap.
      check(
        "iPhone: feed video gets a poster frame",
        (await poll(page, posterReady)) === true,
      );
      check(
        "iPhone: feed tap-to-play overlay is shown",
        (await playOverlayVisible(page)) === true,
      );
      await page.click('[aria-label="Play video"]');
      check(
        "iPhone: tapping the overlay starts playback",
        (await poll(page, videoPlaying)) === true,
      );
      await ctx.close();
    }

    // Desktop: feed video must autoplay AND pause when scrolled out of view
    // (IntersectionObserver) so an off-screen card doesn't keep decoding
    // frames. Moving the element out of the viewport via fixed positioning is
    // deterministic regardless of how short the feed is.
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

      if (fixture.playable) {
        // Make sure the video is actually playing before scrolling it away.
        await page.evaluate(() => {
          const video = document.querySelector("video");
          if (video) {
            video.muted = true;
            video.playsInline = true;
            const p = video.play();
            if (p) p.catch(() => {});
          }
        });
        let playing = false;
        for (let i = 0; i < 25 && !playing; i++) {
          playing = await page.evaluate(() => {
            const v = document.querySelector("video");
            return v ? !v.paused && v.readyState >= 2 : false;
          });
          if (!playing) await page.waitForTimeout(400);
        }
        check("desktop: feed video is actually playing (precondition)", playing === true);

        // Scroll it out of view → the IntersectionObserver must pause it.
        const paused = await page.evaluate(async () => {
          const v = document.querySelector("video");
          if (!v) return null;
          v.style.position = "fixed";
          v.style.left = "-2000px";
          v.style.top = "-2000px";
          await new Promise((r) => setTimeout(r, 600));
          return v.paused;
        });
        check("desktop: feed video pauses off-screen", paused === true, `paused=${paused}`);

        // Bring it back → playback must resume where it left off.
        let resumed = false;
        await page.evaluate(() => {
          const v = document.querySelector("video");
          if (!v) return;
          v.style.position = "";
          v.style.left = "";
          v.style.top = "";
          v.scrollIntoView({ block: "center" });
        });
        for (let i = 0; i < 20 && !resumed; i++) {
          resumed = await page.evaluate(() => {
            const v = document.querySelector("video");
            return v ? !v.paused : false;
          });
          if (!resumed) await page.waitForTimeout(300);
        }
        check("desktop: feed video resumes on return", resumed === true, `resumed=${resumed}`);
      } else {
        console.log("  ⚠ Skipping playback-dependent checks (fixture not decodable).");
      }
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
