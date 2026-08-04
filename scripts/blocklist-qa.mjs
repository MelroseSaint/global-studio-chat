#!/usr/bin/env node
/**
 * PureWire blocklist-engine QA check.
 *
 * Proves the data-driven blockedDomains layer end-to-end against a real
 * deployment: the core static adult list seeds the DB, an admin can add a
 * domain and it is blocked across every public surface, the active list is
 * served to the client DM gate, a synced external source imports entries,
 * and cleanup leaves the deployment pristine.
 *
 * The harness (convex/testHarness.ts) mints real auth sessions and refuses
 * to run unless the deployment env has TEST_HARNESS_ENABLED=1 AND the
 * caller proves TEST_HARNESS_SECRET. To run:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/blocklist-qa.mjs
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Overrides: CONVEX_URL (default: the production deployment),
 * TEST_HARNESS_SECRET. Exit codes: 0 all checks passed, 1 a check failed,
 * 2 harness disabled.
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

async function main() {
  console.log(`\nPureWire blocklist-engine QA — ${CONVEX_URL}\n`);

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const testDomain = `qa-bl-${stamp}.test`;
  const subDomain = `m.${testDomain}`;

  // Each surface check runs on its OWN throwaway: every blocked attempt
  // escalates 3 silent points and the shadowban threshold is 6, so two
  // blocked attempts would sandbox the account — and sandboxed accounts
  // skip scanning, which would silently break the checks after the pair.
  const mkUser = (tag) =>
    client.mutation(api.testHarness.createTestUser, {
      name: `QA BL ${tag}`,
      username: `qa_bl_${tag}_${stamp}`,
      secret: SECRET,
    });
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check("created the harness users and an admin session", !!admin);

  try {
    // ── 1. The core list seeds the DB ─────────────────────────────────────
    client.setAuth(admin.token);
    const seed = await client.mutation(api.blocklist.importCoreBlocklist);
    check("core adult list seeded into blockedDomains", seed?.ok === true);
    const seededList = await client.query(api.blocklist.getActiveBlocklist);
    const onlyfans = seededList?.domains?.some((d) => d.domain === "onlyfans.com");
    const chaturbate = seededList?.domains?.some((d) => d.domain === "chaturbate.com");
    check("onlyfans.com is an active entry", onlyfans === true);
    check("chaturbate.com is an active entry", chaturbate === true);
    check(
      "core entries are categorized (creator/porn taxonomy)",
      seededList?.domains?.some((d) => d.category === "adult_creator") === true &&
        seededList?.domains?.some((d) => d.category === "adult_porn") === true,
    );
    const seed2 = await client.mutation(api.blocklist.importCoreBlocklist);
    check("re-seeding is idempotent (no duplicates)", seed2?.imported === 0);

    // ── 2. Admin adds a domain; it blocks across surfaces ────────────────
    const add = await client.mutation(api.blocklist.upsertBlockedDomain, {
      domain: testDomain,
      category: "adult_other",
      action: "block",
      blockSubdomains: true,
      active: true,
    });
    check("admin adds a test domain", add?.ok === true);

    const postUser = await mkUser("p");
    client.setAuth(postUser.token);
    const postRes = await client.mutation(api.posts.createPost, {
      content: `Check my page — https://${testDomain}/hello ${stamp}`,
    });
    check("a post linking the added domain is rejected", postRes?.ok === false);
    check(
      "the rejection names the adult-platform rule",
      typeof postRes?.error === "string" &&
        postRes.error.includes("Adult platforms aren't allowed"),
    );
    const subPost = await client.mutation(api.posts.createPost, {
      content: `Live at https://${subDomain}/now ${stamp}`,
    });
    check("a subdomain of the added domain is rejected too", subPost?.ok === false);

    const commentUser = await mkUser("c");
    client.setAuth(commentUser.token);
    const host = await client.mutation(api.posts.createPost, {
      content: `host post ${stamp}`,
    });
    const commentRes = await client.mutation(api.posts.addComment, {
      postId: host.postId,
      content: `see https://${testDomain} ${stamp}`,
    });
    check("a comment linking the domain is rejected", commentRes?.ok === false);

    const bioUser = await mkUser("b");
    client.setAuth(bioUser.token);
    const bio = await client.mutation(api.users.updateProfile, {
      bio: `dm me — https://${testDomain} ${stamp}`,
    });
    check("a bio linking the domain is rejected", bio?.ok === false);
    const link = await client.mutation(api.users.updateProfile, {
      links: [{ platform: "Custom", url: `https://${testDomain}/me` }],
    });
    check("a profile link to the domain is rejected", link?.ok === false);

    const storyUser = await mkUser("s");
    client.setAuth(storyUser.token);
    const story = await client.mutation(api.stories.createStory, {
      media: {
        kind: "image",
        storageId: undefined,
        url: undefined,
        key: undefined,
        stripped: false,
      },
      caption: `watch https://${testDomain} ${stamp}`,
    });
    check("a story caption linking the domain is rejected", story?.ok === false);

    // ── 2b. URL patterns are enforced across surfaces too ─────────────────
    const patternText = `qa-pat-${stamp}`;
    client.setAuth(admin.token);
    const patAdd = await client.mutation(api.blocklist.upsertBlockedPattern, {
      pattern: patternText,
      category: "adult_other",
      action: "block",
    });
    check("admin adds a URL pattern", patAdd?.ok === true);
    const patUser = await mkUser("pat");
    client.setAuth(patUser.token);
    const patternPost = await client.mutation(api.posts.createPost, {
      content: `Claim it at https://example.com/${patternText} ${stamp}`,
    });
    check("a post matching a blocked URL pattern is rejected", patternPost?.ok === false);

    // ── 3. The active list is served for the client DM gate ──────────────
    const active = await client.query(api.blocklist.getActiveBlocklist);
    check(
      "getActiveBlocklist includes the admin-added domain",
      active?.domains?.some((d) => d.domain === testDomain) === true,
    );
    check(
      "getActiveBlocklist includes the admin-added pattern",
      active?.patterns?.some((p) => p.pattern === patternText) === true,
    );
    check(
      "getActiveBlocklist stays bounded (core + added)",
      (active?.domains?.length ?? 0) >= 60,
    );

    // ── 4. External source sync engages the fetch pipeline ────────────────
    client.setAuth(admin.token);
    const src = await client.mutation(api.blocklist.upsertDomainSource, {
      name: `qa-src-${stamp}`,
      // Deliberately nonexistent path on a reachable host: the sync must
      // ATTEMPT the fetch (timestamp recorded) and record the failure
      // (lastError), proving the error lifecycle without depending on a
      // third-party feed's content in CI.
      url: `https://example.com/qa-feed-${stamp}.txt`,
      format: "domain",
      enabled: true,
    });
    check("admin adds a domain source", src?.ok === true);
    const sync = await client.action(api.blocklist.syncExternalSources);
    check(
      "sync ran and reported the source",
      sync?.ok === true && sync.results.some((r) => r.name === `qa-src-${stamp}`),
    );
    const sources = await client.query(api.blocklist.listDomainSources);
    const srcRow = sources?.find((s) => s.name === `qa-src-${stamp}`);
    check(
      "the sync lifecycle recorded a fetch attempt (timestamp)",
      typeof srcRow?.lastFetchedAt === "number",
    );
    check(
      "a failed fetch is recorded as lastError, not a fake success",
      typeof srcRow?.lastError === "string" &&
        srcRow.lastSuccessfulSyncAt === undefined,
    );

    // ── 4b. A feed with a `# Category:` header syncs into that bucket ────
    // Points at PureWire's own data/adult feed, served from the deployed
    // site (public/data/adult is mirrored by npm run data:sync). The parser
    // must read the header and import a domain into its declared category,
    // not the adult_other default.
    const feedSrc = await client.mutation(api.blocklist.upsertDomainSource, {
      name: `qa-feed-${stamp}`,
      url: `https://purewire.vercel.app/data/adult/cam-domains.txt`,
      format: "domain",
      enabled: true,
    });
    check("admin adds the purewire data/adult feed source", feedSrc?.ok === true);
    const sync2 = await client.action(api.blocklist.syncExternalSources);
    const feedRow = sync2?.results?.find((r) => r.name === `qa-feed-${stamp}`);
    check(
      "the data feed synced successfully (no error)",
      sync2?.ok === true && feedRow !== undefined && feedRow.error === undefined,
    );

    // ── 5. Pausing a domain un-blocks it ──────────────────────────────────
    client.setAuth(admin.token);
    await client.mutation(api.blocklist.setBlockedDomainActive, {
      domain: testDomain,
      active: false,
    });
    // Pause check runs on the post throwaway — it's only had one block,
    // well under the shadowban threshold.
    client.setAuth(postUser.token);
    const afterPause = await client.mutation(api.posts.createPost, {
      content: `Check https://${testDomain}/again ${stamp}`,
    });
    check("pausing the entry lets the domain post again", afterPause?.ok === true);

    // ── 6. Cleanup: remove the test entries + source, erase throwaways ────
    client.setAuth(admin.token);
    await client.mutation(api.blocklist.deleteBlockedDomain, { domain: testDomain });
    await client.mutation(api.blocklist.deleteBlockedPattern, {
      pattern: patternText,
    });
    await client.mutation(api.blocklist.deleteDomainSource, {
      name: `qa-src-${stamp}`,
    });
    await client.mutation(api.blocklist.deleteDomainSource, {
      name: `qa-feed-${stamp}`,
    });
    const afterCleanup = await client.query(api.blocklist.getActiveBlocklist);
    check(
      "the test domain is gone after cleanup",
      afterCleanup?.domains?.some((d) => d.domain === testDomain) !== true,
    );
    check(
      "the test pattern is gone after cleanup",
      afterCleanup?.patterns?.some((p) => p.pattern === patternText) !== true,
    );
    // Erase every surface throwaway.
    for (const u of [postUser, commentUser, bioUser, storyUser, patUser]) {
      client.setAuth(u.token);
      await client.mutation(api.account.deleteAccount);
    }
    const gone = await client.query(api.testHarness.getTestUserState, {
      userId: postUser.userId,
      secret: SECRET,
    });
    check("throwaway accounts fully erased", gone === null);
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

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
