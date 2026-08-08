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

  // Paginate every user, collecting qa_* usernames.
  const targets = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const res = await adminClient.query(api.admin.listUsers, {
      paginationOpts: { numItems: 100, cursor },
    });
    for (const u of res.page) {
      const username = (u.username ?? "").toLowerCase();
      // The reserved test prefixes every QA script uses: qa_ (harness) and
      // pw_e2e_ (signup e2e). A real account can never match these.
      if (username.startsWith("qa_") || username.startsWith("pw_e2e_")) {
        targets.push(u);
      }
    }
    if (res.isDone) break;
    cursor = res.continueCursor;
  }

  if (targets.length > 0) {
    console.log(`Found ${targets.length} test user(s) to erase:`);
    for (const u of targets) {
      console.log(`  - @${u.username} (${u.name ?? "no name"}, joined ${new Date(u._creationTime).toISOString()})`);
    }

    // Erase each with the full removeAccount sweep, citing a Standard principle.
    let removed = 0;
    for (const u of targets) {
      try {
        await adminClient.mutation(api.admin.removeAccount, {
          userId: u._id,
          standardId: "no-spam",
          note: "Automated cleanup of leftover QA test account.",
        });
        removed++;
        console.log(`  ✅ @${u.username} erased`);
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
