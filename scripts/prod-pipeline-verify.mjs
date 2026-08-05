#!/usr/bin/env node
/**
 * PureWire production pipeline verification.
 *
 * Repeatable end-to-end check of the two privacy guarantees against a real
 * deployment:
 *
 *  --backend        Salted-hash + server-side video strip.
 *                   - Mints a session for an existing email-bearing account
 *                     (VERIFY_EMAIL, default pwtestuser@example.com) and
 *                     reads its own record: emailHash must be a 64-char hex
 *                     string, emailHashVersion must be 1, maskedEmail must
 *                     be the masked form, no plaintext `email` field may
 *                     leave the server, and the hash must not equal plain
 *                     sha256 of the address (proving it is salted).
 *                   - Mints a throwaway user, uploads a crafted MP4 that
 *                     carries GPS (©xyz), camera (©mak/©mod) and vendor
 *                     (udta/meta/uuid) atoms, runs the live
 *                     stripVideoMetadata action, then reads the stored
 *                     blob back through a real post: the atoms must be
 *                     gone, the media payload intact, and the post must
 *                     record stripped: true.
 *
 *  --create-user    Mint a throwaway account and print TOKEN=<jwt> plus
 *                   USERNAME=<name> for the browser photo phase (the EXIF
 *                   strip for photos runs in the browser, so the real
 *                   composer must upload it).
 *
 *  --mint-email <email>
 *                   Mint a session for an existing email-bearing account
 *                   and print TOKEN=<jwt> — used to drive the browser into
 *                   Settings/Privacy as a real account.
 *
 *  --verify-photo <token> <stamp>
 *                   Find the post whose content contains <stamp>, fetch the
 *                   stored media blob through a signed URL, and assert it
 *                   contains no EXIF/GPS markers and the post records
 *                   stripped: true. Deletes the throwaway account at the end.
 *
 * The harness (convex/testHarness.ts) mints real auth sessions and refuses
 * to run unless the deployment env has TEST_HARNESS_ENABLED=1 AND the
 * caller proves TEST_HARNESS_SECRET. To run:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/prod-pipeline-verify.mjs --backend
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Overrides: CONVEX_URL (default: the production deployment), TEST_HARNESS_SECRET.
 * Exit codes: 0 all checks passed, 1 a check failed, 2 harness disabled.
 */
import { createHash } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { powProof } from "./lib/qa-pow.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SECRET = process.env.TEST_HARNESS_SECRET;
const VERIFY_EMAIL = process.env.VERIFY_EMAIL ?? "pwtestuser@example.com";
const client = new ConvexHttpClient(CONVEX_URL);

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

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ── MP4 box builders (mirror video-privacy-qa.mjs) ─────────────────────────
function box(type, payload) {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(8 + payload.length, 0);
  buf.write(type, 4, "latin1");
  payload.copy(buf, 8);
  return buf;
}

const concat = (...parts) => Buffer.concat(parts);

function hasType(buf, type) {
  const needle = Buffer.from(type, "latin1");
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.subarray(i + 4, i + 8).equals(needle)) return true;
  }
  return false;
}

function countMarker(buf, byte) {
  let n = 0;
  for (const b of buf) if (b === byte) n++;
  return n;
}

/** A dirty MP4: GPS + camera + vendor metadata atoms around a media payload. */
function dirtyMp4() {
  const gpsBox = box("\u00a9xyz", Buffer.from("40.7128-74.0060"));
  const makeBox = box("\u00a9mak", Buffer.from("Pixel 8 Pro"));
  const modelBox = box("\u00a9mod", Buffer.from("Pixel 8 Pro"));
  const udta = box("udta", gpsBox);
  const meta = box("meta", concat(makeBox, modelBox));
  const uuid = box("uuid", Buffer.alloc(16, 0x5a));
  const mdatPayload = Buffer.alloc(256, 0xab);
  return {
    bytes: concat(
      box("ftyp", Buffer.from("isom")),
      box("mdat", mdatPayload),
      box("moov", concat(udta, meta, uuid)),
    ),
    mdatLen: mdatPayload.length,
  };
}

