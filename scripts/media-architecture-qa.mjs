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
 * Overrides: CONVEX_URL (default https://outgoing-seal-727.convex.cloud).
 * Exit codes: 0 architecture holds, 1 invalid references found (alert),
 * 2 no harness secret / harness disabled.
 */
import { ConvexHttpClient } from "convex/browser";
import { readFileSync, existsSync } from "node:fs";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
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

  const { counts, invalidRows, invalidCount } = await client.query(
    api.testHarness.auditMediaArchitecture,
    { secret: SECRET },
  );

  console.log(
    `  media items: ${counts.convex} Convex-storage (fallback), ` +
      `${counts.cloudinary} Cloudinary references`,
  );
  check("zero invalid media references", invalidCount === 0);
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
