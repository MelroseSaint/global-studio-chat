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
import { assertAdminIpVerified } from "./lib/qa-admin-ip.mjs";
import { powProof } from "./lib/qa-pow.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
// The mirror serves HTTP (the .cloud host is the action/mutation API);
// the QA's fixture feeds are fetched over plain HTTP by syncExternalSources.
const MIRROR_SITE =
  process.env.MIRROR_SITE_URL ?? CONVEX_URL.replace(".cloud", ".site");
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
  // Every user is tracked so the finally block can erase them even if a
  // check crashes mid-run — a leftover qa_bl_ post would otherwise poison
  // the next run's near-duplicate gate for 7 days.
  const createdUsers = [];
  const mkUser = async (tag) => {
    const u = await client.mutation(api.testHarness.createTestUser, {
      name: `QA BL ${tag}`,
      username: `qa_bl_${tag}_${stamp}`,
      secret: SECRET,
    });
    createdUsers.push(u.userId);
    return u;
  };
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check("created the harness users and an admin session", !!admin);
  // Backend-verified device gate: bind the minted admin session to the
  // backend-observed IP or admin-gated calls are refused once the 30s
  // bootstrap grace lapses (this QA runs for minutes).
  await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: admin.token });

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
    const postRes = await client.action(api.posts.createPost, {
      content: `Check my page — https://${testDomain}/hello ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check("a post linking the added domain is rejected", postRes?.ok === false);
    check(
      "the rejection names the adult-platform rule",
      typeof postRes?.error === "string" &&
        postRes.error.includes("Adult platforms aren't allowed"),
    );
    const subPost = await client.action(api.posts.createPost, {
      content: `Live at https://${subDomain}/now ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check("a subdomain of the added domain is rejected too", subPost?.ok === false);

    const commentUser = await mkUser("c");
    client.setAuth(commentUser.token);
    const host = await client.action(api.posts.createPost, {
      content: `host post ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    const commentRes = await client.mutation(api.posts.addComment, {
      postId: host.postId,
      content: `see https://${testDomain} ${stamp}`,
      ...(await powProof(client))});
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
    const story = await client.action(api.stories.createStory, {
      // A valid media item on the Cloudinary host — the point of this check
      // is the CAPTION blocklist, and the media gate now requires a real
      // item (storage id or https URL), never a degenerate empty object.
      media: {
        kind: "image",
        url: `https://res.cloudinary.com/saintscloud/qa-${stamp}.jpg`,
        key: `qa-${stamp}`,
        stripped: true,
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
    const patternPost = await client.action(api.posts.createPost, {
      content: `Claim it at https://example.com/${patternText} ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
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
    // Carries a FRESH domain — one not in the core list — so the sync
    // actually inserts a row and the header routing is genuinely exercised:
    // the parser must read `# Category: adult_fetish` and land the new
    // domain there, not in the adult_other default. The feed is served by
    // the CONVEX MIRROR's /qa/feed echo (a deterministic, harness-gated
    // echo of our own bytes — see src/convex/http.ts) instead of a
    // committed file on the platform or a flaky third-party echo like
    // httpbin.org, which 503s and reds the nightly gate. PureWire's static
    // data/ dir must never carry test content. The stamp rides in a
    // comment line so every run's URL is unique (no HTTP caching) while
    // the parsed domain stays exactly `qa-routing-feed.test`.
    const routingDomain = "qa-routing-feed.test";
    const routingFeed = Buffer.from(
      `# Category: adult_fetish\n# pwqa-${stamp}\n${routingDomain}\n`,
      "utf8",
    )
      .toString("base64")
      // URL-safe: the payload rides in the path, and `/`/`+` would break
      // the route segment — the /qa/feed echo decodes base64url back.
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const feedSrc = await client.mutation(api.blocklist.upsertDomainSource, {
      name: `qa-feed-${stamp}`,
      url: `${MIRROR_SITE}/qa/feed/${routingFeed}`,
      format: "domain",
      enabled: true,
    });
    check("admin adds the purewire data/adult feed source", feedSrc?.ok === true);
    // The deployed site can trail the push briefly (a brand-new feed file
    // 404s into the SPA fallback until the deploy lands), so poll for the
    // OUTCOME — the fresh domain actually routed into its declared bucket
    // — not merely a no-error sync. A healthy deploy gap must never fail
    // the suite; a genuinely broken feed eventually fails the loop.
    let routedRow = null;
    let sync2 = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      sync2 = await client.action(api.blocklist.syncExternalSources);
      const routed = await client.query(api.blocklist.getActiveBlocklist);
      routedRow =
        routed?.domains?.find((d) => d.domain === routingDomain) ?? null;
      if (routedRow?.category === "adult_fetish") break;
      await sleep(10_000);
    }
    const feedRow = sync2?.results?.find((r) => r.name === `qa-feed-${stamp}`);
    check(
      "the data feed synced successfully (no error)",
      sync2?.ok === true && feedRow !== undefined && feedRow.error === undefined,
    );
    check(
      "the # Category: header routed the new domain into adult_fetish",
      routedRow?.category === "adult_fetish",
    );

    // ── 4c. Deactivation: a domain that leaves its feed is deactivated ────
    // Re-point the SAME source at a feed that no longer lists the routing
    // domain (cam-domains.txt holds only core entries, none of which are
    // qa-routing-feed.test). On the next successful sync the lifecycle must
    // DEACTIVATE the vanished domain and stamp lastVerifiedAt — the spec's
    // "compare against existing DB → deactivate removed domains".
    await client.mutation(api.blocklist.upsertDomainSource, {
      name: `qa-feed-${stamp}`,
      url: `https://purewire.vercel.app/data/adult/cam-domains.txt`,
      format: "domain",
      enabled: true,
    });
    let deactivated = null;
    let sync3 = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      sync3 = await client.action(api.blocklist.syncExternalSources);
      const pages = await client.query(api.blocklist.listBlockedDomains, {
        paginationOpts: { numItems: 200, cursor: null },
      });
      deactivated =
        pages?.page?.find((d) => d.domain === routingDomain) ?? null;
      if (deactivated?.active === false) break;
      await sleep(10_000);
    }
    check(
      "a domain that vanished from its feed is deactivated on re-sync",
      deactivated?.active === false,
    );
    check(
      "the deactivated row keeps its source + lastVerifiedAt trace",
      typeof deactivated?.lastVerifiedAt === "number" &&
        typeof deactivated?.source === "string",
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
    const afterPause = await client.action(api.posts.createPost, {
      content: `Check https://${testDomain}/again ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check("pausing the entry lets the domain post again", afterPause?.ok === true);

    // ── 7. IDN → ASCII (punycode): Unicode and xn-- forms meet ───────────
    // Admin adds a Unicode domain; the stored entry must be its punycode
    // form, and the SAME host posted as Unicode, as xn--, or as a subdomain
    // must all be caught — the pipeline's IDN conversion stage, live.
    client.setAuth(admin.token);
    const idnDomain = `täst-${stamp}.test`;
    const idnAdd = await client.mutation(api.blocklist.upsertBlockedDomain, {
      domain: idnDomain,
      category: "adult_other",
      action: "block",
      blockSubdomains: true,
      active: true,
    });
    check("admin adds a Unicode (IDN) domain", idnAdd?.ok === true);
    const idnActive = await client.query(api.blocklist.getActiveBlocklist);
    const storedIdn = idnActive?.domains?.find((d) =>
      d.domain.endsWith(`.${idnDomain.split(".")[1]}`) && d.domain.startsWith("xn--"),
    );
    check(
      "the IDN domain is stored in punycode (xn--) form",
      storedIdn !== undefined && storedIdn.domain.includes("xn--"),
    );

    const idnUserA = await mkUser("idn-u");
    client.setAuth(idnUserA.token);
    const idnUnicodePost = await client.action(api.posts.createPost, {
      content: `visit https://${idnDomain}/x ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check("a Unicode host is caught against its xn-- block", idnUnicodePost?.ok === false);

    const idnUserB = await mkUser("idn-p");
    client.setAuth(idnUserB.token);
    const idnPunyPost = await client.action(api.posts.createPost, {
      content: `visit https://${storedIdn.domain}/y ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check("the xn-- form is caught identically", idnPunyPost?.ok === false);

    const idnUserC = await mkUser("idn-s");
    client.setAuth(idnUserC.token);
    const idnSubPost = await client.action(api.posts.createPost, {
      content: `visit https://m.${idnDomain}/z ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check("a subdomain of the IDN host is caught too", idnSubPost?.ok === false);

    // ── 8. Redirect inspection: final-domain lookup + chain recording ────
    // A URL that 301s http→https (GitHub is stable and allowlisted): the
    // action follows it manually, records the chain, and the final-hostname
    // lookup resolves to the same host — verdict allowed, chain length ≥ 2.
    client.setAuth(admin.token);
    // GitHub is the one third-party dependency in this suite (the rest is
    // self-hosted on purpose). Guard it: only assert the redirect-chain
    // details when the preview card actually resolved — a github outage
    // must degrade the nightly check, not fail it.
    // Cache-bust the URL with this run's stamp: fetchUrlPreview returns the
    // cached card (no fresh scan record) on a cache hit, and the admin scan
    // list only holds the latest 100 rows — so a plain "http://github.com/"
    // gets a card from a previous run's cache and its old scan row scrolls
    // out of the window, flaking the chain assertions. A unique query keeps
    // every run's redirect chain recorded and findable.
    const ghUrl = `http://github.com/?pwqa=${stamp}`;
    const ghPreview = await client.action(api.links.fetchUrlPreview, {
      url: ghUrl,
    });
    const ghResolved =
      ghPreview?.title !== undefined || ghPreview?.domain === "github.com";
    check(
      "a redirecting URL still resolves a preview card",
      ghResolved,
    );
    const scanRows = await client.query(api.blocklist.listLinkScanResults);
    const ghRow = scanRows?.find((r) => r.originalUrl === ghUrl);
    if (ghResolved) {
      check(
        "redirect inspection recorded the redirect chain",
        Array.isArray(ghRow?.redirectChain) && ghRow.redirectChain.length >= 2,
      );
      check(
        "final hostname = the resolved destination (github.com)",
        ghRow?.finalHostname === "github.com",
      );
      check("a clean redirect is verdict=allowed", ghRow?.verdict === "allowed");
    } else {
      console.log(
        "  ⚠️  github.com unreachable — skipping redirect-chain assertions (accepted dependency)",
      );
    }
    // A link INTO a blocked host must be refused at the card level, and the
    // scan record must carry the verdict + final hostname for the audit.
    // The test domain was paused in section 5, so re-activate it first — the
    // redirect inspector must see an ACTIVE entry to refuse the link.
    await client.mutation(api.blocklist.setBlockedDomainActive, {
      domain: testDomain,
      active: true,
    });
    const blockedPreview = await client.action(api.links.fetchUrlPreview, {
      url: `https://${testDomain}/x`,
    });
    check(
      "a link to a blocked domain gets no preview card",
      !blockedPreview?.title && !blockedPreview?.image,
    );
    // Re-fetch the scan records AFTER the blocked action so its row is in.
    const scanRowsAfter = await client.query(api.blocklist.listLinkScanResults);
    const blockedRow = scanRowsAfter?.find(
      (r) => r.originalUrl === `https://${testDomain}/x`,
    );
    check(
      "the blocked link's scan record carries verdict=blocked",
      blockedRow?.verdict === "blocked",
    );
    check(
      "the scan record carries the matched domain",
      blockedRow?.matchedDomain === testDomain,
    );

    // ── 9. Negative matcher: lookalike/embedded hosts must NOT match ─────
    // The core rule of the domain matcher: only the exact host and true
    // subdomains match. A lookalike (notonlyfans.com) and a host that merely
    // CONTAINS the blocked domain (onlyfans.com.example.com) must both stay
    // clean — the chain walk, not a substring test, is what enforces this.
    const negUser = await mkUser("neg");
    client.setAuth(negUser.token);
    // The stamp rides INSIDE the URL path, not trailing the text: the
    // near-duplicate gate scores word-bigram shingles, and a fixed
    // host/path shape whose only variance is a trailing token shares
    // ~5/6 shingles (Jaccard 0.714 >= 0.7) with the SAME fixture from an
    // earlier run — flagging it "already exists" and redding the QA even
    // when the matcher is correct. A per-run path token keeps cross-run
    // similarity at 0.5, so the fixture can never self-poison.
    const lookalike = await client.action(api.posts.createPost, {
      content: `https://notonlyfans.com/${stamp}/post`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check(
      "notonlyfans.com is NOT matched (lookalike stays clean)",
      lookalike?.ok === true,
    );
    const embedded = await client.action(api.posts.createPost, {
      content: `https://onlyfans.com.example.com/${stamp}/post`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check(
      "onlyfans.com.example.com is NOT matched (embedded stays clean)",
      embedded?.ok === true,
    );
    const cleanDom = await client.action(api.posts.createPost, {
      content: `https://sub.onlyfans.com.example.org/${stamp}/post`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check(
      "a subdomain of the embedded host stays clean too",
      cleanDom?.ok === true,
    );

    // ── 10. Textual obfuscation: dot-com/[.]/(.)/spaced forms are caught ──
    // Each blocked attempt escalates 3 silent points and the threshold is 6,
    // so every obfuscation form runs on its own throwaway (same discipline
    // as the earlier surface checks).
    const obfCases = [
      ["onlyfans dot com", "obf1"],
      ["onlyfans[.]com", "obf2"],
      ["onlyfans(.)com", "obf3"],
      ["onlyfans . com", "obf4"],
    ];
    const obfUsers = [];
    for (const [text, tag] of obfCases) {
      const u = await mkUser(tag);
      obfUsers.push(u);
      client.setAuth(u.token);
      const res = await client.action(api.posts.createPost, {
        content: `check out ${text} ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
      check(`obfuscated form “${text}” is blocked`, res?.ok === false);
    }
    // The negative control: a lookalike written textually must stay clean —
    // obfuscation detection only fires on REAL blocked entries.
    const obfNeg = await mkUser("obf-neg");
    client.setAuth(obfNeg.token);
    const obfClean = await client.action(api.posts.createPost, {
      content: `notonlyfans dot com is nothing ${stamp}`,
      creatorDisclosure: 'human-made',
      ...(await powProof(client))});
    check("a textual lookalike stays clean (no false positive)", obfClean?.ok === true);

    // ── Cleanup (guaranteed by finally) ───────────────────────────────
    // Runs even if the try block crashes mid-test, so QA artefacts
    // (domains, patterns, sources, throwaway users) never accumulate.
  } finally {
    // Erase this run's own throwaway users FIRST — deleteTestUser works
    // without auth and only touches qa_ accounts (the same pattern the
    // other QAs use). If the admin mint / IP verify below throws, the
    // catch would otherwise swallow the erase and leave the run's posts
    // in the table, where the near-duplicate gate then flags the next
    // run's identical-shape fixture as "already exists" for 7 days.
    try {
      for (const userId of createdUsers) {
        await client
          .mutation(api.testHarness.deleteTestUser, { userId, secret: SECRET })
          .catch(() => {});
      }
      if (createdUsers.length > 0) {
        console.log(
          `  🧹 Erased ${createdUsers.length} throwaway QA user(s).`,
        );
      }
    } catch (_) {
      // Best-effort: a cleanup failure must never mask the real test outcome.
    }
    try {
      const cleanupAdmin = await client.mutation(api.testHarness.mintAdminSession, { secret: SECRET });
      client.setAuth(cleanupAdmin.token);
      await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: cleanupAdmin.token });
      // Delete this run's own domains (ignore errors — may not exist).
      // .catch(() => {}) on each because the try block may have already
      // deleted them, and a missing-domain error must not crash cleanup.
      await Promise.allSettled([
        client.mutation(api.blocklist.deleteBlockedDomain, { domain: testDomain }).catch(() => {}),
        client.mutation(api.blocklist.setBlockedDomainActive, { domain: testDomain, active: false }).catch(() => {}),
        client.mutation(api.blocklist.deleteBlockedDomain, { domain: routingDomain }).catch(() => {}),
      ]);
      // Sweep ALL leaked rows from ANY interrupted run (not just this stamp):
      // domains owned by a qa- source OR carrying a reserved .test TLD (the
      // IDN test domains täst-*.test are admin-added, so their source is
      // "manual" — only the .test suffix identifies them), qa- patterns,
      // and qa- sources.
      let cursor = null;
      let swept = 0;
      for (let i = 0; i < 20; i++) {
        const page = await client.query(api.blocklist.listBlockedDomains, { paginationOpts: { numItems: 200, cursor } });
        for (const row of page.page) {
          if (row.source.startsWith("qa-") || row.domain.endsWith(".test")) {
            await client.mutation(api.blocklist.deleteBlockedDomain, { domain: row.domain }).catch(() => {});
            swept++;
          }
        }
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      // Sweep QA patterns and sources.
      const patternList = await client.query(api.blocklist.listBlockedPatterns);
      for (const p of (patternList ?? [])) {
        if (p.pattern.includes("qa-")) {
          await client.mutation(api.blocklist.deleteBlockedPattern, { pattern: p.pattern }).catch(() => {});
        }
      }
      const sourceList = await client.query(api.blocklist.listDomainSources);
      for (const s of (sourceList ?? [])) {
        if (s.name.startsWith("qa-")) {
          await client.mutation(api.blocklist.deleteDomainSource, { name: s.name }).catch(() => {});
        }
      }
      if (swept > 0) {
        console.log("  🧹 Cleaned up " + swept + " leaked QA domain row(s).");
      }
    } catch (_) {
      // Best-effort: a cleanup failure must never mask the real test outcome.
    }
    client.clearAuth();
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
