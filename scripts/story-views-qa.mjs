/**
 * PureWire production QA — story viewer lists (3-account walk).
 *
 * Verifies the story-viewer feature end-to-end against a live deployment
 * with three throwaway accounts (one author, two viewers):
 *
 *   1. Ordering — the author sees BOTH viewers on their own story, sorted
 *      newest-first (the viewer who looked most recently is at the top).
 *   2. Dedupe — when a viewer re-opens the story, their view row is bumped,
 *      not duplicated: the list stays at exactly two entries and the
 *      re-viewing viewer bubbles to the top with a newer viewedAt.
 *   3. Privacy — a non-author (either viewer) asking for the same list
 *      gets an EMPTY page, not an error: only the author (or an admin)
 *      ever learns who looked at a story.
 *
 * Harness-gated exactly like the other QAs — the deployment env must have
 * TEST_HARNESS_ENABLED=1 and the caller must pass TEST_HARNESS_SECRET:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/story-views-qa.mjs
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Every throwaway account is erased with the full admin removeAccount
 * sweep in a finally block, so a crash can't leave QA users behind (the
 * nightly cleanup-test-users / sweep-traces jobs are the belt-and-
 * suspenders). Wired into the production-healthcheck workflow as the
 * story-views-qa job — nightly, on every push to main, and on manual
 * dispatch.
 *
 * Overrides: CONVEX_URL (default: the production deployment),
 * TEST_HARNESS_SECRET.
 */

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { assertAdminIpVerified } from "./lib/qa-admin-ip.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SECRET = process.env.TEST_HARNESS_SECRET;
const client = new ConvexHttpClient(CONVEX_URL);

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

// A real, minimal 1x1 transparent PNG — a valid image whose bytes carry no
// AI-generator or GPS markers, so the server-side scan verdicts it "clean"
// and the story goes live on the author's ring.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Upload media the way the real client does — prepareUpload hands out a
 * ticket in either mode: a Cloudinary upload URL (primary, when
 * CLOUDINARY_* is configured) or a Convex storage URL (fallback). Returns
 * the media object createStory accepts: {storageId, kind} or
 * {url, key, kind}.
 */
async function uploadMedia(client, bytes, mime, kind) {
  const prepared = await client.action(api.media.prepareUpload, {
    contentType: mime,
  });
  if (prepared.mode === "cloudinary") {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), "qa-story.png");
    form.append("upload_preset", prepared.uploadPreset);
    const res = await fetch(prepared.uploadUrl, { method: "POST", body: form });
    const data = await res.json();
    if (res.ok && data.public_id) {
      return { url: data.secure_url, key: data.public_id, kind };
    }
    // Resilience, same as the client: a missing/renamed unsigned preset or
    // a quota block falls back to the Convex URL minted alongside it, so
    // the upload still succeeds.
  }
  const fallbackUrl =
    prepared.mode === "cloudinary" ? prepared.fallbackUrl : prepared.uploadUrl;
  const res = await fetch(fallbackUrl, {
    method: "POST",
    headers: { "Content-Type": mime },
    body: new Blob([bytes], { type: mime }),
  });
  const data = await res.json();
  if (!res.ok || !data.storageId) {
    throw new Error("Convex upload failed");
  }
  return { storageId: data.storageId, kind };
}

