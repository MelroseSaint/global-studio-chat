#!/usr/bin/env node
/**
 * PureWire scheduled blocklist sync.
 *
 * Runs the syncExternalSources action against the production deployment so
 * every enabled external feed (the data/adult/ files, plus any admin-added
 * sources) refreshes on a schedule — the "every 24 hours" stage of the
 * blocklist lifecycle. The action validates, normalizes, dedupes, adds new
 * domains, and deactivates domains that vanished from their feed (see
 * applySyncedDomainsInternal), recording lastVerifiedAt/lastSuccessfulSyncAt
 * for traceability.
 *
 * Harness-gated like the QA scripts: refuses to run unless the deployment
 * env has TEST_HARNESS_ENABLED=1 AND the caller proves TEST_HARNESS_SECRET.
 *
 *   TEST_HARNESS_SECRET=<secret> node scripts/blocklist-sync-prod.mjs
 *
 * Overrides: CONVEX_URL. Exit codes: 0 all sources synced, 1 a source
 * failed, 2 harness disabled/missing secret.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SECRET = process.env.TEST_HARNESS_SECRET;
if (!SECRET) {
  console.error("TEST_HARNESS_SECRET is required (harness-gated).");
  process.exit(2);
}

const client = new ConvexHttpClient(CONVEX_URL);

console.log(`\nPureWire blocklist sync — ${CONVEX_URL}\n`);

const admin = await client.mutation(api.testHarness.mintAdminSession, {
  secret: SECRET,
});
if (!admin?.token) {
  console.error("Could not mint an admin session — is TEST_HARNESS_ENABLED set?");
  process.exit(2);
}

client.setAuth(admin.token);
const sync = await client.action(api.blocklist.syncExternalSources);
client.clearAuth();

if (!sync?.ok) {
  console.error("Sync action returned ok=false.");
  process.exit(1);
}

let failed = 0;
for (const r of sync.results) {
  if (r.error !== undefined) {
    failed++;
    console.log(`  ❌ ${r.name}: ${r.error}`);
  } else {
    console.log(`  ✅ ${r.name}: imported ${r.imported}`);
  }
}

if (typeof sync.purged === "number") {
  console.log(`Retention sweep: purged ${sync.purged} stale link-scan rows.`);
}
console.log(`\n${sync.results.length - failed}/${sync.results.length} sources synced`);
if (failed > 0) {
  process.exit(1);
}
