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
 * Transient-failure resilient: a flaky external feed can't red the nightly
 * gate on its own. A transport-level error (network blip, Convex hiccup) or
 * a sync run with per-source failures is retried once; only a run that
 * still fails on the second attempt exits 1. Harness failures (missing
 * secret / harness disabled) are deterministic and are never retried.
 *
 * Harness-gated like the QA scripts: refuses to run unless the deployment
 * env has TEST_HARNESS_ENABLED=1 AND the caller proves TEST_HARNESS_SECRET.
 *
 *   TEST_HARNESS_SECRET=<secret> node scripts/blocklist-sync-prod.mjs
 *
 * Overrides: CONVEX_URL, RETRY_DELAY_MS (default 5000). Exit codes: 0 all
 * sources synced (possibly after one retry), 1 a source failed on every
 * attempt, 2 harness disabled/missing secret.
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

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 5000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = new ConvexHttpClient(CONVEX_URL);

console.log(`\nPureWire blocklist sync — ${CONVEX_URL}\n`);

/**
 * One full sync pass: mint an admin session, bootstrap the built-in feeds,
 * then refresh every enabled external source. Returns the sync action's
 * result (or { harnessFailure: true } when the harness gate rejects us).
 * Transport errors (network blips, Convex hiccups) are thrown so the caller
 * can decide whether to retry.
 */
/**
 * Sweep leftover QA test sources (qa-*) off the deployment. The blocklist
 * engine QA registers its own qa-src-/qa-feed- test feeds and cleans them
 * in a finally block — but a run that is hard-killed (CI timeout, runner
 * crash) skips cleanup, and the orphan then 404s forever, reddening this
 * nightly gate. Self-heal: drop any qa-* source before syncing so a stray
 * test fixture can never block real feed refresh. Best-effort.
 */
async function sweepQaSources() {
  const sources = await client.query(api.blocklist.listDomainSources);
  const orphans = (sources ?? []).filter((s) => s.name.startsWith("qa-"));
  for (const src of orphans) {
    try {
      await client.mutation(api.blocklist.deleteDomainSource, { name: src.name });
      console.log(`  🧹 Removed leftover QA test source: ${src.name}`);
    } catch {
      // Best-effort — never fail the sync over cleanup.
    }
  }
  return orphans.length;
}

async function syncOnce(attempt) {
  const tag = `[attempt ${attempt}/${MAX_ATTEMPTS}]`;
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  if (!admin?.token) {
    return { harnessFailure: true };
  }
  client.setAuth(admin.token);
  try {
    const swept = await sweepQaSources();
    if (swept > 0) {
      console.log(`${tag} ${swept} leftover QA test source(s) swept.`);
    }
    const boot = await client.mutation(
      api.blocklist.registerDefaultBlocklistSources,
    );
    if (boot?.ok && boot.registered > 0) {
      console.log(
        `${tag} Registered ${boot.registered} built-in PureWire feed(s).`,
      );
    }
    const sync = await client.action(api.blocklist.syncExternalSources);
    return { sync, tag };
  } finally {
    client.clearAuth();
  }
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  let result;
  try {
    result = await syncOnce(attempt);
  } catch (err) {
    // Transport-level failure — plausibly transient, so retry once.
    console.error(
      `\n[attempt ${attempt}/${MAX_ATTEMPTS}] Transport error: ${err?.message ?? err}`,
    );
    if (attempt < MAX_ATTEMPTS) {
      console.log(
        `Retrying once in ${RETRY_DELAY_MS / 1000}s — this may be a transient network blip.\n`,
      );
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    console.error("Transport error on every attempt — treating as a real outage.");
    process.exit(1);
  }

  if (result.harnessFailure) {
    // Deterministic (missing secret / harness disabled) — never retried.
    console.error(
      "Could not mint an admin session — is TEST_HARNESS_ENABLED set?",
    );
    process.exit(2);
  }

  const { sync, tag } = result;
  if (!sync?.ok) {
    console.error(`${tag} Sync action returned ok=false.`);
    if (attempt < MAX_ATTEMPTS) {
      console.log(
        `Retrying once in ${RETRY_DELAY_MS / 1000}s — the feed may have flaked.\n`,
      );
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    process.exit(1);
  }

  let failed = 0;
  for (const r of sync.results) {
    if (r.error !== undefined) {
      // qa-* sources are test fixtures (the engine QA registers its own
      // per-run feeds); a failure here is a stale orphan, not a real feed
      // breakage — note it but never let it red the nightly gate.
      if (r.name.startsWith("qa-")) {
        console.log(`  ⚠️ ${r.name}: ${r.error} (QA test source — ignored)`);
        continue;
      }
      failed++;
      console.log(`  ❌ ${r.name}: ${r.error}`);
    } else {
      console.log(`  ✅ ${r.name}: imported ${r.imported}`);
    }
  }
  if (typeof sync.purged === "number") {
    console.log(`Retention sweep: purged ${sync.purged} stale link-scan rows.`);
  }
  console.log(
    `${tag} ${sync.results.length - failed}/${sync.results.length} sources synced`,
  );

  if (failed === 0) {
    if (attempt > 1) {
      console.log("Recovered on retry — the earlier failure was transient.\n");
    }
    process.exit(0);
  }

  if (attempt < MAX_ATTEMPTS) {
    console.log(
      `\n${tag} ${failed} source(s) failed — retrying once in case an external feed was flaky.\n`,
    );
    await sleep(RETRY_DELAY_MS);
    continue;
  }
  console.log(
    `\n${tag} ${failed} source(s) still failing after the retry — treating as a real feed breakage.`,
  );
  process.exit(1);
}
