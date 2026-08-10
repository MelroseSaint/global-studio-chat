#!/usr/bin/env node
/**
 * PureWire adult-content policy QA check.
 *
 * Proves the sexual-solicitation detection layer works end-to-end:
 * solicitation-flagged posts, comments, bios, and stories are rejected
 * by the live deployment, while innocent text passes. Also verifies the
 * circumvention normalization defeats zero-width chars, repeated
 * characters, and separator insertion.
 *
 * Harness-gated (TEST_HARNESS_SECRET). To run:
 *
 *   TEST_HARNESS_SECRET=<secret> node scripts/adult-content-qa.mjs
 *
 * Overrides: CONVEX_URL.
 */

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { powProof } from "./lib/qa-pow.mjs";

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
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

if (!SECRET) {
  console.log("TEST_HARNESS_SECRET not set — harness disabled, skipping.");
  process.exit(0);
}

/** Pause between writes to stay under the per-minute post budget. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a post with retry on the activity-budget throttle — the admin
 * account's post budget is shared with any concurrently running health
 * check, so a burst of QA posts can hit the 30/hour cap mid-run. Retry
 * with backoff instead of failing the whole QA on transient contention.
 */
async function createPostWithRetry(args, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    const proof = await powProof(client);
    const r = await client.action(api.posts.createPost, { ...args, ...proof });
    if (r?.ok === false && /too fast/i.test(r.error ?? "")) {
      await sleep(15_000); // brief backoff; budget frees as the window rolls
      continue;
    }
    return r;
  }
  return null;
}