async function requireHarness() {
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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pag = { numItems: 20, cursor: null };

/** Fetch a signed storage URL and return its bytes. */
async function fetchBlob(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Blob fetch failed: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** ── Backend: salted hash + live server-side video strip ─────────────────── */
async function backendChecks() {
  console.log(`\nPureWire production pipeline — backend checks (${CONVEX_URL})\n`);

  // 1. Salted hash on an existing email-bearing record.
  const account = await client.mutation(api.testHarness.mintSessionForEmail, {
    email: VERIFY_EMAIL,
    secret: SECRET,
  });
  check("minted a real session for the email account", !!(account && account.token));
  client.setAuth(account.token);
  const me = await client.query(api.users.getCurrentUser);
  check("profile loads with the session", me !== null);
  if (me !== null) {
    check(
      "emailHash is a 64-char hex string",
      typeof me.emailHash === "string" && /^[0-9a-f]{64}$/.test(me.emailHash),
      typeof me.emailHash === "string" ? me.emailHash : "missing",
    );
    check("emailHashVersion is 1", me.emailHashVersion === 1);
    check(
      "maskedEmail is masked",
      typeof me.maskedEmail === "string" &&
        me.maskedEmail.includes("\u2022\u2022\u2022\u2022") &&
        me.maskedEmail.includes("@"),
      String(me.maskedEmail),
    );
    check(
      "no plaintext email field leaves the server",
      !("email" in me),
    );
    check(
      "hash differs from plain sha256(email) — it is salted",
      me.emailHash !== sha256(VERIFY_EMAIL),
    );
  }
  client.clearAuth();

  // 2. Server-side video remux, live.
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const user = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Pipeline",
    username: `qa_pipeline_${stamp}`,
    secret: SECRET,
  });
  check("created a throwaway pipeline account", !!(user && user.token));
  client.setAuth(user.token);
  let erased = false;
  try {
    const { bytes, mdatLen } = dirtyMp4();
    const dirty = Buffer.from(bytes);
    check("dirty fixture carries GPS and device atoms", hasType(dirty, "\u00a9xyz") && hasType(dirty, "udta"));

    const uploadUrl = await client.mutation(api.media.generateUploadUrl);
    const up = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: new Blob([dirty], { type: "video/mp4" }),
    });
    check("uploaded the dirty MP4", up.ok);
    const { storageId } = (await up.json()) || {};
    check("upload returned a storage id", typeof storageId === "string");

    const cleaned = await client.action(api.media.stripVideoMetadata, {
      media: [{ storageId, kind: "video", stripped: false }],
    });
    check("strip action returned cleaned media", Array.isArray(cleaned) && cleaned.length === 1);
    const cleanedItem = Array.isArray(cleaned) ? cleaned[0] : null;
    check("strip marked the item stripped", cleanedItem?.stripped === true);
    check(
      "strip replaced the storage id",
      typeof cleanedItem?.storageId === "string" && cleanedItem.storageId !== storageId,
    );

    // Store the cleaned clip through a real post, then read it back.
    const post = await client.action(api.posts.createPost, {
      content: `Pipeline check video ${stamp}`,
      media: [{ storageId: cleanedItem.storageId, kind: "video", stripped: true }],
      aiMediaStatus: "clean",
      ...(await powProof(client))});
    check("posted the cleaned clip", post.ok === true);
    let fetched = null;
    for (let i = 0; i < 20; i++) {
      fetched = await client.query(api.posts.getPost, { postId: post.postId });
      if (fetched && fetched.mediaUrls?.length > 0) break;
      await sleep(400);
    }
    check("post is readable with its media", fetched !== null && fetched.mediaUrls?.length === 1);
    if (fetched?.mediaUrls?.length === 1) {
      const stored = await fetchBlob(fetched.mediaUrls[0].url);
      check("stored blob has no GPS ©xyz atom", !hasType(stored, "\u00a9xyz"));
      check("stored blob has no camera ©mak atom", !hasType(stored, "\u00a9mak"));
      check("stored blob has no camera ©mod atom", !hasType(stored, "\u00a9mod"));
      check("stored blob has no udta box", !hasType(stored, "udta"));
      check("stored blob has no meta box", !hasType(stored, "meta"));
      check("stored blob has no uuid box", !hasType(stored, "uuid"));
      check("media payload survived the remux", countMarker(stored, 0xab) === mdatLen);
      check("post records stripped: true", fetched.media?.[0]?.stripped === true);
    }
  } finally {
    // Cleanup: erase the throwaway account (and its post + file) on every
    // exit path — success or a thrown check — so a failed run never
    // orphans data. erased reflects whether the erase itself succeeded.
    try {
      await client.mutation(api.account.deleteAccount);
      erased = true;
    } catch {
      // Already erased or session gone.
    }
    client.clearAuth();
  }
  check("throwaway account erased", erased);
}