async function main() {
  console.log(`\nPureWire story-viewer QA (3 accounts) — ${CONVEX_URL}\n`);

  if (!SECRET) {
    console.log(
      "TEST_HARNESS_SECRET is not set. Set it locally to the same value you set in the deployment env.",
    );
    process.exit(2);
  }

  const { enabled } = await client.query(api.testHarness.isEnabled);
  if (!enabled) {
    console.log("The QA harness is disabled on this deployment. Enable it:");
    console.log("  npx convex env set TEST_HARNESS_ENABLED 1");
    console.log("  npx convex env set TEST_HARNESS_SECRET <random>");
    console.log("Then re-run this script, and remove both env vars afterwards.");
    process.exit(2);
  }

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const aUser = `qa_sva_${stamp}`;
  const v1User = `qa_svv1_${stamp}`;
  const v2User = `qa_svv2_${stamp}`;
  const A = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Story Author",
    username: aUser,
    secret: SECRET,
  });
  const V1 = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Viewer One",
    username: v1User,
    secret: SECRET,
  });
  const V2 = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Viewer Two",
    username: v2User,
    secret: SECRET,
  });
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check(
    "created author + two viewer accounts and an admin session",
    !!(A && V1 && V2 && admin),
  );

  // Backend-verified device gate: bind the minted admin session to the IP
  // the backend observes, or the admin-gated calls below are refused.
  await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: admin.token });

  const cleanup = async () => {
    // Full erasure sweep (posts, comments, stories, follows, files…) so a
    // crashed run never leaves test rows behind.
    client.setAuth(admin.token);
    for (const u of [A, V1, V2]) {
      if (!u) continue;
      try {
        await client.mutation(api.admin.removeAccount, {
          userId: u.userId,
          standardId: "no-ai-content",
          note: "QA cleanup",
        });
      } catch {
        /* already gone */
      }
    }
  };

  try {
    // ── 1. Author posts a clean story ───────────────────────────────────
    client.setAuth(A.token);
    const media = await uploadMedia(client, PNG_1X1, "image/png", "image");
    check(
      "author uploaded a tiny clean PNG",
      media.storageId !== undefined || media.url !== undefined,
    );

    const storyRes = await client.action(api.stories.createStory, {
      media,
      caption: `Story from the 3-account QA — ${stamp}`,
      aiMediaStatus: "clean",
    });
    const storyId = storyRes.ok === true ? storyRes.storyId : null;
    check("author posted a clean story", storyRes.ok === true && !!storyId);

    const pag = { numItems: 50, cursor: null };
    const viewersOf = (token) => {
      client.setAuth(token);
      return client.query(api.stories.listStoryViewers, {
        storyId,
        paginationOpts: pag,
      });
    };

    // ── 2. Two viewers look, newest-first ordering ─────────────────────
    client.setAuth(V1.token);
    await client.mutation(api.stories.recordStoryView, { storyId });
    // Space the views out so viewedAt is strictly increasing (ms precision).
    await sleep(1300);
    client.setAuth(V2.token);
    await client.mutation(api.stories.recordStoryView, { storyId });

    const both = await viewersOf(A.token);
    check(
      "author sees BOTH viewers on their own story",
      both.page.length === 2 &&
        [both.page[0].username, both.page[1].username].includes(v1User) &&
        [both.page[0].username, both.page[1].username].includes(v2User),
      `got ${both.page.map((v) => v.username).join(", ") || "nobody"}`,
    );
    check(
      "viewers are sorted newest-first (V2 above V1)",
      both.page[0].username === v2User &&
        both.page[1].username === v1User &&
        both.page[0].viewedAt > both.page[1].viewedAt,
      `order=${both.page.map((v) => v.username).join(" > ")}`,
    );

    // ── 3. Re-view dedupes to one row and bubbles to the top ───────────
    client.setAuth(V1.token);
    await client.mutation(api.stories.recordStoryView, { storyId });
    await sleep(1300);
    const afterReView = await viewersOf(A.token);
    check(
      "re-view dedupes — still exactly two viewer rows",
      afterReView.page.length === 2 &&
        afterReView.page[0].username === v1User &&
        afterReView.page[1].username === v2User,
      `got ${afterReView.page.map((v) => v.username).join(", ") || "nobody"}`,
    );
    check(
      "the re-viewing viewer bubbles to the top with a newer viewedAt",
      afterReView.page[0].username === v1User &&
        afterReView.page[0].viewedAt > both.page[0].viewedAt,
    );

    // ── 4. Privacy: a non-author never sees the list ───────────────────
    const privacy1 = await viewersOf(V1.token);
    check(
      "viewer 1 gets an empty list as a non-author",
      privacy1.page.length === 0 && privacy1.isDone === true,
    );
    const privacy2 = await viewersOf(V2.token);
    check(
      "viewer 2 gets an empty list as a non-author",
      privacy2.page.length === 0 && privacy2.isDone === true,
    );
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
