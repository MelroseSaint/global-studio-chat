#!/usr/bin/env node
/**
 * PureWire profile-type identity QA.
 *
 * Drives the Creator/User declaration end to end against the live
 * deployment — the required onboarding selection, the Settings flip in
 * both directions, and badge/title propagation (the choice is "according
 * to their title": the badge label and tooltip always match the stored
 * declaration). Harness-gated like the comment-share / post-author-delete
 * checks.
 *
 * Order matters: the browser onboarding half must run while the account
 * still has NO profileType (the prompt only appears for unset accounts),
 * so the backend set/reject checks run AFTER it on the same account.
 *
 * Backend half (deterministic, harness user):
 *   1. A fresh QA account has NO profileType (nothing is assigned
 *      silently) and the profile-type prompt is what surfaces it.
 *   2. setProfileType("user") persists; getCurrentUser reflects it.
 *   3. setProfileType rejects any value that isn't exactly "creator" or
 *      "user" (a constrained enum, never arbitrary text).
 *
 * Browser half (live site, fresh session):
 *   4. The required onboarding prompt appears for the unset account;
 *      picking Creator dismisses it (selection is mandatory, and the
 *      prompt only clears once the doc updates reactively).
 *   5. Settings shows the Profile type card with Creator selected, above
 *      Photo & banner (the declaration is the first card — the ordering
 *      is pinned here so a future reorder can't silently regress); a
 *      click on User moves the selection and the note reflects USER.
 *   6. The profile page then shows the USER badge whose tooltip says the
 *      account "identifies as a User" — the title matches the choice.
 *   7. Flipping back to Creator in Settings moves the selection again and
 *      the profile badge returns to CREATOR.
 *   8. The backend set/reject checks run after the browser (the prompt
 *      needs an unset account) on the same fixture.
 *
 * All fixtures (user, sessions) are erased at the end, so the site is
 * left exactly as found. Run:
 *
 *   TEST_HARNESS_SECRET=<secret> npm run qa:profile-type
 *
 * Overrides: CONVEX_URL (default the production deployment),
 * SITE_URL (default https://purewire.vercel.app). Exit codes: 0 all
 * checks passed, 1 a check failed, 2 missing secret / harness off.
 */
import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SITE_URL =
  process.env.SITE_URL ?? "https://purewire.vercel.app";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;
