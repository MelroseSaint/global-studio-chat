#!/usr/bin/env node
/**
 * PureWire production post-author comment deletion QA.
 *
 * Drives the "a post's author can delete comments written by other users"
 * feature end to end against the live deployment — the permission matrix
 * (author / post author / third party), the reply-thread sweep, count
 * honesty, and the notification side effect (removals aren't silent).
 * Harness-gated like the comment-share / reinstate / phishing checks.
 *
 * Backend half (deterministic, all harness users):
 *   1. A (post author), B (commenter), and C (third party) are minted.
 *   2. A posts; B comments. A deletes B's comment — it disappears and the
 *      post's commentCount returns to zero.
 *   3. Negative: C (neither author nor post owner) cannot delete B's
 *      comment — rejected, and the comment survives.
 *   4. Reply sweep: B comments + replies; A deletes the thread root — the
 *      reply dies with it and commentCount stays honest.
 *   5. Direct reply delete: A deletes just a reply — it's gone and the
 *      parent's replyCount decrements.
 *
 * Notification half (needs a non-test actor, so the real admin is minted):
 *   6. A QA deleter (test account) erasing a comment stays silent — the
 *      same !testActor suppression every notification uses.
 *   7. The real admin (post author) deletes B's comment — B's bell gets a
 *      comment-deleted notification naming the admin and the post.
 *   8. B deleting their own comment stays silent (no self-notification).
 *
 * Close/reopen control (the author's other comment-thread lever):
 *   9. A closes comments via setCommentsLocked — B's addComment is
 *      rejected while closed, accepted again after reopen, and a
 *      non-author can't close someone else's post.
 *  10. Auto-close policy: a 100-comment thread on an admin-authored post
 *      closes by itself (B 41 + C 59, both under the 60/hour budget),
 *      rejects new comments, heads-up notifies the author's bell once —
 *      both in listNotifications AND the shell unread badge
 *      (shellCounts), which the re-close never re-bumps while the weekly
 *      cooldown is active — and after the cooldown (marker backdated past
 *      8 days) the guard re-notifies exactly once. The author's per-post
 *      opt-out reopens it, and a non-author can't change it.
 *  11. Post-deletion sweep: the historical leak (a comment flood whose
 *      rows dangle after the post dies) is reproduced and asserted clean.
 *      Test-actor floods are suppressed by the isolation layer, so the
 *      flood is driven by the REAL admin (a non-test actor) commenting on
 *      a test-authored post — 12 real "comment" rows land on the
 *      author's bell and the unread badge ticks up by exactly 12. Deleting
 *      the post sweeps every one of them (bell + unread badge back to
 *      baseline), and the dangling-row purge finds zero. (The harness
 *      clears the admin's comment budget first, so the flood is
 *      deterministic even when other healthcheck runs in the same hour
 *      share the admin account.)
 *
 * All fixtures (users, posts, comments, notifications) are erased at the
 * end, so the site is left exactly as found. Run:
 *
 *   TEST_HARNESS_SECRET=<secret> npm run qa:post-author-delete
 *
 * Overrides: CONVEX_URL (default the production deployment). Exit codes:
 * 0 all checks passed, 1 a check failed, 2 missing secret / harness off.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { purgeAllDanglingNotifications } from "./lib/qa-notifs.mjs";
import { powProof } from "./lib/qa-pow.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;

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

/** The comment-deleted notification rows currently visible to a user. */
async function deletionNotifs(client) {
  const r = await client.query(api.notifications.listNotifications, {
    paginationOpts: { numItems: 50, cursor: null },
  });
  return r.page.filter((n) => n.type === "comment-deleted");
}