/** ── Mint a session for the browser photo phase ──────────────────────────── */
async function createUser() {
  await requireHarness();
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const user = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Photo",
    username: `qa_photo_${stamp}`,
    secret: SECRET,
  });
  console.log(`TOKEN=${user.token}`);
  console.log(`USERNAME=${user.username}`);
}

/** ── Verify the browser-uploaded photo, then erase the account ───────────── */
async function verifyPhoto(token, contentStamp) {
  client.setAuth(token);
  let erased = false;
  try {
    const me = await client.query(api.users.getCurrentUser);
    check("session resolves to the photo account", me !== null);

    let found = null;
    for (let i = 0; i < 20 && me !== null; i++) {
      const posts = await client.query(api.posts.listUserPosts, {
        userId: me._id,
        paginationOpts: pag,
      });
      found = posts.page.find((p) => (p.content ?? "").includes(contentStamp)) ?? null;
      if (found !== null) break;
      await sleep(400);
    }
    check("posted photo found by content stamp", found !== null);
    if (found !== null) {
      check("post records stripped: true", found.media?.[0]?.stripped === true);
      if (found.mediaUrls?.length === 1) {
        const stored = await fetchBlob(found.mediaUrls[0].url);
        const latin1 = stored.toString("latin1").toLowerCase();
        check("stored blob has no EXIF APP1 marker", !latin1.includes("exif\0\0"));
        check("stored blob has no GPS coordinates", !latin1.includes("40.7128"));
        check("stored blob has no sentinel", !latin1.includes("pwgps"));
      }
    }
  } finally {
    // Erase the throwaway account on every exit path — success or a thrown
    // check — so a failed run never leaves test data (or its uploaded
    // file) behind. erased reflects whether the erase itself succeeded.
    try {
      await client.mutation(api.account.deleteAccount);
      erased = true;
    } catch {
      // Already erased or session gone.
    }
    client.clearAuth();
  }
  check("throwaway photo account erased", erased);
}

async function main() {
  const mode = process.argv[2] ?? "--backend";
  await requireHarness();
  try {
    if (mode === "--backend") {
      await backendChecks();
    } else if (mode === "--create-user") {
      await createUser();
      return; // informational mode — no pass/fail summary
    } else if (mode === "--mint-email") {
      const email = process.argv[3] ?? VERIFY_EMAIL;
      const session = await client.mutation(api.testHarness.mintSessionForEmail, {
        email,
        secret: SECRET,
      });
      console.log(`TOKEN=${session.token}`);
      return; // informational mode — no pass/fail summary
    } else if (mode === "--verify-photo") {
      const token = process.argv[3];
      const contentStamp = process.argv[4];
      if (!token || !contentStamp) {
        console.log("Usage: node scripts/prod-pipeline-verify.mjs --verify-photo <token> <stamp>");
        process.exit(1);
      }
      await verifyPhoto(token, contentStamp);
    } else {
      console.log(`Unknown mode: ${mode}`);
      process.exit(1);
    }
  } finally {
    client.clearAuth();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nPipeline check crashed:", e);
  process.exit(1);
});
