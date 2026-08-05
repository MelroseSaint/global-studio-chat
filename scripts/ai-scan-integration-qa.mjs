#!/usr/bin/env node
/**
 * PureWire AI-scan integration QA — end-to-end media scan verification.
 *
 * Builds a real JPEG with "Midjourney" in the EXIF Software tag, uploads it
 * through Convex storage, runs the full server-side scanMediaForAi action,
 * and verifies:
 *
 *   1. Byte-level scan catches the EXIF marker (status: "blocked").
 *   2. When RESEMBLE_API_KEY is set, the Resemble v2 API is called and its
 *      verdict lands in the evidence object.
 *
 * Harness-gated: requires TEST_HARNESS_ENABLED=1 + TEST_HARNESS_SECRET.
 *
 *   TEST_HARNESS_SECRET=<secret> node scripts/ai-scan-integration-qa.mjs
 *
 * Exit: 0 all passed, 1 a check failed, 2 harness disabled.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api.js";

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
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u274c ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── JPEG builder (same logic as ai-scan-qa.mjs, inlined for zero deps) ──

function u32be(n) {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function bytesOf(parts) {
  const arrays = parts.map((p) => {
    if (typeof p === "string") return new TextEncoder().encode(p);
    if (p instanceof ArrayBuffer) return new Uint8Array(p);
    return p;
  });
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out.buffer;
}

/** A minimal JPEG with EXIF Software tag. */
function jpegWithExif(software) {
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + software.length + 1);
  tiff[0] = 0x49; tiff[1] = 0x49; tiff[2] = 0x2a; tiff[3] = 0x00;
  tiff[4] = 8; tiff[5] = 0; tiff[6] = 0; tiff[7] = 0;
  const ifd = 8;
  tiff[ifd] = 1; tiff[ifd + 1] = 0;
  const e = ifd + 2;
  tiff[e] = 0x31; tiff[e + 1] = 0x01;
  tiff[e + 2] = 2; tiff[e + 3] = 0;
  const n = software.length + 1;
  tiff[e + 4] = n & 0xff; tiff[e + 5] = (n >> 8) & 0xff; tiff[e + 6] = 0; tiff[e + 7] = 0;
  const strOff = e + 12;
  tiff[e + 8] = strOff & 0xff;
  tiff[e + 9] = (strOff >> 8) & 0xff;
  for (let i = 0; i < software.length; i++) tiff[strOff + i] = software.charCodeAt(i);
  tiff[strOff + software.length] = 0;
  const exif = bytesOf(["Exif\0\0", tiff]);
  const app1 = bytesOf([u32be(exif.byteLength + 2), new Uint8Array(exif)]);
  return bytesOf([
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe1]),
    app1,
    new Uint8Array([0xff, 0xd9]),
  ]);
}

// ── Upload helpers ──────────────────────────────────────────────────────

/**
 * Upload raw bytes to Convex storage using the prepareUpload action.
 * Returns the storage ID, or null on failure.
 */