async function main() {
  if (!HARNESS_SECRET) {
    console.log(
      "TEST_HARNESS_SECRET is required (the harness mints throwaway QA sessions).",
    );
    process.exit(2);
  }
  console.log(`\nPureWire production post-author deletion QA (${CONVEX_URL})\n`);
  const client = new ConvexHttpClient(CONVEX_URL);
  const { enabled } = await client.query(api.testHarness.isEnabled);
  if (!enabled) {
    console.log("The QA harness is disabled on this deployment — enable it with");
    console.log("TEST_HARNESS_ENABLED=1 + TEST_HARNESS_SECRET to run this check.");
    process.exit(2);
  }

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let admin = null;
  let adminPostId = null;
  let closePostId = null;
  let autoClosePostId = null;
  // The admin's auto-close heads-up rows to remove after the run.
  let adminNotifIds = [];
  const users = [];

  try {
    // ── Fixtures: A (post author), B (commenter), C (third party) ──────
    const names = [
      { name: `QA PostAuth ${stamp}`, username: `qa_postauth_${stamp}` },
      { name: `QA PostCmt ${stamp}`, username: `qa_postcmt_${stamp}` },
      { name: `QA PostThird ${stamp}`, username: `qa_postthird_${stamp}` },
    ];
    for (const u of names) {
      const created = await client.mutation(api.testHarness.createTestUser, {
        ...u,
        secret: HARNESS_SECRET,
      });
      users.push(created);
    }
    const [a, b, c] = users;
    check(
      "created three throwaway QA accounts",
      Boolean(a?.token && b?.token && c?.token),
    );
    if (!a?.userId || !b?.userId || !c?.userId) throw new Error("fixture mint failed");
    const ac = new ConvexHttpClient(CONVEX_URL);
    ac.setAuth(a.token);
    const bc = new ConvexHttpClient(CONVEX_URL);
    bc.setAuth(b.token);
    const cc = new ConvexHttpClient(CONVEX_URL);
    cc.setAuth(c.token);

    // ── 1. A posts; B comments; A deletes B's comment ──────────────────
    console.log("\n1. Permission matrix");
    const postRes = await ac.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: `Post-author delete QA ${stamp}`,
      ...(await powProof(client)),
    });
    check("A created the post", postRes.ok === true, postRes.error ?? "");
    if (!postRes.ok) throw new Error("post creation failed");
    const postId = postRes.postId;

    const b1 = await bc.mutation(api.posts.addComment, {
      postId,
      content: `B's comment ${stamp}`,
      ...(await powProof(client)),
    });
    check("B commented on A's post", b1.ok === true, b1.error ?? "");
    await sleep(250);
    const findB = async (content) => {
      const l = await bc.query(api.posts.listComments, {
        postId,
        sort: "newest",
        paginationOpts: { numItems: 20, cursor: null },
      });
      const row = l.page.find((x) => x.content === content);
      return row ? row._id : null;
    };
    const b1Id = await findB(`B's comment ${stamp}`);
    check("B's comment is visible", b1Id !== null);

    await ac.mutation(api.posts.deleteComment, { commentId: b1Id });
    const afterDelete = await bc.query(api.posts.listComments, {
      postId,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    check(
      "post author deleted B's comment",
      !afterDelete.page.some((x) => x._id === b1Id),
    );
    const postAfter = await ac.query(api.posts.getPost, { postId });
    check(
      "commentCount returned to zero",
      (postAfter?.commentCount ?? -1) === 0,
      `got ${postAfter?.commentCount}`,
    );
    check(
      "the auto-close thresholds are hydrated on posts",
      postAfter?.commentsAutoCloseCount === 100 &&
        postAfter?.commentsAutoCloseAgeMs === 30 * 24 * 60 * 60 * 1000,
      `count ${postAfter?.commentsAutoCloseCount}, age ${postAfter?.commentsAutoCloseAgeMs}`,
    );

    // ── 2. Negative: a third party cannot delete ───────────────────────
    const b2 = await bc.mutation(api.posts.addComment, {
      postId,
      content: `B's second ${stamp}`,
      ...(await powProof(client)),
    });
    check("B commented again", b2.ok === true, b2.error ?? "");
    await sleep(250);
    const b2Id = await findB(`B's second ${stamp}`);
    let thirdRejected = false;
    try {
      await cc.mutation(api.posts.deleteComment, { commentId: b2Id });
    } catch {
      thirdRejected = true;
    }
    const afterC = await bc.query(api.posts.listComments, {
      postId,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    check(
      "third party cannot delete B's comment",
      thirdRejected && afterC.page.some((x) => x._id === b2Id),
    );

    // ── 3. Reply sweep: deleting the root takes the thread ─────────────
    console.log("\n2. Reply-thread sweep");
    const b3 = await bc.mutation(api.posts.addComment, {
      postId,
      content: `B's third ${stamp}`,
      ...(await powProof(client)),
    });
    check("B commented a third time", b3.ok === true, b3.error ?? "");
    await sleep(250);
    const b3Id = await findB(`B's third ${stamp}`);
    const r1 = await bc.mutation(api.posts.addComment, {
      postId,
      parentId: b3Id,
      content: `B's reply ${stamp}`,
      ...(await powProof(client)),
    });
    check("B replied to their comment", r1.ok === true, r1.error ?? "");
    await sleep(250);
    const repliesBefore = await bc.query(api.posts.listReplies, {
      postId,
      parentId: b3Id,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    const replyId = repliesBefore.page.find((x) => x.content === `B's reply ${stamp}`)?._id;
    check("the reply is listed under the parent", replyId !== null);

    await ac.mutation(api.posts.deleteComment, { commentId: b3Id });
    const afterSweep = await bc.query(api.posts.listComments, {
      postId,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    const postAfterSweep = await ac.query(api.posts.getPost, { postId });
    check(
      "deleting the root swept the whole thread",
      !afterSweep.page.some((x) => x._id === b3Id || x._id === replyId),
    );
    // The count at this point is 3 (B's second, third, and the reply)
    // and the sweep removed the root + its reply (2 rows), so the honest
    // result is 1 — B's second comment from the earlier check survives.
    check(
      "commentCount stayed honest after the sweep",
      (postAfterSweep?.commentCount ?? -1) === 1,
      `got ${postAfterSweep?.commentCount}`,
    );

    // ── 4. Direct reply delete keeps the parent's replyCount honest ────
    const b4 = await bc.mutation(api.posts.addComment, {
      postId,
      content: `B's fourth ${stamp}`,
      ...(await powProof(client)),
    });
    check("B commented a fourth time", b4.ok === true, b4.error ?? "");
    await sleep(250);
    const b4Id = await findB(`B's fourth ${stamp}`);
    await bc.mutation(api.posts.addComment, {
      postId,
      parentId: b4Id,
      content: `orphan reply ${stamp}`,
      ...(await powProof(client)),
    });
    await sleep(250);
    const replies2 = await bc.query(api.posts.listReplies, {
      postId,
      parentId: b4Id,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    const orphanId = replies2.page.find((x) => x.content === `orphan reply ${stamp}`)?._id;
    check("the second reply is listed", orphanId !== null);

    await ac.mutation(api.posts.deleteComment, { commentId: orphanId });
    const repliesAfter = await bc.query(api.posts.listReplies, {
      postId,
      parentId: b4Id,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    check(
      "direct reply delete removed just the reply",
      !repliesAfter.page.some((x) => x._id === orphanId),
    );
    // The parent is a top-level comment — its replyCount lives on the
    // listComments row, so re-read it there.
    const topAfter = await bc.query(api.posts.listComments, {
      postId,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    const b4Row = topAfter.page.find((x) => x._id === b4Id);
    check(
      "parent replyCount decremented to zero",
      (b4Row?.replyCount ?? -1) === 0,
      `got ${b4Row?.replyCount}`,
    );

    // ── 5. Notification side effects ───────────────────────────────────
    console.log("\n3. Notification side effects (removals aren't silent)");
    const countFor = (arr) => arr.length;

    // 5a. A QA deleter (test account) stays silent.
    const b5 = await bc.mutation(api.posts.addComment, {
      postId,
      content: `B's fifth ${stamp}`,
      ...(await powProof(client)),
    });
    check("B commented a fifth time", b5.ok === true, b5.error ?? "");
    await sleep(250);
    const b5Id = await findB(`B's fifth ${stamp}`);
    const beforeSuppressed = countFor(await deletionNotifs(bc));
    await ac.mutation(api.posts.deleteComment, { commentId: b5Id });
    const afterSuppressed = countFor(await deletionNotifs(bc));
    check(
      "a QA deleter never pings the comment author",
      afterSuppressed === beforeSuppressed,
      `${beforeSuppressed} -> ${afterSuppressed}`,
    );

    // 5b. The real admin (post author) deleting B's comment notifies B.
    admin = await client.mutation(api.testHarness.mintAdminSession, {
      secret: HARNESS_SECRET,
    });
    check("minted a real admin session (non-test actor)", Boolean(admin?.token));
    const adm = new ConvexHttpClient(CONVEX_URL);
    adm.setAuth(admin.token);
    const adminPost = await adm.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: `Post-author notification QA ${stamp}`,
      ...(await powProof(client)),
    });
    check("admin created a post", adminPost.ok === true, adminPost.error ?? "");
    if (!adminPost.ok) throw new Error("admin post creation failed");
    adminPostId = adminPost.postId;

    const b6 = await bc.mutation(api.posts.addComment, {
      postId: adminPostId,
      content: `B's admin-post comment ${stamp}`,
      ...(await powProof(client)),
    });
    check("B commented on the admin's post", b6.ok === true, b6.error ?? "");
    await sleep(250);
    const adminList = await bc.query(api.posts.listComments, {
      postId: adminPostId,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    const b6Id = adminList.page.find(
      (x) => x.content === `B's admin-post comment ${stamp}`,
    )?._id;
    check("B's comment on the admin's post resolved", b6Id !== null);

    const beforeNotify = countFor(await deletionNotifs(bc));
    await adm.mutation(api.posts.deleteComment, { commentId: b6Id });
    const notifs = await deletionNotifs(bc);
    check(
      "post author delete notified the comment author",
      notifs.length === beforeNotify + 1 &&
        notifs.some(
          (n) =>
            n.actorId === admin.userId &&
            n.postId === adminPostId &&
            n.read === false,
        ),
      `count ${beforeNotify} -> ${notifs.length}`,
    );

    // 5c. Self-delete stays silent.
    const b7 = await bc.mutation(api.posts.addComment, {
      postId: adminPostId,
      content: `B's self ${stamp}`,
      ...(await powProof(client)),
    });
    check("B commented on the admin's post again", b7.ok === true, b7.error ?? "");
    await sleep(250);
    const selfList = await bc.query(api.posts.listComments, {
      postId: adminPostId,
      sort: "newest",
      paginationOpts: { numItems: 20, cursor: null },
    });
    const b7Id = selfList.page.find((x) => x.content === `B's self ${stamp}`)?._id;
    await bc.mutation(api.posts.deleteComment, { commentId: b7Id });
    const afterSelf = countFor(await deletionNotifs(bc));
    check(
      "self-delete stays silent",
      afterSelf === notifs.length,
      `count ${notifs.length} -> ${afterSelf}`,
    );

    // ── 4. Close/reopen comments (author control) ──────────────────────
    console.log("\n4. Close/reopen comments (author control)");
    const closePost = await ac.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: `Close-comments QA ${stamp}`,
      ...(await powProof(client)),
    });
    check(
      "A created a post for the close check",
      closePost.ok === true,
      closePost.error ?? "",
    );
    if (!closePost.ok) throw new Error("close-check post creation failed");
    closePostId = closePost.postId;

    await ac.mutation(api.posts.setCommentsLocked, {
      postId: closePostId,
      locked: true,
    });
    const lockedPost = await ac.query(api.posts.getPost, { postId: closePostId });
    check("author closed comments", lockedPost?.commentsLocked === true);

    let closedRejected = false;
    try {
      await bc.mutation(api.posts.addComment, {
        postId: closePostId,
        content: `blocked while closed ${stamp}`,
        ...(await powProof(client)),
      });
    } catch {
      closedRejected = true;
    }
    check("comments rejected while closed", closedRejected);

    await ac.mutation(api.posts.setCommentsLocked, {
      postId: closePostId,
      locked: false,
    });
    const reopened = await bc.mutation(api.posts.addComment, {
      postId: closePostId,
      content: `accepted after reopen ${stamp}`,
      ...(await powProof(client)),
    });
    check("comments accepted after reopen", reopened.ok === true, reopened.error ?? "");

    let nonAuthorRejected = false;
    try {
      await bc.mutation(api.posts.setCommentsLocked, {
        postId: closePostId,
        locked: true,
      });
    } catch {
      nonAuthorRejected = true;
    }
    check("only the author can close comments", nonAuthorRejected);

    // ── 5. Auto-close policy (age/comment-count) + per-post opt-out ─────
    // The count leg of the policy: a post that crosses the comment-count
    // threshold (100) closes by itself. Each run mints fresh users, so the
    // 60-comments-per-hour budget is clean — B adds 41 and C adds 59
    // (both under 60), reaching exactly 100 on the post. The post is the
    // ADMIN's (a non-test author), so the auto-close heads-up lands on a
    // real bell and the notification path is exercised — the run cleans
    // that row back up at the end.
    console.log("\n5. Auto-close policy + per-post opt-out + notification");
    const autoClosePost = await adm.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: `Auto-close QA ${stamp}`,
      ...(await powProof(client)),
    });
    check(
      "the admin created a post for the auto-close check",
      autoClosePost.ok === true,
      autoClosePost.error ?? "",
    );
    if (!autoClosePost.ok) throw new Error("auto-close post creation failed");
    autoClosePostId = autoClosePost.postId;

    const flood = async (client, prefix, n) => {
      for (let i = 0; i < n; i++) {
        await client.mutation(api.posts.addComment, {
          postId: autoClosePostId,
          content: `${prefix}-${i} ${stamp}`,
          ...(await powProof(client)),
        });
        await sleep(60); // stay gentle on the shared backend
      }
    };
    // Baseline for the shell unread badge — the flood below is what
    // triggers the auto-close heads-up, so capture it first. The admin
    // is a real account with real unread rows of its own, so the
    // assertion is a delta, never an absolute count.
    const baselineShell = await adm.query(api.notifications.shellCounts);
    await flood(bc, "b", 41);
    await flood(cc, "c", 59);
    const autoClosed = await adm.query(api.posts.getPost, {
      postId: autoClosePostId,
    });
    check(
      "100-comment thread auto-closed by the policy",
      autoClosed?.commentCount === 100 &&
        autoClosed?.commentsClosed === true &&
        autoClosed?.commentsAutoClosed === true,
      `count ${autoClosed?.commentCount}`,
    );

    // The author was told once: exactly one comment-auto-closed row on
    // their bell pointing at this post. (The filter also captures any
    // flood comment row on the same post, so cleanup below removes every
    // notification this section created on the real admin's bell — not
    // just the heads-up.)
    const adminAutoCloseNotifs = async () => {
      const r = await adm.query(api.notifications.listNotifications, {
        paginationOpts: { numItems: 50, cursor: null },
      });
      return r.page.filter((n) => n.postId === autoClosePostId);
    };
    const firstNotifs = await adminAutoCloseNotifs();
    check(
      "the auto-close heads-up reached the author's bell once",
      firstNotifs.length === 1 && firstNotifs[0].read === false,
      `got ${firstNotifs.length}`,
    );

    // And the shell badge counts it: the combined unread query the app
    // shell renders the bell badge from (shellCounts) must tick up by
    // exactly one — same row, same read:false, counted once. B's and C's
    // flood comments are test-actor pings (suppressed), so the auto-close
    // heads-up is the only new unread row on the admin's account.
    const shellAfter = await adm.query(api.notifications.shellCounts);
    check(
      "the shell unread badge counts the auto-close notification",
      shellAfter.unread === baselineShell.unread + 1,
      `${baselineShell.unread} -> ${shellAfter.unread}`,
    );

    let autoRejected = false;
    try {
      await bc.mutation(api.posts.addComment, {
        postId: autoClosePostId,
        content: `over the auto-close limit ${stamp}`,
        ...(await powProof(client)),
      });
    } catch {
      autoRejected = true;
    }
    check("new comments rejected while auto-closed", autoRejected);

    // Per-post opt-out: the author keeps this thread open forever.
    await adm.mutation(api.posts.setAutoCloseComments, {
      postId: autoClosePostId,
      keepOpen: true,
    });
    const optedOut = await adm.query(api.posts.getPost, {
      postId: autoClosePostId,
    });
    check(
      "author opt-out reopens the thread",
      optedOut?.autoCloseComments === true && optedOut?.commentsClosed === false,
    );
    const afterOptOut = await bc.mutation(api.posts.addComment, {
      postId: autoClosePostId,
      content: `accepted after opt-out ${stamp}`,
      ...(await powProof(client)),
    });
    check(
      "comments accepted after the opt-out",
      afterOptOut.ok === true,
      afterOptOut.error ?? "",
    );

    // Reverting the opt-out re-closes (the count still qualifies) — and
    // the author is NOT told again (the marker keeps it one-shot).
    await adm.mutation(api.posts.setAutoCloseComments, {
      postId: autoClosePostId,
      keepOpen: false,
    });
    const reverted = await adm.query(api.posts.getPost, {
      postId: autoClosePostId,
    });
    check(
      "reverting the opt-out re-closes the thread",
      reverted?.autoCloseComments === undefined &&
        reverted?.commentsClosed === true,
    );
    const afterRevert = await adminAutoCloseNotifs();
    check(
      "re-closing does not re-notify the author (weekly cooldown)",
      afterRevert.length === firstNotifs.length,
      `count ${firstNotifs.length} -> ${afterRevert.length}`,
    );

    // Weekly cooldown: an opted-out-then-reverted thread MAY notify again
    // once the week is up. Backdate the last-notified marker past the
    // cooldown and drive the exact guard the nightly sweep runs — it must
    // re-notify; an immediate re-run (cooldown reset) must stay quiet.
    const cooldown = await client.mutation(
      api.testHarness.recheckAutoClosedNotification,
      {
        postId: autoClosePostId,
        secret: HARNESS_SECRET,
        backdateNotifiedMs: 8 * 24 * 60 * 60 * 1000,
      },
    );
    check(
      "after the weekly cooldown a re-closed thread notifies again",
      cooldown.notified === true,
    );
    const cooldownAgain = await client.mutation(
      api.testHarness.recheckAutoClosedNotification,
      { postId: autoClosePostId, secret: HARNESS_SECRET },
    );
    check(
      "an immediate re-check stays quiet (cooldown reset)",
      cooldownAgain.notified === false,
    );
    const shellCooldown = await adm.query(api.notifications.shellCounts);
    check(
      "the shell unread badge counts exactly one cooldown re-ping",
      shellCooldown.unread === baselineShell.unread + 2,
      `${baselineShell.unread} -> ${shellCooldown.unread}`,
    );
    // Re-capture so cleanup removes BOTH heads-up rows.
    adminNotifIds = (await adminAutoCloseNotifs()).map((n) => n._id);

    let thirdPartyOptOut = false;
    try {
      await cc.mutation(api.posts.setAutoCloseComments, {
        postId: autoClosePostId,
        keepOpen: true,
      });
    } catch {
      thirdPartyOptOut = true;
    }
    check("only the author can change the opt-out", thirdPartyOptOut);

    // ── 6. Post deletion sweeps its notifications ───────────────────────
    // (bell + unread badge return to baseline, zero dangling rows). The
    // historical leak: a comment flood on a post, the post deleted, and
    // every bell row pointing at it left dangling on the recipient — the
    // unread badge inflated forever. Test-actor floods are suppressed by
    // the isolation layer, so the flood here is driven by the REAL admin
    // (a non-test actor): their comments on a test-authored post land
    // real "comment" rows on the author's bell. Deleting the post must
    // sweep every one of them (sweepPostEngagement removes postId-keyed
    // notification rows), and the dangling-row purge must find nothing.
    console.log(
      "\n6. Post deletion sweeps its notifications (bell + badge back to baseline)",
    );
    const floodRecv = await client.mutation(api.testHarness.createTestUser, {
      name: `QA FloodRecv ${stamp}`,
      username: `qa_floodrecv_${stamp}`,
      secret: HARNESS_SECRET,
    });
    users.push(floodRecv);
    check(
      "created the flood recipient (qa_ account)",
      Boolean(floodRecv?.token && floodRecv?.userId),
    );
    if (!floodRecv?.userId || !floodRecv?.token) {
      throw new Error("flood recipient mint failed");
    }
    const dc = new ConvexHttpClient(CONVEX_URL);
    dc.setAuth(floodRecv.token);
    const floodPost = await dc.action(api.posts.createPost, {
      creatorDisclosure: "human-made",
      content: `Post-deletion flood QA ${stamp}`,
      ...(await powProof(client)),
    });
    check(
      "the flood recipient created a post",
      floodPost.ok === true,
      floodPost.error ?? "",
    );
    if (!floodPost.ok) throw new Error("flood post creation failed");
    const floodPostId = floodPost.postId;

    // Baseline before the flood: the recipient's unread badge and bell.
    // Asserted as a delta, never an absolute count.
    const floodBaseline = await dc.query(api.notifications.shellCounts);
    const floodBell = async () => {
      const r = await dc.query(api.notifications.listNotifications, {
        paginationOpts: { numItems: 50, cursor: null },
      });
      return r.page.filter((n) => n.postId === floodPostId);
    };
    const bellBefore = await floodBell();
    check("the recipient's bell starts clean", bellBefore.length === 0);

    // The flood: the REAL admin (a non-test actor) comments 12 times on
    // the recipient's post — every one lands a real "comment" row on the
    // recipient's bell, exactly the leak class that used to dangle.
    // (Admins are exempt from AI escalation, and the content mirrors the
    // generic flood pattern the auto-close section already uses.) The
    // admin's comment budget is shared with real usage and every other
    // healthcheck run in the same hour — an overlapping run can leave too
    // few units free and spuriously red the gate — so the harness clears
    // the admin's comment budget first, making the flood deterministic.
    await client.mutation(api.testHarness.clearRateLimitBudget, {
      secret: HARNESS_SECRET,
      userId: admin.userId,
      action: "comment",
    });
    const FLOOD_N = 12;
    for (let i = 0; i < FLOOD_N; i++) {
      await adm.mutation(api.posts.addComment, {
        postId: floodPostId,
        content: `flood-${i} ${stamp}`,
        ...(await powProof(client)),
      });
      await sleep(60); // stay gentle on the shared backend
    }
    const bellAfter = await floodBell();
    const shellAfterFlood = await dc.query(api.notifications.shellCounts);
    check(
      "the flood landed exactly N real comment notifications",
      bellAfter.length === FLOOD_N &&
        bellAfter.every((n) => n.type === "comment" && n.read === false),
      `got ${bellAfter.length}`,
    );
    check(
      "the recipient's unread badge rose by exactly N",
      shellAfterFlood.unread === floodBaseline.unread + FLOOD_N,
      `${floodBaseline.unread} -> ${shellAfterFlood.unread}`,
    );

    // Delete the post — sweepPostEngagement must remove every
    // notification row referencing it, and the recipient's bell + unread
    // badge return to the pre-flood baseline.
    await dc.mutation(api.posts.deletePost, { postId: floodPostId });
    const bellAfterDelete = await floodBell();
    const shellAfterDelete = await dc.query(api.notifications.shellCounts);
    check(
      "deleting the post swept every notification pointing at it",
      bellAfterDelete.length === 0,
      `got ${bellAfterDelete.length}`,
    );
    check(
      "the recipient's unread badge returned to baseline",
      shellAfterDelete.unread === floodBaseline.unread,
      `${floodBaseline.unread} -> ${shellAfterDelete.unread}`,
    );

    // Zero dangling rows: the purge sweep finds nothing to remove — the
    // post is gone, its rows are gone with it, and nothing else on the
    // deployment references a deleted post/actor/recipient.
    const { total: danglingTotal } = await purgeAllDanglingNotifications(
      client,
      HARNESS_SECRET,
    );
    check(
      "zero dangling notification rows remain",
      danglingTotal === 0,
      `purged ${danglingTotal}`,
    );
  } finally {
    // ── Cleanup: admin post first (so the feed never lingers on it), ───
    // then the qa_ accounts (cascade erases posts, comments, likes,
    // notifications). Best-effort — the nightly sweep catches leftovers.
    if (adminPostId && admin) {
      try {
        const adm = new ConvexHttpClient(CONVEX_URL);
        adm.setAuth(admin.token);
        await adm.mutation(api.posts.deletePost, { postId: adminPostId });
      } catch {
        /* best-effort */
      }
    }
    // The auto-close post is the ADMIN's — delete it (with its 100
    // comments) through the admin session, and remove the heads-up bell
    // row(s) it produced so no test trace ever outlives the run on a real
    // account.
    if (autoClosePostId && admin) {
      try {
        const admCleanup = new ConvexHttpClient(CONVEX_URL);
        admCleanup.setAuth(admin.token);
        await admCleanup.mutation(api.posts.deletePost, { postId: autoClosePostId });
      } catch {
        /* best-effort */
      }
    }
    for (const notifId of adminNotifIds) {
      try {
        await client.mutation(api.testHarness.deleteNotification, {
          notificationId: notifId,
          secret: HARNESS_SECRET,
        });
      } catch {
        /* best-effort */
      }
    }
    // The close-check post is A's — delete it through A's session so the
    // fixture never lingers on the feed while the account erasure runs.
    if (closePostId && users[0]?.token) {
      try {
        const aCleanup = new ConvexHttpClient(CONVEX_URL);
        aCleanup.setAuth(users[0].token);
        await aCleanup.mutation(api.posts.deletePost, { postId: closePostId });
      } catch {
        /* best-effort */
      }
    }
    for (const u of users) {
      if (!u?.userId) continue;
      try {
        await client.mutation(api.testHarness.deleteTestUser, {
          userId: u.userId,
          secret: HARNESS_SECRET,
        });
      } catch {
        /* best-effort */
      }
    }
    console.log("\nCleanup done.");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nPost-author deletion QA crashed:", e);
  process.exit(1);
});
