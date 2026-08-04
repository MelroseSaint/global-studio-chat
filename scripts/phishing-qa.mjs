#!/usr/bin/env node
/**
 * PureWire phishing & account-integrity QA check.
 *
 * Repeatable end-to-end verification of the phishing layer against a real
 * deployment. It proves that scam text, PureWire lookalike domains, link
 * shorteners, and credential-harvesting phrasing are blocked or routed to
 * the human review queue across EVERY public surface — posts, comments,
 * story captions, and profile bios/links — while ordinary links still post
 * clean, and that repeat offenders quietly accumulate "scam" silent-flag
 * points toward a shadowban that the admin Silenced queue explains.
 *
 * Two throwaways: the post/profile account and a separate comment account,
 * because a shadowban flips the moment points cross the threshold and
 * sandboxed accounts skip scanning — each surface must be tested while the
 * account is still visible.
 *
 * The harness (convex/testHarness.ts) mints real auth sessions for the test
 * accounts and refuses to run unless the deployment env has
 * TEST_HARNESS_ENABLED=1 AND the caller proves TEST_HARNESS_SECRET. To run:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/phishing-qa.mjs
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Overrides: CONVEX_URL (default: the production deployment), TEST_HARNESS_SECRET.
 * Exit codes: 0 all checks passed, 1 a check failed, 2 harness disabled.
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
const pag = { numItems: 50, cursor: null };

async function main() {
  console.log(`\nPureWire phishing & account-integrity QA — ${CONVEX_URL}\n`);

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

  // ── Accounts ────────────────────────────────────────────────────────────
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const cUser = `qa_phish_${stamp}`;
  const c2User = `qa_phish2_${stamp}`;
  const bUser = `qa_viewer_${stamp}`;
  const aUser = `qa_adult_${stamp}`;
  const C1 = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Phisher A",
    username: cUser,
    secret: SECRET,
  });
  const C2 = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Phisher B",
    username: c2User,
    secret: SECRET,
  });
  const B = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Viewer",
    username: bUser,
    secret: SECRET,
  });
  // The adult-platform block tests get their own throwaway: each blocked
  // post escalates 3 scam points and the shadowban threshold is 6, so
  // running them on C1 would shadowban it before the review-tier checks.
  const adultUser = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Adult Tester",
    username: aUser,
    secret: SECRET,
  });
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check(
    "created three throwaways, a viewer and an admin session",
    !!(C1 && C2 && B && adultUser && admin),
  );

  const stateC1 = () =>
    client.query(api.testHarness.getTestUserState, {
      userId: C1.userId,
      secret: SECRET,
    });

  try {
    // ── 1. Negative controls: ordinary links post clean ────────────────────
    client.setAuth(C1.token);
    const plainRes = await client.action(api.posts.createPost, {
      content: `Reading this today — https://example.com/article ${stamp}`,
      creatorDisclosure: "human-made",
    });
    check("a normal article link posts clean", plainRes.ok === true);
    check(
      "a clean link is not routed to review",
      plainRes.ok === true && plainRes.aiReviewReason === undefined,
    );
    const officialRes = await client.action(api.posts.createPost, {
      content: `The platform lives at purewire.vercel.app — ${stamp}`,
      creatorDisclosure: "human-made",
    });
    check(
      "the official PureWire domain posts clean",
      officialRes.ok === true && officialRes.aiReviewReason === undefined,
    );
    // ── 1b. Adult platforms are hard-banned everywhere ─────────────────────
    // Runs on adultUser (not C1) so the 3-point block escalations don't
    // shadowban the phisher before the review/block tiers below exercise it.
    client.setAuth(adultUser.token);
    const adultRes = await client.action(api.posts.createPost, {
      content: `New content on my page — https://onlyfans.com/fanclub ${stamp}`,
      creatorDisclosure: "human-made",
    });
    check("an adult subscription link is blocked in a post", adultRes.ok === false);
    check(
      "the author learns the adult-platform rule by name",
      typeof adultRes.error === "string" &&
        adultRes.error.includes("Adult platforms aren't allowed on PureWire"),
    );
    const adultSubRes = await client.action(api.posts.createPost, {
      content: `Live now — https://m.chaturbate.com/${stamp}`,
      creatorDisclosure: "human-made",
    });
    check(
      "a subdomain of an adult cam site is blocked too",
      adultSubRes.ok === false,
    );
    const adultLinkRes = await client.mutation(api.users.updateProfile, {
      links: [{ platform: "Custom", url: "fansly.com/creator" }],
    });
    check(
      "an adult platform link is blocked in a profile link",
      adultLinkRes?.ok === false &&
        typeof adultLinkRes?.error === "string" &&
        adultLinkRes.error.includes("Adult platforms"),
    );
    // Back to C1: the false-positive negative controls below must exercise
    // the phisher account, not the adult throwaway.
    client.setAuth(C1.token);
    // False-positive negative controls: innocent human speech must never be
    // blocked or review-queued.
    const adviceRes = await client.action(api.posts.createPost, {
      content: `Always verify your email after signing up — it protects your account. ${stamp}`,
      creatorDisclosure: "human-made",
    });
    check(
      "legit security advice posts clean",
      adviceRes.ok === true && adviceRes.aiReviewReason === undefined,
    );
    const praiseRes = await client.action(api.posts.createPost, {
      content: `You have won my respect today, friends. ${stamp}`,
      creatorDisclosure: "human-made",
    });
    check(
      "innocent 'you have won' phrasing posts clean",
      praiseRes.ok === true && praiseRes.aiReviewReason === undefined,
    );

    // ── 2. Review-tier post: link shortener → human queue, honest why ──────
    const reviewRes = await client.action(api.posts.createPost, {
      content: `Found something interesting — https://bit.ly/xYz123 ${stamp}`,
      creatorDisclosure: "human-made",
    });
    const reviewPostId = reviewRes.ok === true ? reviewRes.postId : null;
    check("a link shortener post is accepted into review", reviewRes.ok === true);
    check(
      "the review post tells the author why (phishing reason)",
      typeof reviewRes.aiReviewReason === "string" &&
        /phishing/i.test(reviewRes.aiReviewReason),
    );
    check(
      "the author-facing reason is not double-prefixed",
      typeof reviewRes.aiReviewReason === "string" &&
        !reviewRes.aiReviewReason.includes(
          "Suspected phishing — Suspected phishing",
        ),
    );
    const feedC1 = await client.query(api.posts.feed, {
      filter: "global",
      paginationOpts: pag,
    });
    check(
      "the author sees their own review post in the feed",
      feedC1.page.some((p) => p._id === reviewPostId),
    );
    client.setAuth(B.token);
    const feedB = await client.query(api.posts.feed, {
      filter: "global",
      paginationOpts: pag,
    });
    check(
      "the review post stays hidden from other members",
      !feedB.page.some((p) => p._id === reviewPostId),
    );

    // ── 3. Blocked-tier post: scam phrasing + PureWire lookalike domain ────
    client.setAuth(C1.token);
    const blockRes = await client.action(api.posts.createPost, {
      content: `FREE followers!! Verify your account at http://purew1re-verify.com/login now ${stamp}`,
      creatorDisclosure: "human-made",
    });
    check(
      "a scam post with a lookalike PureWire login is rejected",
      blockRes.ok === false && /phish|scam|steal/i.test(blockRes.error),
    );

    // ── 4. Profile surfaces: bio + links are scanned too ───────────────────
    const bioRes = await client.mutation(api.users.updateProfile, {
      bio: `dm me on telegram and I'll share more ${stamp}`,
    });
    check(
      "a review-tier bio (off-platform funnel) is rejected",
      bioRes !== null && bioRes.ok === false,
    );
    const linkBlockRes = await client.mutation(api.users.updateProfile, {
      links: [{ platform: "X", url: "https://purew1re-login.com" }],
    });
    check(
      "a lookalike PureWire link is rejected from the profile",
      linkBlockRes !== null &&
        linkBlockRes.ok === false &&
        /phish|scam|link/i.test(linkBlockRes.error),
    );
    const linkShortRes = await client.mutation(api.users.updateProfile, {
      links: [{ platform: "TikTok", url: "https://bit.ly/abc" }],
    });
    check(
      "a link shortener is rejected from the profile with guidance",
      linkShortRes !== null && linkShortRes.ok === false,
    );
    // Scheme-less forms (the sloppy paste) must not dodge the scanner.
    const linkBareRes = await client.mutation(api.users.updateProfile, {
      links: [{ platform: "X", url: "purewire-login.xyz/verify" }],
    });
    check(
      "a scheme-less lookalike link is rejected from the profile",
      linkBareRes !== null && linkBareRes.ok === false,
    );
    const linkBareShortRes = await client.mutation(api.users.updateProfile, {
      links: [{ platform: "TikTok", url: "bit.ly/xyz" }],
    });
    check(
      "a scheme-less shortener is rejected from the profile",
      linkBareShortRes !== null && linkBareShortRes.ok === false,
    );
    // The preview fetcher must refuse private addresses (SSRF guard).
    const srvRes = await client.action(api.links.fetchUrlPreview, {
      url: "http://127.0.0.1/",
    });
    check(
      "the preview fetcher refuses private addresses",
      srvRes !== null &&
        srvRes.title === undefined &&
        srvRes.description === undefined &&
        srvRes.image === undefined,
    );

    // ── 5. The comment surface, on a separate throwaway ────────────────────
    client.setAuth(B.token);
    const bPostRes = await client.action(api.posts.createPost, {
      content: `A post from the QA viewer to comment on — ${stamp}`,
      creatorDisclosure: "human-made",
    });
    const bPostId = bPostRes.ok === true ? bPostRes.postId : null;
    client.setAuth(C2.token);
    const cBlock = await client.mutation(api.posts.addComment, {
      postId: bPostId,
      content: "get free followers now!!",
    });
    check(
      "a scam comment is rejected",
      cBlock !== null && cBlock.ok === false && /phish|scam|link/i.test(cBlock.error),
    );
    const cShort = await client.mutation(api.posts.addComment, {
      postId: bPostId,
      content: "check this out https://tinyurl.com/xyz",
    });
    check(
      "a shortened-link comment is rejected with direct-link guidance",
      cShort !== null && cShort.ok === false,
    );

    // ── 6. The silent layer: scam flags accrue toward a shadowban ──────────
    client.setAuth(C1.token);
    let s = null;
    for (let i = 0; i < 20; i++) {
      s = await stateC1();
      if (s && s.shadowban === true) break;
      await sleep(400);
    }
    check("the repeat scammer is quietly shadowbanned", s?.shadowban === true);
    const reasons = (s?.events ?? []).map((e) => e.reason);
    check("flag history records the scam reason", reasons.includes("scam"));
    // The bio rejection above is the third recorded escalation (the profile
    // link rejections after it are still enforced, but their points are not
    // recorded — the account is already shadowbanned by then).
    const scamSources = (s?.events ?? [])
      .filter((e) => e.reason === "scam")
      .map((e) => e.source);
    for (const source of [
      "phish-review-post",
      "phish-block-post",
      "phish-review-profile",
    ]) {
      check(`flag history records the ${source} source`, scamSources.includes(source));
    }
    check(
      "the scam points exceed the shadowban threshold",
      (s?.silentFlags ?? 0) >= 6,
    );

    // ── 7. Admins see why: Silenced queue + flag history explain it ────────
    client.setAuth(admin.token);
    const silenced = await client.query(api.security.listSilencedAccounts, {
      paginationOpts: pag,
    });
    const row = silenced.page.find((u) => u._id === C1.userId);
    check("admin Silenced queue lists the scammer", row !== undefined);
    check(
      "admin sees the scam breakdown on the account",
      !!row?.breakdown && (row.breakdown.scam ?? 0) >= 6,
    );
    const history = await client.query(api.security.silentFlagHistory, {
      userId: C1.userId,
    });
    check(
      "admin sees the phishing flag history",
      (history?.events ?? []).some((e) => e.reason === "scam"),
    );
    const historyC2 = await client.query(api.security.silentFlagHistory, {
      userId: C2.userId,
    });
    const c2Sources = (historyC2?.events ?? [])
      .filter((e) => e.reason === "scam")
      .map((e) => e.source);
    check(
      "comment phishing sources are recorded too",
      c2Sources.includes("phish-block-comment") &&
        c2Sources.includes("phish-review-comment"),
    );
    const profileAdmin = await client.query(api.users.getProfile, {
      username: cUser,
    });
    check("admin can still open the silenced profile", profileAdmin !== null);

    // ── 7b. One-tap phishing report: a ticket pre-attached to the post, ───
    // the offender, and the "No scams or phishing" principle reaches the
    // admin queue (the exact contract the post/comment menu quick action
    // uses).
    client.setAuth(B.token);
    const ticketId = await client.mutation(api.support.createTicket, {
      subject: "Report: No scams or phishing.",
      message: `Reported as suspected phishing in a post — ${stamp}`,
      postId: reviewPostId,
      offenderId: C1.userId,
      violation: "No scams or phishing.",
      standardId: "no-scams",
    });
    check("a phishing report files a ticket immediately", typeof ticketId === "string");
    // A second tap on the same target must dedupe to the existing open
    // ticket instead of flooding the admin queue.
    const ticketId2 = await client.mutation(api.support.createTicket, {
      subject: "Report: No scams or phishing.",
      message: `Reported as suspected phishing in a post — ${stamp}`,
      postId: reviewPostId,
      offenderId: C1.userId,
      violation: "No scams or phishing.",
      standardId: "no-scams",
    });
    check(
      "a duplicate one-tap report dedupes to the same ticket",
      ticketId2 === ticketId,
    );
    client.setAuth(admin.token);
    const tickets = await client.query(api.support.listTickets, {
      paginationOpts: pag,
    });
    const ticket = tickets.page.find((t) => t._id === ticketId);
    check(
      "the admin queue shows the ticket pre-attached to the post and offender",
      ticket !== undefined &&
        ticket.standardId === "no-scams" &&
        ticket.post?._id === reviewPostId &&
        ticket.offender?._id === C1.userId &&
        ticket.status === "open",
    );

    // ── 8. Cleanup: real erasure removes every throwaway ───────────────────
    client.setAuth(C1.token);
    await client.mutation(api.account.deleteAccount);
    client.setAuth(C2.token);
    await client.mutation(api.account.deleteAccount);
    client.setAuth(B.token);
    await client.mutation(api.account.deleteAccount);
    client.setAuth(adultUser.token);
    await client.mutation(api.account.deleteAccount);
    const gone = await client.query(api.testHarness.getTestUserState, {
      userId: C1.userId,
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

main().catch((e) => {
  console.error("\nQA run crashed:", e);
  process.exit(1);
});