const NS = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
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
  if (!HARNESS_SECRET) {
    console.log(
      "TEST_HARNESS_SECRET is required (the harness mints throwaway QA sessions).",
    );
    process.exit(2);
  }
  console.log(`\nPureWire profile-type identity QA (${SITE_URL})\n`);
  const client = new ConvexHttpClient(CONVEX_URL);
  const { enabled } = await client.query(api.testHarness.isEnabled);
  if (!enabled) {
    console.log("The QA harness is disabled on this deployment — enable it with");
    console.log("TEST_HARNESS_ENABLED=1 + TEST_HARNESS_SECRET to run this check.");
    process.exit(2);
  }

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const username = `qa_pt${stamp}`;
  let userId = null;
  let browser = null;

  try {
    // ── Fixture: one fresh QA account ──────────────────────────────────
    const created = await client.mutation(api.testHarness.createTestUser, {
      name: `ProfileType QA ${stamp}`,
      username,
      secret: HARNESS_SECRET,
    });
    check("minted a fresh QA account", Boolean(created?.token), String(created).slice(0, 60));
    if (!created?.userId || !created.token) throw new Error("fixture mint failed");
    userId = created.userId;

    const authed = new ConvexHttpClient(CONVEX_URL);
    authed.setAuth(created.token);

    // ── 1. Nothing assigned silently ───────────────────────────────────
    const before = await authed.query(api.users.getCurrentUser);
    check(
      "fresh account has NO profileType (nothing assigned silently)",
      before?.profileType === undefined,
      `got ${before?.profileType ?? "(none)"}`,
    );

    // ── 2. Browser half FIRST (the prompt needs an unset account) ──────
    browser = await chromium.launch({ headless: true });
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(25000);
    await page.addInitScript(
      (s) => {
        try {
          localStorage.setItem(`__convexAuthJWT_${s.ns}`, s.token);
          localStorage.setItem(`__convexAuthRefreshToken_${s.ns}`, s.refreshToken);
        } catch (_) {}
      },
      { token: created.token, refreshToken: created.refreshToken, ns: NS },
    );

    // 3. The required onboarding prompt appears; picking Creator clears it.
    await page.goto(`${SITE_URL}/home`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const prompt = page.getByText("What type of profile are you?", {
      exact: true,
    });
    await prompt.waitFor({ timeout: 30000 }).catch(() => {});
    check(
      "required onboarding prompt appears for the unset account",
      await prompt.isVisible().catch(() => false),
    );
    await page
      .getByRole("button", { name: /I create and publish original content/ })
      .click({ timeout: 15000 })
      .catch(() => {});
    await page.getByRole("button", { name: /Continue/ }).click({ timeout: 15000 });
    await prompt.waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
    check(
      "picking Creator dismisses the prompt (reactive doc update)",
      !(await prompt.isVisible().catch(() => false)),
    );

    // 4. Settings: Creator selected; flip to User.
    await page.goto(`${SITE_URL}/settings`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const card = page.getByText("Profile type", { exact: true });
    await card.waitFor({ timeout: 30000 }).catch(() => {});
    check("Settings shows the Profile type card", await card.isVisible().catch(() => false));
    const order = await page.evaluate(() => {
      const body = document.body.innerText;
      const pt = body.indexOf("Profile type");
      const pb = body.indexOf("Photo & banner");
      return { before: pt !== -1 && pb !== -1 && pt < pb, pt, pb };
    });
    check(
      "Profile type card renders above Photo & banner",
      order.before,
      order.before ? undefined : `pt@${order.pt} pb@${order.pb}`,
    );
    const creatorSelected = await page
      .locator('button[aria-pressed="true"]', { hasText: /^Creator/ })
      .isVisible()
      .catch(() => false);
    check("Settings reflects Creator after onboarding", creatorSelected);
    const userOption = page.locator('button[aria-pressed="false"]', {
      hasText: /^User/,
    });
    await userOption.waitFor({ timeout: 20000 }).catch(() => {});
    await userOption.click({ timeout: 15000 }).catch(() => {});
    await page
      .locator('button[aria-pressed="true"]', { hasText: /^User/ })
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    check(
      "clicking User moves the Settings selection",
      await page
        .locator('button[aria-pressed="true"]', { hasText: /^User/ })
        .isVisible()
        .catch(() => false),
    );
    check(
      "Settings note reflects USER",
      await page
        .getByText("Your profile shows the USER badge", { exact: false })
        .isVisible()
        .catch(() => false),
    );

    // 5. Profile page badge + title match the choice.
    await page.goto(`${SITE_URL}/u/${username}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const userBadge = page.locator("span", { hasText: /^User$/ }).first();
    await userBadge.waitFor({ timeout: 30000 }).catch(() => {});
    const badgeTitle = await userBadge.getAttribute("title").catch(() => null);
    check(
      "profile badge shows USER after the flip",
      await userBadge.isVisible().catch(() => false),
    );
    check(
      "badge title matches the choice (identifies as a User)",
      badgeTitle?.toLowerCase().includes("user"),
      badgeTitle ?? "(no title)",
    );

    // 6. Flip back to Creator → selection and badge follow.
    await page.goto(`${SITE_URL}/settings`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const creatorOption = page.locator('button[aria-pressed="false"]', {
      hasText: /^Creator/,
    });
    await creatorOption.waitFor({ timeout: 20000 }).catch(() => {});
    await creatorOption.click({ timeout: 15000 }).catch(() => {});
    await page
      .locator('button[aria-pressed="true"]', { hasText: /^Creator/ })
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    check(
      "flipping back moves the Settings selection to Creator",
      await page
        .locator('button[aria-pressed="true"]', { hasText: /^Creator/ })
        .isVisible()
        .catch(() => false),
    );
    await page.goto(`${SITE_URL}/u/${username}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const creatorBadge = page.locator("span", { hasText: /^Creator$/ }).first();
    await creatorBadge.waitFor({ timeout: 30000 }).catch(() => {});
    check(
      "profile badge returns to CREATOR after the flip back",
      await creatorBadge.isVisible().catch(() => false),
    );

    await browser.close();
    browser = null;

    // ── 7. Backend set/reject checks AFTER the browser (same account) ──
    // setProfileType persists both values.
    const setUser = await authed.mutation(api.users.setProfileType, {
      profileType: "user",
    });
    const afterUser = await authed.query(api.users.getCurrentUser);
    check(
      "setProfileType('user') persists to the users doc",
      setUser?.ok === true && afterUser?.profileType === "user",
      `doc=${afterUser?.profileType ?? "(none)"}`,
    );

    // Constrained enum — arbitrary text is rejected.
    let rejected = false;
    try {
      // Intentionally invalid to prove the gate: the schema validator
      // only accepts exactly "creator" or "user".
      await authed.mutation(api.users.setProfileType, {
        profileType: "superstar",
      });
    } catch {
      rejected = true;
    }
    check("setProfileType rejects anything but creator/user", rejected);

    // Server-side truth after the round trip (the doc carries the last
    // persisted choice — "user" from the backend set call above).
    const afterFlip = await authed.query(api.users.getCurrentUser);
    check(
      "users doc persisted the final choice (user)",
      afterFlip?.profileType === "user",
      `got ${afterFlip?.profileType ?? "(none)"}`,
    );
  } catch (err) {
    check(
      "QA ran without an unexpected exception",
      false,
      String(err instanceof Error ? err.stack ?? err.message : err).slice(0, 200),
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    // Cleanup — the fixture account cascades away entirely.
    if (userId !== null) {
      try {
        await client.mutation(api.testHarness.deleteTestUser, {
          userId,
          secret: HARNESS_SECRET,
        });
      } catch (err) {
        console.log(`  note: cleanup skipped — ${String(err).slice(0, 100)}`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:", failures.join(" | "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
