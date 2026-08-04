#!/usr/bin/env node
/**
 * PureWire admin-reinstatement QA check.
 *
 * Repeatable end-to-end verification of the admin restore path against a
 * real deployment. It creates a throwaway account, has an admin silence it
 * and then ban it, reinstates it with a required reason, and asserts the
 * full contract of reinstatement:
 *
 *  - the account returns to full active status (banned + shadowban lifted,
 *    silent-flag counter reset),
 *  - the moderation audit trail records a "reinstate" action with the
 *    exact reason and the acting admin,
 *  - the earlier silence and ban remain on the trail (nothing is erased),
 *  - the account drops out of the Silenced queue and its content becomes
 *    public again for other members,
 *  - the reinstated account can act normally again,
 *  - the real erasure path still cleans the throwaway up afterwards.
 *
 * The harness (convex/testHarness.ts) mints real auth sessions for the test
 * accounts — a script can't read email OTPs — and refuses to run unless the
 * deployment env has TEST_HARNESS_ENABLED=1 AND the caller proves
 * TEST_HARNESS_SECRET. To run:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> node scripts/reinstate-qa.mjs
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

// The recorded reason for the reinstatement — the script asserts the audit
// trail carries this exact string, proving the "who, when, why" contract.
const REASON = `QA reinstate — appeal granted after false-positive review ${Date.now().toString(36)}`;

async function main() {
  console.log(`\nPureWire admin-reinstatement QA — ${CONVEX_URL}\n`);

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
  const aUser = `qa_reinstate_${stamp}`;
  const bUser = `qa_viewer_${stamp}`;
  const A = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Reinstate",
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
    // ── 1. The throwaway posts something that must survive to the end ──────
    client.setAuth(A.token);
    const postRes = await client.action(api.posts.createPost, {
      content: `A public note from the reinstate QA run — ${stamp}.`,
    });
    const postId = postRes.ok === true ? postRes.postId : null;
    check("throwaway posted a public note", postRes.ok === true);

    // Trip the silent-flag system too: formulaic AI-sounding text escalates
    // +2 "ai" points (the same path shadowban-qa uses). This makes the
    // post-reinstate "counter reset" assertion meaningful — otherwise
    // silentFlags is 0 for the whole run and a regression that drops the
    // reset from reinstateAccount would go unnoticed.
    const aiText =
      "Moreover, this landscape underscores a testament to the ever-evolving " +
      "digital space. Furthermore, it is important to note that, additionally, " +
      "in conclusion, we must not overlook how notably, crucially, and " +
      "significantly this matters overall.";
    const aiRes = await client.action(api.posts.createPost, {
      content: aiText,
    });
    check("AI-suspicious post accepted into review", aiRes.ok === true);
    let s = await state();
    check(
      "silent-flag system tripped before reinstate",
      (s?.silentFlags ?? 0) >= 2,
    );

    // ── 2. Admin silences the account (quiet layer) ────────────────────────
    client.setAuth(admin.token);
    await client.mutation(api.security.setShadowban, {
      userId: A.userId,
      shadowban: true,
      standardId: "no-spam",
      note: "QA silence before reinstate",
    });
    s = await state();
    check("admin silenced the account", s?.shadowban === true);

    // ── 3. Admin bans the account (hard layer) ─────────────────────────────
    await client.mutation(api.security.setAccountStatus, {
      userId: A.userId,
      status: "banned",
      standardId: "no-taking-freedom",
      note: "QA ban before reinstate",
    });
    s = await state();
    check("admin banned the account", s?.accountStatus === "banned");

    // While moderated, the account is off the public surface for others.
    client.setAuth(B.token);
    const hiddenPost = await client.query(api.posts.getPost, { postId });
    check("moderated post is hidden from a viewer", hiddenPost === null);
    // getProfile hides by the shadowban flag (not the ban status), and the
    // shadowban survives the ban — so this check proves the silence layer
    // while the post check above proves the ban layer (hiddenAuthorIds
    // includes banned accounts).
    const hiddenProfile = await client.query(api.users.getProfile, {
      username: aUser,
    });
    check("moderated profile is hidden from a viewer", hiddenProfile === null);

    // ── 4. Admin reinstates with a required reason ─────────────────────────
    client.setAuth(admin.token);
    await client.mutation(api.security.reinstateAccount, {
      userId: A.userId,
      note: REASON,
    });

    // ── 5. Full active status is restored ──────────────────────────────────
    s = await state();
    check("account returned to active status", s?.accountStatus === "active");
    check("shadowban was lifted", s?.shadowban === false);
    check("silent-flag counter was reset", (s?.silentFlags ?? -1) === 0);

    // ── 6. The audit trail records the reinstate with the reason ───────────
    const history = await client.query(api.security.silentFlagHistory, {
      userId: A.userId,
    });
    const actions = history?.actions ?? [];
    const reinstate = actions.find((a) => a.action === "reinstate");
    check("audit trail records a reinstate action", reinstate !== undefined);
    check(
      "reinstate recorded the exact reason",
      reinstate?.note === REASON,
      `note was ${JSON.stringify(reinstate?.note ?? null)}`,
    );
    check(
      "reinstate names the acting admin",
      typeof reinstate?.actor === "string" && reinstate.actor.length > 0,
    );
    check(
      "audit trail still shows the earlier silence",
      actions.some((a) => a.action === "silence"),
    );
    check(
      "audit trail still shows the earlier ban",
      actions.some((a) => a.action === "ban"),
    );

    // The account left the Silenced queue entirely.
    const silenced = await client.query(api.security.listSilencedAccounts, {
      paginationOpts: pag,
    });
    check(
      "account dropped out of the Silenced queue",
      !silenced.page.some((u) => u._id === A.userId),
    );

    // ── 7. The account's content is public again ───────────────────────────
    client.setAuth(B.token);
    const visiblePost = await client.query(api.posts.getPost, { postId });
    check("post visible to a viewer again", visiblePost !== null);
    const visibleProfile = await client.query(api.users.getProfile, {
      username: aUser,
    });
    check("profile visible to a viewer again", visibleProfile !== null);
    const feedB = await client.query(api.posts.feed, {
      filter: "global",
      paginationOpts: pag,
    });
    check(
      "post is back in the public feed",
      feedB.page.some((p) => p._id === postId),
    );

    // ── 8. The reinstated account can act normally again ───────────────────
    client.setAuth(A.token);
    const meA = await client.query(api.users.getCurrentUser);
    check("reinstated account still loads its own session", meA !== null);

    // The member is told the outcome: a system notification lands in their
    // inbox so they learn they're active again without contacting support.
    // The message must match reinstateAccount's verbatim, or a refactor that
    // drops the notification (or rewrites the copy) fails this gate.
    const notifsA = await client.query(api.notifications.listNotifications, {
      paginationOpts: pag,
    });
    check(
      "reinstated account receives a system notification",
      notifsA.page.some(
        (n) =>
          n.type === "system" &&
          n.message === "Your account was reinstated — welcome back.",
      ),
    );
    const postAgain = await client.action(api.posts.createPost, {
      content: `Posting again after reinstatement — ${stamp}.`,
    });
    check("reinstated account can post again", postAgain.ok === true);

    // ── 9. Cleanup: the real erasure path removes the throwaways ───────────
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
    // Safety net: a crash mid-run (e.g. a rejected mutation) would otherwise
    // orphan the throwaway accounts. Sweep both through the harness's
    // deleteTestUser — it only ever touches qa_ accounts and works without
    // switching auth. On the success path this is a harmless no-op: the real
    // erasure (deleteAccount) already removed them.
    try {
      if (A?.userId) {
        await client.mutation(api.testHarness.deleteTestUser, {
          userId: A.userId,
          secret: SECRET,
        });
      }
      if (B?.userId) {
        await client.mutation(api.testHarness.deleteTestUser, {
          userId: B.userId,
          secret: SECRET,
        });
      }
    } catch {
      // Best effort — the run's result has already been reported.
    }
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
