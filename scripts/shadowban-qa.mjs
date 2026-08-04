#!/usr/bin/env node
/**
 * PureWire silent-moderation QA check.
 *
 * Repeatable end-to-end verification of the quiet shadowban layer against a
 * real deployment. It creates a throwaway account, trips every escalation
 * path (stolen-content duplicates, AI-suspicious text, rate-limit breaches),
 * and then asserts the account becomes invisible to a second account while
 * staying visible to itself and to admins.
 *
 * The harness (convex/testHarness.ts) mints real auth sessions for the test
 * accounts — a script can't read email OTPs — and refuses to run unless the
 * deployment env has TEST_HARNESS_ENABLED=1 AND the caller proves
 * TEST_HARNESS_SECRET. To run:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/shadowban-qa.mjs
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
  console.log(`\nPureWire silent-moderation QA — ${CONVEX_URL}\n`);

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
  const aUser = `qa_throwaway_${stamp}`;
  const bUser = `qa_viewer_${stamp}`;
  const A = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Throwaway",
    username: aUser,
    secret: SECRET,
  });
  const B = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Viewer",
    username: bUser,
    secret: SECRET,
  });
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  check("created throwaway, viewer and admin sessions", !!(A && B && admin));

  const state = () =>
    client.query(api.testHarness.getTestUserState, {
      userId: A.userId,
      secret: SECRET,
    });

  try {
    // ── 1. Duplicate path (+3): B posts original text, A reposts it ────────
    client.setAuth(B.token);
    const original = `An original thought from the QA run — ${stamp}.`;
    const bRes = await client.action(api.posts.createPost, {
      content: original,
    });
    const bPostId = bRes.ok === true ? bRes.postId : null;
    client.setAuth(A.token);
    // createPost rejects duplicates with a structured result (not a thrown
    // error) so the quiet flag commits — check the result, not an exception.
    const dupRes = await client.action(api.posts.createPost, {
      content: original,
    });
    const duplicateRejected =
      dupRes.ok === false && /already exists/i.test(dupRes.error);
    check("duplicate post rejected as stolen content", duplicateRejected);

    // ── 2. AI-review path (+2): A posts formulaic machine-sounding text ─────
    const aiText =
      "Moreover, this landscape underscores a testament to the ever-evolving " +
      "digital space. Furthermore, it is important to note that, additionally, " +
      "in conclusion, we must not overlook how notably, crucially, and " +
      "significantly this matters overall.";
    const aiRes = await client.action(api.posts.createPost, {
      content: aiText,
    });
    const aiPostId = aiRes.ok === true ? aiRes.postId : null;
    check("AI-suspicious post accepted into review", aiRes.ok === true);
    check(
      "reviewed post reports its reason to the author",
      typeof aiRes.aiReviewReason === "string" &&
        aiRes.aiReviewReason.length > 0,
    );
    // The author sees their own review post (which carries the "under human
    // review" note with the reason) while other members don't — a genuine
    // creator is never left wondering where their post went.
    const feedAuthor = await client.query(api.posts.feed, {
      filter: "global",
      paginationOpts: pag,
    });
    check(
      "author sees their own review post in the feed",
      feedAuthor.page.some((p) => p._id === aiPostId),
    );
    client.setAuth(B.token);
    const feedOther = await client.query(api.posts.feed, {
      filter: "global",
      paginationOpts: pag,
    });
    check(
      "review post stays hidden from other members' feeds",
      !feedOther.page.some((p) => p._id === aiPostId),
    );
    client.setAuth(A.token);

    // ── 3. Rate-limit path (+1): burn the 30-post/hour budget ───────────────
    // The flag is recorded the moment the budget fills (scheduled in the
    // same transaction as the post that filled it). Once the account crosses
    // the threshold its posts are silently absorbed — they still "succeed" —
    // so a visible "too fast" rejection is never guaranteed. The reliable
    // signal is the flag landing in the history, which the state poll below
    // asserts; these fillers just exhaust the budget.
    for (let i = 0; i < 40; i++) {
      await client.action(api.posts.createPost, {
        content: `QA filler ${i} — a plain human note ${stamp}.`,
      });
    }

    // The duplicate +3 and rate-limit +1 commit with their own mutations —
    // wait until the account state reflects them.
    let s = null;
    for (let i = 0; i < 20; i++) {
      s = await state();
      if (s && s.shadowban === true) break;
      await sleep(400);
    }
    check("account is quietly shadowbanned", s?.shadowban === true);
    check("silent flags reached the threshold", (s?.silentFlags ?? 0) >= 6);
    const reasons = (s?.events ?? []).map((e) => e.reason);
    for (const reason of ["duplicate", "ai", "rate-limit"]) {
      check(`flag history records ${reason}`, reasons.includes(reason));
    }
    const sources = (s?.events ?? []).map((e) => e.source);
    check(
      "flag history records the source of each event",
      sources.length >= 3 && sources.every((src) => typeof src === "string" && src.length > 0),
    );

    // ── 4. Post-shadowban activity: everything is silently absorbed ─────────
    const phantomRes = await client.action(api.posts.createPost, {
      content: `A quiet post after the silence — ${stamp}.`,
    });
    const phantomPostId = phantomRes.ok === true ? phantomRes.postId : null;
    await client.mutation(api.posts.addComment, {
      postId: bPostId,
      content: `A quiet comment from the silenced account — ${stamp}.`,
    });
    await client.mutation(api.users.follow, { username: bUser });

    // ── 5. Invisible to the second account ─────────────────────────────────
    client.setAuth(B.token);
    const feedB = await client.query(api.posts.feed, {
      filter: "global",
      paginationOpts: pag,
    });
    check(
      "feed hides the silenced account's posts",
      !feedB.page.some((p) => p.author?._id === A.userId),
    );
    const postB = await client.query(api.posts.getPost, {
      postId: phantomPostId,
    });
    check("getPost returns nothing for a silenced post", postB === null);
    const userPostsB = await client.query(api.posts.listUserPosts, {
      userId: A.userId,
      paginationOpts: pag,
    });
    check("profile post list is empty for the viewer", userPostsB.page.length === 0);
    const profileB = await client.query(api.users.getProfile, {
      username: aUser,
    });
    check("profile is invisible to the viewer", profileB === null);
    const searchB = await client.query(api.users.searchUsers, {
      query: aUser,
    });
    check("search hides the silenced account", !searchB.some((u) => u.username === aUser));
    const suggestedB = await client.query(api.users.suggestedUsers);
    check("suggestions hide the silenced account", !suggestedB.some((u) => u.username === aUser));
    const commentsB = await client.query(api.posts.listComments, {
      postId: bPostId,
      paginationOpts: pag,
    });
    check(
      "silenced comments are invisible to the viewer",
      !commentsB.page.some((c) => c.authorId === A.userId),
    );
    const profileB2 = await client.query(api.users.getProfile, {
      username: bUser,
    });
    const notifsB = await client.query(api.notifications.listNotifications, {
      paginationOpts: pag,
    });
    check(
      "phantom follow never reaches the viewer's counts",
      (profileB2?.followersCount ?? 0) === 0,
    );
    check(
      "phantom follow never notifies the viewer",
      !notifsB.page.some(
        (n) => n.type === "follow" && n.actorId === A.userId,
      ),
    );

    // ── 6. Visible to themselves (nothing looks wrong) ─────────────────────
    client.setAuth(A.token);
    const meA = await client.query(api.users.getCurrentUser);
    check("silenced account still loads its own profile", meA !== null);
    const ownPost = await client.query(api.posts.getPost, {
      postId: phantomPostId,
    });
    check("silenced account sees its own post", ownPost !== null);
    const userPostsA = await client.query(api.posts.listUserPosts, {
      userId: A.userId,
      paginationOpts: pag,
    });
    check("silenced account sees its own posts", userPostsA.page.length > 0);
    const feedA = await client.query(api.posts.feed, {
      filter: "global",
      paginationOpts: pag,
    });
    check(
      "silenced account sees its own posts in the feed",
      feedA.page.some((p) => p.author?._id === A.userId),
    );

    // ── 7. Visible to admins (moderation can act) ──────────────────────────
    client.setAuth(admin.token);
    const silenced = await client.query(api.security.listSilencedAccounts, {
      paginationOpts: pag,
    });
    const row = silenced.page.find((u) => u._id === A.userId);
    check("admin Silenced queue lists the account", row !== undefined);
    check(
      "admin sees a reason breakdown on the account",
      !!row?.breakdown && row.breakdown.duplicate >= 3 &&
        row.breakdown.ai >= 2 && row.breakdown["rate-limit"] >= 1,
    );
    const history = await client.query(api.security.silentFlagHistory, {
      userId: A.userId,
    });
    check("admin sees the flag history", (history?.events?.length ?? 0) >= 3);
    check(
      "audit trail records the system silence",
      (history?.actions ?? []).some((a) => a.action === "silence" && a.actor === null),
    );
    const postAdmin = await client.query(api.posts.getPost, {
      postId: phantomPostId,
    });
    check("admin can open a silenced post", postAdmin !== null);
    const profileAdmin = await client.query(api.users.getProfile, {
      username: aUser,
    });
    check("admin can open the silenced profile", profileAdmin !== null);

    // ── 8. Cleanup: real erasure path removes the throwaway accounts ───────
    client.setAuth(A.token);
    await client.mutation(api.account.deleteAccount);
    client.setAuth(B.token);
    await client.mutation(api.account.deleteAccount);
    const gone = await client.query(api.testHarness.getTestUserState, {
      userId: A.userId,
      secret: SECRET,
    });
    check("throwaway account fully erased", gone === null);
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
