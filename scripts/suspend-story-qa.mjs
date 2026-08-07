/**
 * PureWire production QA — time-limited suspension + story viewer lists.
 *
 * Verifies the two features end-to-end against a live deployment:
 *
 *   1. Story viewers — a viewer opens an author's story (recordStoryView),
 *      the author sees exactly that viewer (listStoryViewers), a
 *      non-author gets an empty list, and re-views dedupe to one row.
 *   2. Suspension — an admin suspends the author for 1 hour with a reason
 *      and a cited Standard principle: the account flips to "restricted"
 *      with suspendedUntil set, the audit trail records the "suspend"
 *      action with the reason, the member receives a system notification,
 *      and the suspended account can no longer post. A reinstate then
 *      returns it to full active with the deadline cleared.
 *
 * Harness-gated exactly like the other QAs — the deployment env must have
 * TEST_HARNESS_ENABLED=1 and the caller must pass TEST_HARNESS_SECRET:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/suspend-story-qa.mjs
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Every throwaway account is erased with the full admin removeAccount
 * sweep in a finally block, so a crash can't leave QA users behind (the
 * nightly cleanup-test-users job is the belt-and-suspenders).
 *
 * Overrides: CONVEX_URL (default: the production deployment),
 * TEST_HARNESS_SECRET.
 */

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { powProof } from "./lib/qa-pow.mjs";
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

// A valid PureWire Standard principle id (STANDARD_PRINCIPLES in lib/standard).
const STANDARD = "no-ai-content";

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
  const fallbackUrl = prepared.mode === "cloudinary" ? prepared.fallbackUrl : prepared.uploadUrl;
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
  console.log(`\nPureWire suspension + story-viewers QA — ${CONVEX_URL}\n`);

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
  const aUser = `qa_story_${stamp}`;
  const bUser = `qa_viewer_${stamp}`;
  const A = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Story Author",
    username: aUser,
    secret: SECRET,
  });
  const B = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Viewer",
    username: bUser,
    secret: SECRET,
  });
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check("created author, viewer and admin sessions", !!(A && B && admin));

  // Backend-verified device gate: bind the minted admin session to the
  // backend-observed IP or the admin-gated calls below are refused.
  await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: admin.token });

  const cleanup = async () => {
    // Full erasure sweep (posts, comments, stories, follows, files…) so a
    // crashed run never leaves test rows behind.
    client.setAuth(admin.token);
    for (const u of [A, B]) {
      if (!u) continue;
      try {
        await client.mutation(api.admin.removeAccount, {
          userId: u.userId,
          standardId: STANDARD,
          note: "QA cleanup",
        });
      } catch {
        /* already gone */
      }
    }
  };

  const stateOf = (userId) =>
    client.query(api.testHarness.getTestUserState, {
      userId,
      secret: SECRET,
    });

  try {
    // ── 1. Story viewers ────────────────────────────────────────────────
    client.setAuth(A.token);
    const media = await uploadMedia(client, PNG_1X1, "image/png", "image");
    check("uploaded a tiny clean PNG", media.storageId !== undefined || media.url !== undefined);

    const storyRes = await client.action(api.stories.createStory, {
      media,
      caption: `Story from the QA run — ${stamp}`,
      aiMediaStatus: "clean",
    });
    const storyId = storyRes.ok === true ? storyRes.storyId : null;
    check("author posted a clean story", storyRes.ok === true && !!storyId);

    // Viewer B opens the story — a view row must appear.
    client.setAuth(B.token);
    await client.mutation(api.stories.recordStoryView, { storyId });
    client.setAuth(A.token);
    const pag = { numItems: 50, cursor: null };
    let viewers = await client.query(api.stories.listStoryViewers, {
      storyId,
      paginationOpts: pag,
    });
    check(
      "author sees the viewer on their own story",
      viewers.page.length === 1 && viewers.page[0].username === bUser,
      viewers.page.length === 1
        ? `got ${viewers.page[0].username}`
        : `got ${viewers.page.length} viewers`,
    );

    // A non-author must never see the list — empty, not an error.
    client.setAuth(B.token);
    const otherView = await client.query(api.stories.listStoryViewers, {
      storyId,
      paginationOpts: pag,
    });
    check(
      "a non-author gets an empty viewer list",
      otherView.page.length === 0 && otherView.isDone === true,
    );

    // Re-view dedupes to one row (viewedAt bumps, list stays length 1).
    client.setAuth(B.token);
    await client.mutation(api.stories.recordStoryView, { storyId });
    client.setAuth(A.token);
    const viewers2 = await client.query(api.stories.listStoryViewers, {
      storyId,
      paginationOpts: pag,
    });
    check(
      "re-views dedupe to one viewer row",
      viewers2.page.length === 1 && viewers2.page[0].username === bUser,
    );

    // ── 2. Time-limited suspension ──────────────────────────────────────
    const REASON = `QA suspension — repeat rule violation ${stamp}`;
    const before = await stateOf(A.userId);
    check("author started active", before?.accountStatus === "active");

    client.setAuth(admin.token);
    await client.mutation(api.security.suspendAccount, {
      userId: A.userId,
      durationHours: 1,
      standardId: STANDARD,
      note: REASON,
    });

    const suspended = await stateOf(A.userId);
    const untilOk =
      typeof suspended?.suspendedUntil === "number" &&
      suspended.suspendedUntil > Date.now() &&
      suspended.suspendedUntil <= Date.now() + 2 * 3600_000;
    check(
      "suspended account is restricted with a ~1h deadline",
      suspended?.accountStatus === "restricted" && untilOk,
      `status=${suspended?.accountStatus} until=${suspended?.suspendedUntil}`,
    );

    // Audit trail carries the suspend action with the exact reason.
    const history = await client.query(api.security.silentFlagHistory, {
      userId: A.userId,
    });
    const suspendEntry = history?.actions?.find((a) => a.action === "suspend");
    check(
      "audit trail records the suspension with the reason",
      suspendEntry?.action === "suspend" && suspendEntry?.note === REASON,
    );

    // The member is notified with the reason (honest outcome).
    client.setAuth(A.token);
    const notifRes = await client.query(api.notifications.listNotifications, {
      paginationOpts: pag,
    });
    const suspensionNotif = (notifRes?.page ?? []).find((n) =>
      String(n.message ?? "").includes("has been suspended until"),
    );
    check(
      "suspended member received the system notification",
      !!suspensionNotif && String(suspensionNotif.message).includes(REASON),
    );

    // A suspended account can't post — enforceActive rejects.
    client.setAuth(A.token);
    let blocked = false;
    try {
      await client.action(api.posts.createPost, {
        content: `Should never land — ${stamp}`,
        creatorDisclosure: "human-made",
        ...(await powProof(client)),
      });
    } catch {
      blocked = true;
    }
    check("suspended account cannot post", blocked);

    // ── 3. Reinstate restores fully, clearing the deadline ─────────────
    client.setAuth(admin.token);
    const reinstateReason = `QA reinstate after suspension ${stamp}`;
    await client.mutation(api.security.reinstateAccount, {
      userId: A.userId,
      standardId: STANDARD,
      note: reinstateReason,
    });
    const restored = await stateOf(A.userId);
    check(
      "reinstate returns the account to full active with no deadline",
      restored?.accountStatus === "active" &&
        (restored?.suspendedUntil === null || restored?.suspendedUntil === undefined),
    );

    client.setAuth(A.token);
    const postBack = await client.action(api.posts.createPost, {
      content: `Active again — ${stamp}`,
      creatorDisclosure: "human-made",
      ...(await powProof(client)),
    });
    check("reinstated account can post again", postBack.ok === true);
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
