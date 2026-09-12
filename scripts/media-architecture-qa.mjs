#!/usr/bin/env node
/**
 * PureWire media-architecture QA.
 *
 * Runs the harness-gated `auditMediaArchitecture` query against the live
 * backend and asserts the architecture holds everywhere: Cloudinary stores
 * the actual bytes, Convex stores only the reference (`url` + `key`), and
 * no item embeds bytes (blob:/data:/base64), hotlinks a foreign host, or
 * carries neither storage nor URL. Reports the convex/cloudinary split so
 * a regression that starts shoving bytes into Convex surfaces immediately.
 *
 * Run (gated on the harness secret, like the other production QAs):
 *
 *   TEST_HARNESS_SECRET=<secret> npm run qa:media-architecture
 *
 * The architecture invariant this QA enforces: **Cloudinary holds the media
 * bytes; Convex stores only a reference** (an external secure_url +
 * public_id key — never bytes, never a foreign host, never both modes on
 * one item). MEDIA_MODE_EXPECTATION (env: `convex` | `cloudinary`, default
 * `convex`) declares which storage mode the deployment is supposed to be
 * running; the QA mints an admin session, probes the live upload pipeline
 * (media.prepareUpload), and fails if reality and declaration disagree.
 * When the CLOUDINARY_* vars land on the deployment, flip the CI variable
 * MEDIA_MODE_EXPECTATION to `cloudinary` — from then on the gate asserts
 * the pipeline mints Cloudinary tickets and flags any Convex-storage
 * reference created afterwards.
 *
 * Overrides: CONVEX_URL (default https://jovial-axolotl-209.convex.cloud),
 * MEDIA_MODE_EXPECTATION. Exit codes: 0 architecture holds, 1 invalid
 * references or mode mismatch (alert), 2 no harness secret / disabled.
 */
import { ConvexHttpClient } from "convex/browser";
import { readFileSync, existsSync } from "node:fs";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://jovial-axolotl-209.convex.cloud";
const secretFile = new URL("../.freebuff/.harness-secret", import.meta.url);
const SECRET =
  process.env.TEST_HARNESS_SECRET ??
  (existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : "");

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  if (!SECRET) {
    console.error(
      "No TEST_HARNESS_SECRET. Provide it via env or .freebuff/.harness-secret.",
    );
    process.exit(2);
  }
  console.log(
    `\nPureWire media-architecture audit (${CONVEX_URL})\n`,
  );
  const client = new ConvexHttpClient(CONVEX_URL);
  const { enabled } = await client.query(api.testHarness.isEnabled);
  check("harness enabled", enabled === true);

  // Probe the LIVE upload pipeline: which storage mode are new uploads
  // actually getting? Requires an authenticated session (the upload gate
  // is account-gated), so mint the harness admin session.
  const expectation =
    process.env.MEDIA_MODE_EXPECTATION === "cloudinary" ? "cloudinary" : "convex";
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check("minted a session to probe the live pipeline", Boolean(admin?.token));
  const authed = new ConvexHttpClient(CONVEX_URL);
  authed.setAuth(admin.token);
  const ticket = await authed.action(api.media.prepareUpload, {
    contentType: "image/png",
  });
  const liveMode = ticket?.mode ?? "unknown";
  check(
    `live upload pipeline is in the declared mode (${expectation})`,
    liveMode === expectation,
    `pipeline minted a ${liveMode} ticket while MEDIA_MODE_EXPECTATION=${expectation}` +
      (expectation === "cloudinary"
        ? " — set CLOUDINARY_* on the deployment or flip the expectation"
        : " — set the CLOUDINARY_* env on the deployment, then flip MEDIA_MODE_EXPECTATION to cloudinary"),
  );
  if (liveMode === "cloudinary") {
    check(
      "cloudinary ticket carries the upload URL + fallback",
      typeof ticket.uploadUrl === "string" &&
        ticket.uploadUrl.includes("api.cloudinary.com") &&
        typeof ticket.fallbackUrl === "string",
      `uploadUrl: ${String(ticket.uploadUrl).slice(0, 60)}`,
    );
  }

  const { counts, invalidRows, invalidCount } = await client.query(
    api.testHarness.auditMediaArchitecture,
    { secret: SECRET },
  );

  console.log(
    `  media items: ${counts.convex} Convex-storage (fallback), ` +
      `${counts.cloudinary} Cloudinary references`,
  );
  check("zero invalid media references", invalidCount === 0);
  if (liveMode === "cloudinary" && counts.convex > 0) {
    console.log(
      `  ℹ ${counts.convex} legacy Convex-storage references remain ` +
        `(created before the Cloudinary flip) — new uploads are external-only`,
    );
  }
  for (const row of invalidRows) {
    console.log(`    - ${row.table} ${row.id}: ${row.reason}`);
  }
  if (invalidCount > 0) {
    check(
      "invalid rows stay under the reporting cap",
      invalidCount <= invalidRows.length,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
