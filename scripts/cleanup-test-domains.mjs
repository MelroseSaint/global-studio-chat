#!/usr/bin/env node
/**
 * PureWire test-domain cleanup.
 *
 * Sweeps every QA/test artefact out of the production blocklist tables so
 * the enforcement list contains ONLY the real platform domains (the
 * adult-platform feeds + anything an admin added manually):
 *
 *   - blockedDomains:    any row whose TLD is `.test` (the QA uses
 *                        qa-bl-*.test, qa-routing-feed.test, and IDN
 *                        täst-*.test — the punycode forms still end in
 *                        .test) or whose source starts with `qa-`
 *   - blockedUrlPatterns: any pattern containing `qa-` (qa-pat-*)
 *   - domainSources:      any source named `qa-*` (qa-src-*, qa-feed-*)
 *
 * The QA scripts already self-clean, but interrupted runs and the IDN
 * test domains (written with source "manual") can leak, so this is the
 * manual/CI belt-and-braces sweep.
 *
 * Same harness gate as the other QA scripts: TEST_HARNESS_ENABLED=1 and a
 * matching TEST_HARNESS_SECRET must be set on the deployment.
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/cleanup-test-domains.mjs
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Overrides: CONVEX_URL, TEST_HARNESS_SECRET. Exit codes: 0 swept (or
 * nothing to do), 2 harness disabled / fatal.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SECRET = process.env.TEST_HARNESS_SECRET;
const client = new ConvexHttpClient(CONVEX_URL);

const isTestDomain = (d) =>
  d.endsWith(".test") || /\.test$/.test(d) || d.split(".").pop() === "test";

async function main() {
  console.log(`\nPureWire test-domain cleanup — ${CONVEX_URL}\n`);

  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  if (!admin?.token) throw new Error("failed to mint admin session");
  client.setAuth(admin.token);

  let domains = 0;
  let patterns = 0;
  let sources = 0;

  // ── 1. blockedDomains: sweep every page ────────────────────────────────
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const page = await client.query(api.blocklist.listBlockedDomains, {
      paginationOpts: { numItems: 200, cursor },
    });
    for (const row of page.page) {
      if (isTestDomain(row.domain) || row.source?.startsWith("qa-")) {
        await client
          .mutation(api.blocklist.deleteBlockedDomain, { domain: row.domain })
          .catch(() => {});
        console.log(`  🗑  domain  ${row.domain}  (source: ${row.source})`);
        domains++;
      }
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  // ── 2. blockedUrlPatterns: qa-* patterns ───────────────────────────────
  const patternList = await client.query(api.blocklist.listBlockedPatterns);
  for (const p of patternList ?? []) {
    if (p.pattern.includes("qa-")) {
      await client
        .mutation(api.blocklist.deleteBlockedPattern, { pattern: p.pattern })
        .catch(() => {});
      console.log(`  🗑  pattern ${p.pattern}`);
      patterns++;
    }
  }

  // ── 3. domainSources: qa-* sources ─────────────────────────────────────
  const sourceList = await client.query(api.blocklist.listDomainSources);
  for (const s of sourceList ?? []) {
    if (s.name.startsWith("qa-")) {
      await client
        .mutation(api.blocklist.deleteDomainSource, { name: s.name })
        .catch(() => {});
      console.log(`  🗑  source  ${s.name}`);
      sources++;
    }
  }

  console.log(
    `\nRemoved ${domains} domain(s), ${patterns} pattern(s), ${sources} source(s).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/harness|secret|disabled/i.test(msg)) {
      console.error("Cleanup aborted:", msg);
      process.exit(2);
    }
    console.error("FATAL:", err);
    process.exit(2);
  });
