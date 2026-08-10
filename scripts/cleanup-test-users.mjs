#!/usr/bin/env node
/**
 * Clean up leftover QA test users from the production deployment.
 *
 * The QA suite creates throwaway accounts under reserved prefixes — `qa_`
 * (the harness; testHarness.createTestUser enforces it) and `pw_e2e_`
 * (the signup e2e, whose accounts can outlive a crashed run when the
 * session can't be recovered for self-deletion) — and normally erases
 * them itself. A run that crashes hard — or a script bug — can leave one
 * behind. This script finds every remaining account under either prefix
 * and erases it with the same full sweep the admin uses (removeAccount:
 * posts, comments, follows, files, auth sessions, notifications —
 * everything), so nothing test-generated lingers in a real deployment.
 *
 * Safety: the harness gate (TEST_HARNESS_ENABLED=1 + TEST_HARNESS_SECRET)
 * must be on, exactly like every other QA script. Only usernames matching
 * the reserved test prefixes are ever touched — a real account can never
 * be matched. The owner/admin accounts are protected server-side too.
 *
 * Run:
 *   TEST_HARNESS_SECRET=<secret> node scripts/cleanup-test-users.mjs
 *   TEST_HARNESS_SECRET=<secret> npm run qa:cleanup-test-users
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { assertAdminIpVerified } from "./lib/qa-admin-ip.mjs";
import { purgeAllDanglingNotifications } from "./lib/qa-notifs.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;

if (!HARNESS_SECRET) {
  console.error("Missing TEST_HARNESS_SECRET — set it to run the cleanup.");
  process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);

async function main() {
  const { enabled } = await client.query(api.testHarness.isEnabled);
  if (!enabled) {
    console.log("(skip) the QA harness is disabled on this deployment —");
    console.log("  enable TEST_HARNESS_ENABLED=1 + TEST_HARNESS_SECRET to run.");
    return;
  }
  console.log(`Connected to ${CONVEX_URL}`);

  // Mint an admin session through the harness so removeAccount's requireAdmin
  // gate passes.
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: HARNESS_SECRET,
  });
  if (!admin?.token) {
    console.error("Could not mint an admin session.");
    process.exit(1);
  }
  const adminClient = new ConvexHttpClient(CONVEX_URL);
  adminClient.setAuth(admin.token);
  // Backend-verified device gate: bind the minted admin session to the
  // backend-observed IP or removeAccount's requireAdmin gate refuses.
  await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: admin.token });

  // Collect every QA account through the harness's dedicated reader. The
  // admin's listUsers now hides QA accounts from the production surface
  // (isolation invariant), so the sweep must not page it to find its
  // targets — listTestAccountsForSweep is the maintenance path instead.
  const targets = await client.query(api.testHarness.listTestAccountsForSweep, {
    secret: HARNESS_SECRET,
  });

  if (targets.length > 0) {
    console.log(`Found ${targets.length} test user(s) to erase:`);
    for (const u of targets) {
      console.log(`  - @${u.username} (${u.name ?? "no name"}, joined ${new Date(u.creationTime).toISOString()})`);
    }

    // Erase each with the full removeAccount sweep, citing a Standard
    // principle. removeAccount reports the post/comment counts it erased,
    // so the log shows each account's blast radius.
    let removed = 0;
    for (const u of targets) {
      try {
        const res = await adminClient.mutation(api.admin.removeAccount, {
          userId: u.userId,
          standardId: "no-spam",
          note: "Automated cleanup of leftover QA test account.",
        });
        removed++;
        const radius =
          res && (res.posts > 0 || res.comments > 0)
            ? ` (erased ${res.posts} posts, ${res.comments} comments)`
            : " (no content)";
        console.log(`  ✅ @${u.username} erased${radius}`);
      } catch (err) {
        console.error(
          `  ❌ @${u.username} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    console.log(`\nDone: ${removed}/${targets.length} QA test users erased.`);
  } else {
    console.log("No leftover QA test users found.");
  }

  // Posts the harness created AS a real account (the admin driving
  // end-to-end flows) carry the qaFixture marker — their author isn't a
  // qa_*/pwtest* handle, so the account sweep above can't reach them. A
  // crashed CI run that skipped its own finally-cleanup is exactly when
  // they linger, so erase any marked leftovers through the harness path.
  const fixtures = await client.query(api.testHarness.listQaFixturePostsForSweep, {
    secret: HARNESS_SECRET,
  });
  if (fixtures.length > 0) {
    console.log(`\nFound ${fixtures.length} qaFixture post(s) to erase:`);
    let removedPosts = 0;
    for (const p of fixtures) {
      try {
        const res = await client.mutation(api.testHarness.deleteQaFixturePost, {
          postId: p.postId,
          secret: HARNESS_SECRET,
        });
        if (res.deleted) {
          removedPosts++;
          console.log(
            `  ✅ ${String(p.postId).slice(0, 8)} erased (${JSON.stringify(p.content)})`,
          );
        }
      } catch (err) {
        console.error(
          `  ❌ ${String(p.postId).slice(0, 8)} failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
    console.log(`Done: ${removedPosts}/${fixtures.length} qaFixture posts erased.`);
  } else {
    console.log("No qaFixture posts to erase.");
  }

  // Every erasure — including test sweeps — writes a one-way removalLog
  // row. Purge the reserved-prefix entries so QA activity never pollutes
  // the audit log a real admin reads. Harness-gated, removalLog-only.
  const { purgedCount } = await client.mutation(api.testHarness.purgeTestTraces, {
    secret: HARNESS_SECRET,
  });
  console.log(
    purgedCount > 0
      ? `Removal-log test entries purged: ${purgedCount}.`
      : "Removal log already free of test entries.",
  );

  // Bell rows referencing deleted content (a post, actor, or recipient
  // that no longer exists) are fake notifications — QA flood debris that
  // survived on a real account's bell. Erase them so no unread badge is
  // inflated by a row nothing can render, and the shell badge stays
  // honest after any sweep.
  const { total: notifCount, byReason } = await purgeAllDanglingNotifications(
    client,
    HARNESS_SECRET,
  );
  if (notifCount > 0) {
    console.log(`Dangling notifications purged: ${notifCount}.`);
    console.log(`  ${JSON.stringify(byReason)}`);
  } else {
    console.log("No dangling notifications found.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