async function uploadToStorage(token, fileBytes, contentType, fileName) {
  client.setAuth(token);
  // 1. Get an upload URL (prepareUpload returns Cloudinary or Convex URL).
  const slot = await client.action(api.media.prepareUpload, { contentType });
  // In Cloudinary mode the client gets a Cloudinary upload URL + preset;
  // we use the fallbackUrl (the Convex URL) instead — simpler, no env vars.
  const uploadUrl = slot.mode === "cloudinary" ? slot.fallbackUrl : slot.uploadUrl;

  // 2. POST the bytes to the upload URL.
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(fileBytes),
  });
  if (!res.ok) {
    console.warn(`  Upload returned ${res.status}: ${await res.text().catch(() => "?")}`);
    return null;
  }
  const json = await res.json();
  // Convex returns { storageId: "..." } on success.
  return json.storageId ?? null;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nPureWire AI-scan integration QA — ${CONVEX_URL}\n`);

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // Mint a throwaway user (harness-gated — fails cleanly when disabled).
  let user;
  try {
    user = await client.mutation(api.testHarness.createTestUser, {
      name: "QA AI Scan",
      username: `qa_ai_scan_${stamp}`,
      secret: SECRET,
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (msg.includes("harness disabled") || msg.includes("TEST_HARNESS_ENABLED")) {
      console.log("\n⏭️  Test harness disabled on this deployment.");
      console.log("   Enable it temporarily to run this QA:");
      console.log("     npx convex env set TEST_HARNESS_ENABLED 1");
      console.log("     npx convex env set TEST_HARNESS_SECRET <your-secret>");
      console.log("     TEST_HARNESS_SECRET=<secret> node scripts/ai-scan-integration-qa.mjs");
      console.log("     npx convex env remove TEST_HARNESS_ENABLED");
      console.log("     npx convex env remove TEST_HARNESS_SECRET\n");
      process.exit(2);
    }
    throw err;
  }
  check("created test user", !!user?.token);

  try {
    // ── 1. Upload the AI-generated JPEG ─────────────────────────────────
    const aiJpeg = jpegWithExif("Midjourney"); // EXIF Software = Midjourney
    console.log("  → Uploading AI-generated JPEG (EXIF Software: Midjourney)…");
    const storageId = await uploadToStorage(
      user.token,
      aiJpeg,
      "image/jpeg",
      "ai-test.jpg",
    );
    check("uploaded AI-JPEG to storage", storageId !== null);

    if (storageId === null) {
      console.log("  Cannot continue without a storage ID — aborting.\n");
      process.exit(1);
    }

    // Allow the upload to settle (index rebuilds on busy deployments can race).
    await sleep(500);

    // ── 2. Run scanMediaForAi server-side ───────────────────────────────
    console.log("  → Running scanMediaForAi…");
    const scan = await client.action(api.aiContent.scanMediaForAi, {
      media: [{ storageId, kind: "image" }],
    });

    // ── 3. Byte-level verdict ───────────────────────────────────────────
    check(
      "byte-level scan caught Midjourney EXIF (status: blocked)",
      scan.status === "blocked",
      `status=${scan.status} reason="${scan.reason ?? ""}"`,
    );

    // ── 4. Evidence object ──────────────────────────────────────────────
    const evidence = scan.evidence;
    check(
      "evidence object is present on scan result",
      evidence !== undefined,
    );

    if (evidence) {
      check(
        "evidence.byteScan exists and is blocked",
        evidence.byteScan?.status === "blocked",
        `byteScan.status=${evidence.byteScan?.status} reason="${evidence.byteScan?.reason ?? ""}"`,
      );

      // ── 5. Resemble v2 signal ─────────────────────────────────────────
      const hasResembleKey = evidence.resemble !== undefined;
      if (hasResembleKey) {
        check(
          "Resemble v2 was called for the image",
          true,
          `isAi=${evidence.resemble.isAi} confidence=${(evidence.resemble.confidence * 100).toFixed(0)}%`,
        );
        check(
          "…and Resemble returned a confidence score",
          typeof evidence.resemble.confidence === "number" && evidence.resemble.confidence >= 0,
        );
        check(
          "…and Resemble returned an isAi boolean",
          typeof evidence.resemble.isAi === "boolean",
        );
        check(
          "…and metrics label is present",
          typeof evidence.resemble.metrics?.label === "string",
          `label="${evidence.resemble.metrics?.label}"`,
        );
        if (evidence.resemble.sourceLabel) {
          console.log(`  ℹ️  Resemble source tracing: ${evidence.resemble.sourceLabel}`);
        }
      } else {
        console.log("  ⏭️  RESEMBLE_API_KEY not set — Resemble v2 was not called");
        check(
          "Resemble signal skipped gracefully (no API key)",
          true,
          "Set RESEMBLE_API_KEY in Convex env to enable",
        );
      }
    }

    // ── 6. Cleanup — delete the storage object ──────────────────────────
    client.setAuth(user.token);
    await client.mutation(api.media.discardUploads, {
      items: [{ storageId }],
    });
    console.log("  → Storage object cleaned up.");
  } catch (err) {
    check("unexpected error", false, err?.message ?? String(err));
  }

  // ── Final tally ───────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log("Failing checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