/**
 * Upload a tiny PNG the way the real client does — prepareUpload hands
 * out a ticket in either mode (Cloudinary primary, Convex fallback).
 * Returns the media object createStory accepts.
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

// A 1x1 transparent PNG (the smallest thing createStory accepts).
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function main() {
  console.log("\nAdult-content policy QA\n");

  // ── Mint admin session and auth the client ────────────────
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check("minted admin session", !!admin && !!admin.token, admin?.error ?? "");
  if (!admin || !admin.token) {
    console.error("Cannot proceed without an admin session.");
    process.exit(1);
  }
  client.setAuth(admin.token);

  const stamp = `qa-adult-${Date.now().toString(36)}`;

  // Every solicitation check uses a FRESH test user: a blocked attempt
  // escalates the account, and after enough strikes the account is
  // sandboxed — and sandboxed accounts SKIP scanning, silently accepting
  // posts (the exact failure mode this QA guards against). A new user per
  // check keeps each verdict honest.
  const createdUsers = [];
  const freshUser = async (tag) => {
    const u = await client.mutation(api.testHarness.createTestUser, {
      name: `QA Adult ${tag}`,
      username: `qa_adult_${tag}_${Date.now().toString(36)}`,
      secret: SECRET,
    });
    createdUsers.push(u.userId);
    client.setAuth(u.token);
    return u;
  };
  let currentUser = await freshUser("a");
  check("created a fresh test user", !!currentUser && !!currentUser.token);
  if (!currentUser || !currentUser.token) {
    console.error("Cannot proceed without a test user.");
    process.exit(1);
  }

  // ── Solicitation-blocked post ─────────────────────────────
  console.log("\n— Post-level solicitation rejection —");
  {
    await freshUser("solicit");
    const r = await createPostWithRetry({
      creatorDisclosure: "human-made",
      content: `escort service available in ${stamp}`,
    });
    check(
      "post with solicitation phrase is rejected",
      r?.ok === false,
      r?.error ?? "unexpected ok",
    );
    check(
      "rejection message mentions solicitation",
      !!(r && r.ok === false && /solicit/i.test(r.error ?? "")),
      r?.error,
    );
  }

  // ── Clean post passes ─────────────────────────────────────
  let cleanPostId = null;
  {
    await freshUser("clean");
    const r = await createPostWithRetry({
      creatorDisclosure: "human-made",
      content: `Just a normal post about ${stamp} — nothing flagged here.`,
    });
    check("clean post is allowed", r?.ok === true, r?.error ?? "");
    cleanPostId = r?.ok ? r.postId : null;
    check("clean post has an id", cleanPostId !== null);
  }

  // ── Circumvention: zero-width chars ───────────────────────
  {
    await freshUser("zerow");
    const obfuscated = `esc\u200Bort ser\u200Cvice in ${stamp}`;
    const r = await createPostWithRetry({
      creatorDisclosure: "human-made",
      content: obfuscated,
    });
    check(
      "zero-width-char obfuscation is caught",
      r?.ok === false,
      r?.error ?? "unexpected ok — zero-width chars bypassed filter",
    );
  }

  // ── Circumvention: repeated characters ────────────────────
  {
    await freshUser("rept");
    const obfuscated = `eeeesssscccooorrrtttt sssseerrrvvviiiccceee in ${stamp}`;
    const r = await createPostWithRetry({
      creatorDisclosure: "human-made",
      content: obfuscated,
    });
    check(
      "repeated-char obfuscation is caught",
      r?.ok === false,
      r?.error ?? "unexpected ok — repeated chars bypassed filter",
    );
  }

  // ── Circumvention: separator insertion ────────────────────
  {
    await freshUser("dotted");
    const obfuscated = `e.s.c.o.r.t s.e.r.v.i.c.e in ${stamp}`;
    const r = await createPostWithRetry({
      creatorDisclosure: "human-made",
      content: obfuscated,
    });
    check(
      "dot-separator obfuscation is caught",
      r?.ok === false,
      r?.error ?? "unexpected ok — separators bypassed filter",
    );
  }

  // ── Innocent word NOT flagged ─────────────────────────────
  {
    await freshUser("verb");
    const r = await createPostWithRetry({
      creatorDisclosure: "human-made",
      content: `I'm escorting my friend to the airport — ${stamp}`,
    });
    check(
      "word 'escorting' (verb, not solicitation) is NOT flagged",
      r?.ok === true,
      r?.error ?? "",
    );
    if (r?.ok && r.postId) {
      await client.mutation(api.posts.deletePost, { postId: r.postId });
    }
  }

  // ── Comment solicitation ──────────────────────────────────
  console.log("\n— Comment-level solicitation rejection —");
  if (cleanPostId) {
    await freshUser("cmt");
    const commentProof = await powProof(client);
    const c = await client.mutation(api.posts.addComment, {
      postId: cleanPostId,
      content: `dm for rates in ${stamp}`,
      ...commentProof,
    });
    check(
      "comment with solicitation is rejected",
      c?.ok === false,
      c?.error ?? "unexpected ok",
    );
  } else {
    check("comment solicitation test", false, "no clean post to comment on");
  }

  // ── Bio solicitation ──────────────────────────────────────
  console.log("\n— Bio solicitation rejection —");
  {
    client.setAuth(admin.token);
    const r = await client.mutation(api.users.updateProfile, {
      bio: `onlyfans in bio — ${stamp}`,
    });
    check(
      "bio with solicitation is rejected",
      r?.ok === false,
      r?.error ?? "unexpected ok",
    );
    await freshUser("after-bio");
  }

  // ── Story solicitation ────────────────────────────────────
  console.log("\n— Story solicitation rejection —");
  {
    await freshUser("story");
    // Upload a tiny clean PNG so the action accepts the media (the scan
    // gate runs on the caption BEFORE the story becomes visible).
    let media = null;
    try {
      media = await uploadMedia(client, PNG_1X1, "image/png", "image");
      check(
        "uploaded a tiny PNG for the story test",
        media !== null && (media.storageId !== undefined || media.url !== undefined),
      );
    } catch (e) {
      check("uploaded a tiny PNG for the story test", false, e.message);
    }
    if (media) {
      // createStory's args don't include PoW fields — passing them would
      // fail action validation. The caption gate runs in the internal
      // mutation after the media scan.
      const r = await client.action(api.stories.createStory, {
        media,
        caption: `sex for money in ${stamp}`,
        aiMediaStatus: "clean",
      });
      check(
        "story with solicitation caption is rejected",
        r?.ok === false,
        r?.error ?? "unexpected ok",
      );
    }
  }

  // ── Cleanup (best-effort — a cleanup failure must not red the QA) ───
  try {
    if (cleanPostId) {
      await client.mutation(api.posts.deletePost, { postId: cleanPostId });
    }
    client.setAuth(admin.token);
    for (const uid of createdUsers) {
      try {
        await client.mutation(api.testHarness.deleteTestUser, {
          userId: uid,
          secret: SECRET,
        });
      } catch {
        // Best-effort: the nightly sweep erases any straggler qa_ users.
      }
    }
  } catch {
    // Never fail the QA on cleanup.
  }

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("QA crashed:", err);
  process.exit(1);
});
