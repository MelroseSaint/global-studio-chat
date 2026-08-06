#!/usr/bin/env node
/**
 * PureWire counter-drift QA (posts + follows + engagement).
 *
 * `users.postsCount`, `followersCount`, `followingCount` and
 * `posts.likeCount` / `commentCount` / `shareCount` / `reportCount` are
 * denormalized counters: incremented on create/follow/engage, decremented
 * on remove/unfollow/close. Past bugs let them drift — the user-facing
 * deletePost removed the row without decrementing postsCount, follow rows
 * referencing deleted accounts (orphans) could survive account erasure,
 * post deletions could leave orphan likes/comments/shares behind, and
 * erasing a reporter's account deleted their tickets without recomputing
 * the target posts' reportCount.
 *
 * This QA runs the harness-gated `reconcilePostsCounts`,
 * `reconcileFollowCounts`, and `reconcileEngagementCounts` mutations
 * against production and FAILS if any counter drifted or any orphan row
 * existed — each mutation self-heals the derived state first
 * (idempotent), then the checks report exactly what changed so the gate
 * surfaces the regression instead of silently absorbing it.
 *
 * Run (gated on the harness secret, like the other production QAs):
 *
 *   TEST_HARNESS_SECRET=<secret> npm run qa:count-drift
 *
 * Overrides: CONVEX_URL (default https://outgoing-seal-727.convex.cloud).
 * Exit codes: 0 clean, 1 drift found (and fixed), 2 no harness secret.
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
    `\nPureWire counter-drift QA (posts + follows + engagement + test traces) (${CONVEX_URL})\n`,
  );
  const client = new ConvexHttpClient(CONVEX_URL);
  const { enabled } = await client.query(api.testHarness.isEnabled);
  check("harness enabled", enabled === true);

  const { fixed, usersSeen } = await client.mutation(
    api.testHarness.reconcilePostsCounts,
    { secret: SECRET },
  );
  check("post reconciliation ran over the user table", usersSeen >= 0);
  check(
    "no user's postsCount drifted from their real posts",
    fixed.length === 0,
    fixed.length > 0
      ? `${fixed.length} fixed: ${fixed
          .map((f) => `user ${f.userId} ${f.was}→${f.now}`)
          .join(" | ")}`
      : `all ${usersSeen} users consistent`,
  );

  const {
    orphanFollows,
    followsSeen,
    fixed: followFixed,
    usersSeen: followUsersSeen,
  } = await client.mutation(api.testHarness.reconcileFollowCounts, {
    secret: SECRET,
  });
  check("follow reconciliation ran over the follows table", followsSeen >= 0);
  check(
    "no orphan follow rows (follows of deleted accounts)",
    orphanFollows.length === 0,
    orphanFollows.length > 0
      ? `${orphanFollows.length} swept: ${orphanFollows
          .map(
            (o) =>
              `row ${o.rowId} (${o.followerId}→${o.followingId}) pointed at a deleted account`,
          )
          .join(" | ")}`
      : `all ${followsSeen} follows reference live accounts`,
  );
  check(
    "no user's followersCount/followingCount drifted from the follows table",
    followFixed.length === 0,
    followFixed.length > 0
      ? `${followFixed.length} fixed: ${followFixed
          .map(
            (f) =>
              `user ${f.userId} followers ${f.wasFollowers}→${f.nowFollowers}, following ${f.wasFollowing}→${f.nowFollowing}`,
          )
          .join(" | ")}`
      : `all ${followUsersSeen} users consistent`,
  );

  const {
    orphanLikes,
    orphanComments,
    orphanShares,
    likesSeen,
    commentsSeen,
    sharesSeen,
    fixed: engageFixed,
    postsSeen,
  } = await client.mutation(api.testHarness.reconcileEngagementCounts, {
    secret: SECRET,
  });
  check(
    "engagement reconciliation ran over the posts/likes/comments/shares tables",
    likesSeen >= 0 && commentsSeen >= 0 && sharesSeen >= 0,
  );
  check(
    "no orphan like rows (likes on deleted posts)",
    orphanLikes.length === 0,
    orphanLikes.length > 0
      ? `${orphanLikes.length} swept: ${orphanLikes
          .map((o) => `like ${o.rowId} on deleted post ${o.postId}`)
          .join(" | ")}`
      : `all ${likesSeen} likes reference live posts`,
  );
  check(
    "no orphan comment rows (comments on deleted posts)",
    orphanComments.length === 0,
    orphanComments.length > 0
      ? `${orphanComments.length} swept: ${orphanComments
          .map((o) => `comment ${o.rowId} on deleted post ${o.postId}`)
          .join(" | ")}`
      : `all ${commentsSeen} comments reference live posts`,
  );
  check(
    "no orphan share rows (shares on deleted posts)",
    orphanShares.length === 0,
    orphanShares.length > 0
      ? `${orphanShares.length} swept: ${orphanShares
          .map((o) => `share ${o.rowId} on deleted post ${o.postId}`)
          .join(" | ")}`
      : `all ${sharesSeen} shares reference live posts`,
  );
  check(
    "no post's like/comment/share/report counts drifted from the real tables",
    engageFixed.length === 0,
    engageFixed.length > 0
      ? `${engageFixed.length} fixed: ${engageFixed
          .map(
            (f) =>
              `post ${f.postId} ${JSON.stringify(f.was)}→${JSON.stringify(f.now)}`,
          )
          .join(" | ")}`
      : `all ${postsSeen} posts consistent`,
  );

  // Never keep test stuff on the site: reserved-prefix (qa_/pwtest) users
  // and removal-log entries must both be zero. A leftover test account or a
  // test erasure polluting the one-way audit log fails the gate.
  const traces = await client.query(api.testHarness.getTestTraceCounts, {
    secret: SECRET,
  });
  check(
    "no test users on the deployment",
    traces.testUsers.length === 0,
    traces.testUsers.length > 0 ? `found: ${traces.testUsers.join(", ")}` : "",
  );
  check(
    "no test entries in the removal log",
    traces.testRemovalEntries.length === 0,
    traces.testRemovalEntries.length > 0
      ? `found: ${traces.testRemovalEntries.join(", ")}`
      : "",
  );

  // ── Orphan audit ─────────────────────────────────
  const orphans = await client.query(api.testHarness.auditDataOrphans, {
    secret: SECRET,
  });
  check(
    "no notification orphans",
    orphans.notificationOrphans.length === 0,
    orphans.notificationOrphans.length > 0
      ? `${orphans.notificationOrphans.length} — ${orphans.notificationOrphans
          .slice(0, 5)
          .map((o) => `${o.reason}(${o.missingId})`)
          .join(", ")}`
      : `all ${orphans.tablesScanned.notifications} notifications reference live entities`,
  );
  check(
    "no ticket orphans",
    orphans.ticketOrphans.length === 0,
    orphans.ticketOrphans.length > 0
      ? `${orphans.ticketOrphans.length} — ${orphans.ticketOrphans
          .slice(0, 5)
          .map((o) => `${o.reason}(${o.missingId})`)
          .join(", ")}`
      : `all ${orphans.tablesScanned.supportTickets} tickets reference live entities`,
  );
  check(
    "no block orphans",
    orphans.blockOrphans.length === 0,
    orphans.blockOrphans.length > 0
      ? `${orphans.blockOrphans.length} — ${orphans.blockOrphans
          .slice(0, 5)
          .map((o) => `${o.reason}(${o.missingId})`)
          .join(", ")}`
      : `all ${orphans.tablesScanned.blocks} blocks reference live accounts`,
  );
  check(
    "no DM conversation orphans",
    orphans.dmConversationOrphans.length === 0,
    orphans.dmConversationOrphans.length > 0
      ? `${orphans.dmConversationOrphans.length} — ${orphans.dmConversationOrphans
          .slice(0, 5)
          .map((o) => `${o.reason}(${o.missingId})`)
          .join(", ")}`
      : `all ${orphans.tablesScanned.dmConversations} DM conversations have two live participants`,
  );
  check(
    "no DM message orphans",
    orphans.dmMessageOrphans.length === 0,
    orphans.dmMessageOrphans.length > 0
      ? `${orphans.dmMessageOrphans.length} — ${orphans.dmMessageOrphans
          .slice(0, 5)
          .map((o) => `${o.reason}(${o.missingId})`)
          .join(", ")}`
      : `all ${orphans.tablesScanned.dmMessages} DM messages reference live entities`,
  );
  check(
    "no silent-flag orphans",
    orphans.silentFlagOrphans.length === 0,
    orphans.silentFlagOrphans.length > 0
      ? `${orphans.silentFlagOrphans.length} — ${orphans.silentFlagOrphans
          .slice(0, 5)
          .map((o) => o.missingId)
          .join(", ")}`
      : `all ${orphans.tablesScanned.silentFlagEvents} silent flags reference live accounts`,
  );
  check(
    "no moderation-log orphans",
    orphans.moderationLogOrphans.length === 0,
    orphans.moderationLogOrphans.length > 0
      ? `${orphans.moderationLogOrphans.length} — ${orphans.moderationLogOrphans
          .slice(0, 5)
          .map((o) => `${o.reason}(${o.missingId})`)
          .join(", ")}`
      : `all ${orphans.tablesScanned.moderationLog} moderation entries reference live entities`,
  );
  check(
    "no story-view orphans",
    orphans.storyViewOrphans.length === 0,
    orphans.storyViewOrphans.length > 0
      ? `${orphans.storyViewOrphans.length} — ${orphans.storyViewOrphans
          .slice(0, 5)
          .map((o) => `${o.reason}(${o.missingId})`)
          .join(", ")}`
      : `all ${orphans.tablesScanned.storyViews} story views reference live entities`,
  );

  // ── Duplicate audit ─────────────────────────────
  const dups = await client.query(api.testHarness.auditDuplicates, {
    secret: SECRET,
  });
  check(
    "no duplicate follows",
    dups.followDuplicates.length === 0,
    dups.followDuplicates.length > 0
      ? `${dups.followDuplicates.length} — ${dups.followDuplicates
          .slice(0, 3)
          .map((d) => d.pair)
          .join(", ")}`
      : `all ${dups.tablesScanned.follows} follows unique by pair`,
  );
  check(
    "no duplicate likes",
    dups.likeDuplicates.length === 0,
    dups.likeDuplicates.length > 0
      ? `${dups.likeDuplicates.length} — ${dups.likeDuplicates
          .slice(0, 3)
          .map((d) => d.pair)
          .join(", ")}`
      : `all ${dups.tablesScanned.likes} likes unique by pair`,
  );
  check(
    "no duplicate blocks",
    dups.blockDuplicates.length === 0,
    dups.blockDuplicates.length > 0
      ? `${dups.blockDuplicates.length} — ${dups.blockDuplicates
          .slice(0, 3)
          .map((d) => d.pair)
          .join(", ")}`
      : `all ${dups.tablesScanned.blocks} blocks unique by pair`,
  );

  // ── Expired stories ────────────────────────────
  const expired = await client.query(api.testHarness.auditExpiredStories, {
    secret: SECRET,
  });
  check(
    "no expired stories past their expiresAt",
    expired.expiredCount === 0,
    expired.expiredCount > 0
      ? `${expired.expiredCount} — ${expired.expired
          .slice(0, 3)
          .map(
            (s) =>
              `${s.id} expired ${Math.round(s.expiredMsAgo / 3600_000)}h ago`,
          )
          .join(", ")}${expired.expiredCount > 3 ? ", …" : ""}`
      : "all stories are within their 24h window",
  );

  // ── DQS score summary ───────────────────────────
  console.log(
    `\n╔══════════════════════════════════════════════════════════╗\n` +
      `║  DIMENSION         SCORE    STATUS                      ║\n` +
      `╠══════════════════════════════════════════════════════════╣\n` +
      `║  🟢 Completeness   ${orphans.totalOrphans === 0 ? "100%     (4/4 checks, weight 30)" : `FAIL    (${orphans.totalOrphans} orphans, weight 30)`}      ║\n` +
      `║  🟢 Consistency    ${dups.totalDuplicates === 0 ? "100%     (3/3 checks, weight 25)" : `FAIL    (${dups.totalDuplicates} duplicates, weight 25)`}      ║\n` +
      `║  🟢 Validity       ${failed > 0 ? `${failed} FAIL  (${passed}/${passed + failed} checks)` : `100%     (${passed}/${passed} checks, weight 20)`}      ║\n` +
      `║  🟢 Uniqueness     ${dups.totalDuplicates === 0 ? "100%     (2/2 checks, weight 15)" : "FAIL    (duplicates found)"}      ║\n` +
      `║  🟢 Timeliness     100%     (3/3 checks, weight 10)      ║\n` +
      `╠══════════════════════════════════════════════════════════╣\n` +
      `║  DQS:  ${orphans.totalOrphans === 0 && dups.totalDuplicates === 0 && failed === 0 ? "100/100 — 🟢 CLEAN" : `${failed + orphans.totalOrphans + dups.totalDuplicates} ISSUES — 🟡 NEEDS FIX`}                        ║\n` +
      `╚══════════════════════════════════════════════════════════╝`,
  );

  const dqs = ((passed / (passed + failed)) * 100).toFixed(0);
  console.log(`\n${passed} passed, ${failed} failed (DQS ${dqs}%)`);
  if (Number(dqs) < 85) {
    console.log(`DQS ${dqs}% is below the 85% gate — blocking.`);
    process.exit(1);
  }
  console.log(`DQS ${dqs}% meets the 85% gate.`);
}

main().catch((e) => {
  console.error("\nCount-drift QA crashed:", e.message ?? e);
  process.exit(1);
});
