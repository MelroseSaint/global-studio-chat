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

  // ── Solicitation-blocked post ─────────────────────────────
  console.log("\n— Post-level solicitation rejection —");
  {
    const proof = await powProof(client);
    const r = await client.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: `escort service available in ${stamp}`,
      ...proof,
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
    const proof = await powProof(client);
    const r = await client.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: `Just a normal post about ${stamp} — nothing flagged here.`,
      ...proof,
    });
    check("clean post is allowed", r?.ok === true, r?.error ?? "");
    cleanPostId = r?.ok ? r.postId : null;
    check("clean post has an id", cleanPostId !== null);
  }

  // ── Circumvention: zero-width chars ───────────────────────
  {
    const proof = await powProof(client);
    const obfuscated = `esc\u200Bort ser\u200Cvice in ${stamp}`;
    const r = await client.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: obfuscated,
      ...proof,
    });
    check(
      "zero-width-char obfuscation is caught",
      r?.ok === false,
      r?.error ?? "unexpected ok — zero-width chars bypassed filter",
    );
  }

  // ── Circumvention: repeated characters ────────────────────
  {
    const proof = await powProof(client);
    const obfuscated = `eeeesssscccooorrrtttt sssseerrrvvviiiccceee in ${stamp}`;
    const r = await client.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: obfuscated,
      ...proof,
    });
    check(
      "repeated-char obfuscation is caught",
      r?.ok === false,
      r?.error ?? "unexpected ok — repeated chars bypassed filter",
    );
  }

  // ── Circumvention: separator insertion ────────────────────
  {
    const proof = await powProof(client);
    const obfuscated = `e.s.c.o.r.t s.e.r.v.i.c.e in ${stamp}`;
    const r = await client.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: obfuscated,
      ...proof,
    });
    check(
      "dot-separator obfuscation is caught",
      r?.ok === false,
      r?.error ?? "unexpected ok — separators bypassed filter",
    );
  }

  // ── Innocent word NOT flagged ─────────────────────────────
  {
    const proof = await powProof(client);
    const r = await client.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: `I'm escorting my friend to the airport — ${stamp}`,
      ...proof,
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
    const commentProof = await powProof(client);
    const c = await client.action(api.posts.addComment, {
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
    const r = await client.mutation(api.users.updateProfile, {
      bio: `onlyfans in bio — ${stamp}`,
    });
    check(
      "bio with solicitation is rejected",
      r?.ok === false,
      r?.error ?? "unexpected ok",
    );
  }

  // ── Story solicitation ────────────────────────────────────
  console.log("\n— Story solicitation rejection —");
  {
    const proof = await powProof(client);
    const r = await client.action(api.stories.createStory, {
      caption: `sex for money in ${stamp}`,
      ...proof,
    });
    check(
      "story with solicitation is rejected",
      r?.ok === false,
      r?.error ?? "unexpected ok",
    );
  }

  // ── Cleanup ───────────────────────────────────────────────
  if (cleanPostId) {
    await client.mutation(api.posts.deletePost, { postId: cleanPostId });
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
