#!/usr/bin/env node
/**
 * PureWire email-hash salt-rotation QA check.
 *
 * Verifies the versioned salt scheme in src/convex/privacy.ts: the version-1
 * hash must stay byte-for-byte identical to the legacy `sha256(salt:email)`
 * format (so pre-rotation hashes never need rewriting), different salt
 * versions must produce different hashes for the same address, the active
 * version must default to 1, and each version must read its own env salt.
 *
 * Pure function test — no deployment needed. Run:
 *
 *   npm run qa:salt
 *
 * Exit codes: 0 all checks passed, 1 a check failed.
 */
import { createHash, randomBytes } from "node:crypto";

import {
  currentEmailHashVersion,
  emailHashSaltForVersion,
  saltedEmailHash,
} from "../src/convex/privacy.ts";

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

const legacyHash = (email, salt) =>
  createHash("sha256").update(`${salt}:${email}`).digest("hex");

async function main() {
  console.log("\nPureWire email-hash salt-rotation QA\n");

  const email = "Monroe.Doses+tag@gmail.com";
  const saltV1 = randomBytes(32).toString("hex");
  const saltV2 = randomBytes(32).toString("hex");

  // ── 1. Version 1 keeps the legacy format byte-for-byte ───────────────────
  process.env.EMAIL_HASH_SALT = saltV1;
  delete process.env.EMAIL_HASH_VERSION;
  check("active version defaults to 1", currentEmailHashVersion() === 1);
  const v1 = await saltedEmailHash(email);
  check(
    "v1 hash is byte-identical to legacy sha256(salt:email)",
    v1 === legacyHash(email, saltV1),
  );

  // ── 2. Deterministic and normalized-input safe ───────────────────────────
  const again = await saltedEmailHash(email);
  check("same input + salt → same hash", again === v1);

  // ── 3. A rotated salt produces a different hash ──────────────────────────
  process.env.EMAIL_HASH_SALT_V2 = saltV2;
  process.env.EMAIL_HASH_VERSION = "2";
  check("active version reads EMAIL_HASH_VERSION", currentEmailHashVersion() === 2);
  const v2 = await saltedEmailHash(email, 2);
  check("v2 salt is read from EMAIL_HASH_SALT_V2", emailHashSaltForVersion(2) === saltV2);
  check("same email, rotated salt → different hash", v2 !== v1);
  check(
    "v2 hash still matches its own direct computation",
    v2 === legacyHash(email, saltV2),
  );

  // ── 4. Salt lookup is version-scoped ─────────────────────────────────────
  check("v1 salt comes from EMAIL_HASH_SALT", emailHashSaltForVersion(1) === saltV1);
  check("unset later version degrades like the legacy scheme", emailHashSaltForVersion(3) === "");
  check("defaulted call uses the current active version", (await saltedEmailHash(email)) === v2);

  // ── 5. Garbage version falls back to 1 ───────────────────────────────────
  process.env.EMAIL_HASH_VERSION = "not-a-number";
  check("invalid EMAIL_HASH_VERSION falls back to 1", currentEmailHashVersion() === 1);

  // Clean up so the script is re-runnable in-process.
  delete process.env.EMAIL_HASH_SALT;
  delete process.env.EMAIL_HASH_SALT_V2;
  delete process.env.EMAIL_HASH_VERSION;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nQA run crashed:", e);
  process.exit(1);
});
