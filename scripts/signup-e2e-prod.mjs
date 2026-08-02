#!/usr/bin/env node
/**
 * PureWire production full auth-loop E2E.
 *
 * Drives a real Chromium (Playwright) through the complete lifecycle of a
 * fresh throwaway account on the live site:
 *
 *  1. Sign up (email + password) and land on the email-verify step.
 *  2. Read the verification code straight from Resend's API (the account
 *     owns RESEND_API_KEY, so the code is retrieved server-side without
 *     needing the recipient's inbox) and complete verification.
 *  3. Confirm the dashboard loads with a live session.
 *  4. Forgot password → reset code (again read from Resend) → new password.
 *  5. Prove the OLD password is rejected and sign-in with the NEW password
 *     works.
 *
 * This is the full-loop proof that the OTP pipeline works in production:
 * account created -> code email sent -> code accepted -> session established
 * -> password reset -> new credential accepted. The throwaway account is
 * erased at the end (success or failure) so no test data is left behind.
 *
 * Run:
 *
 *   RESEND_API_KEY=<key> npm run qa:signup-e2e
 *
 * Overrides: SITE_URL (default https://outgoing-seal-727.convex.site),
 * CONVEX_URL (default the same deployment's backend), RESEND_API_URL
 * (default https://api.resend.com), HEADED=1 to watch the browser on
 * screen, BROWSER_TIMEOUT_MS (default 20000).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing key.
 */
import { chromium } from "playwright";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const SITE_URL = process.env.SITE_URL ?? "https://outgoing-seal-727.convex.site";
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const RESEND_API_URL = process.env.RESEND_API_URL ?? "https://api.resend.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 20000);
const NAV_TIMEOUT = 45000;
// Codes expire in 10 minutes server-side; poll for each for at most ~60s.
const CODE_POLL_SECONDS = 60;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Detect the Turnstile gate state (mirrors admin-auth-browser-qa.mjs). */
async function detectTurnstile(page) {
  const widget = page.locator(".cf-turnstile");
  if ((await widget.count()) === 0) return "inactive";
  try {
    await page.waitForSelector(".cf-turnstile iframe", { timeout: 15000 });
  } catch {
    return "blocked";
  }
  try {
    await page.waitForFunction(
      () => {
        const input = document.querySelector(
          'input[name="cf-turnstile-response"]',
        );
        return input !== null && input.value.length > 0;
      },
      { timeout: 20000 },
    );
    return "passed";
  } catch {
    return "blocked";
  }
}

/**
 * Find the code email sent to `to` and return its body text. Resend's
 * GET /emails/{id} includes the rendered html/text of the sent message, so
 * the code can be read without the recipient's inbox. `subjectPattern`
 * disambiguates which email to read (verification vs reset).
 */
async function fetchCodeFromResend(
  to,
  subjectPattern = /verify|code|purewire/i,
) {
  const headers = { Authorization: `Bearer ${RESEND_API_KEY}` };
  const deadline = Date.now() + CODE_POLL_SECONDS * 1000;
  let last = "email not seen yet";
  while (Date.now() < deadline) {
    let list = null;
    try {
      const res = await fetch(
        `${RESEND_API_URL}/emails?to=${encodeURIComponent(to)}`,
        { headers },
      );
      list = res.ok ? await res.json() : null;
    } catch {
      list = null;
    }
    // The ?to= filter is best-effort; the client-side match is the
    // authoritative check either way.
    const email = list?.data?.find(
      (e) =>
        (e.to ?? []).some((t) => t.toLowerCase() === to.toLowerCase()) &&
        subjectPattern.test(e.subject ?? ""),
    );
    if (email) {
      const full = await fetch(`${RESEND_API_URL}/emails/${email.id}`, {
        headers,
      });
      if (full.ok) {
        const body = await full.json();
        const text = body.text ?? body.html ?? "";
        const match = text.match(/\b(\d{6})\b/);
        if (match) return match[1];
        last = "email found but no 6-digit code in body";
      }
    }
    await sleep(2000);
  }
  throw new Error(`Code email never appeared (${last})`);
}

/** Read the namespaced auth tokens out of the page's localStorage. */
async function readStoredTokens(page) {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const jwtKey = keys.find((k) => /JWT/i.test(k));
    const refreshKey = keys.find((k) => /RefreshToken|refresh/i.test(k));
    return {
      jwt: jwtKey ? localStorage.getItem(jwtKey) : null,
      refresh: refreshKey ? localStorage.getItem(refreshKey) : null,
    };
  });
}

/** Wait for the dashboard to render (Global tab visible). */
async function dashboardVisible(page) {
  return page
    .getByRole("tab", { name: "Global" })
    .first()
    .waitFor({ state: "visible", timeout: NAV_TIMEOUT })
    .then(() => true)
    .catch(() => false);
}

/** Sign out from the sidebar and land back on the landing page. */
async function signOut(page) {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page
    .waitForURL(`${SITE_URL}/`, { timeout: NAV_TIMEOUT })
    .catch(() => {});
}

async function main() {
  if (!RESEND_API_KEY) {
    console.log("RESEND_API_KEY is not set. Run with:");
    console.log("  RESEND_API_KEY=<key> npm run qa:signup-e2e");
    process.exit(2);
  }

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const username = `pw_e2e_${stamp}`;
  // No dots or + suffixes: PureWire normalizes gmail addresses (strips dots
  // and plus-tags) before hashing, so the code lands at the stripped form.
  // A dot-free address is its own normalized form — the Resend lookup below
  // is guaranteed to match.
  const email = `pwe2e${stamp}@gmail.com`;
  const password = `PureWire!${stamp}`;
  const newPassword = `PureWire2!${stamp}`;
  // Tracks which credential is currently valid so cleanup can recover a
  // session even after the password was reset mid-flow.
  let currentPassword = password;
  console.log(`\nPureWire production full auth-loop E2E (${SITE_URL})`);
  console.log(`  account: ${username} <${email}>\n`);

  const convex = new ConvexHttpClient(CONVEX_URL);
  const browser = await chromium.launch({ headless: !HEADED });

  // State handed between the flow and cleanup.
  let accountCreated = false; // verify step reached = the account exists
  let jwt = null; // the browser session token, once a session is live
  let erased = false;

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(TIMEOUT);

    // 1. Open the auth page and switch to the sign-up tab.
    await page.goto(`${SITE_URL}/auth`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#email", { timeout: TIMEOUT });
    await page.getByRole("tab", { name: "Sign up" }).click();
    await page.waitForSelector("#username", { timeout: TIMEOUT });
    check("auth page rendered (sign-up form visible)", true);

    // 2. Human-check gate (expected inactive on this deployment).
    const gate = await detectTurnstile(page);
    if (gate === "inactive") {
      check("Turnstile gate inactive on this deployment (no site key)", true);
    } else {
      check("Turnstile gate widget present", true);
      check("Turnstile gate passed (token produced)", gate === "passed");
      if (gate === "blocked") return;
    }

    // 3. Fill the sign-up form and submit.
    await page.fill("#username", username);
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.locator('form button[type="submit"]').click();

    // 4. The sign-up must land on the email-verify step.
    const onVerify = await page
      .waitForSelector("#code", { timeout: NAV_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    check(
      "sign-up reached the email-verify step",
      onVerify,
      onVerify ? "" : `page stayed on ${page.url()}`,
    );
    if (!onVerify) {
      const err = await page
        .locator('p[class*="text-destructive"]')
        .first()
        .textContent()
        .catch(() => "");
      if (err) check("no inline auth error", false, err.trim());
      return;
    }
    accountCreated = true;

    // 5. Read the verification code out of Resend.
    let code = null;
    try {
      code = await fetchCodeFromResend(email);
    } catch (err) {
      check("verification code retrieved from Resend", false, err.message);
    }
    check(
      "verification code retrieved from Resend",
      typeof code === "string" && code.length === 6,
      code ? `code ${code.slice(0, 2)}••••` : "",
    );
    if (!code) return;

    // 6. Submit the code and confirm the dashboard loads.
    await page.fill("#code", code);
    await page.locator('form button[type="submit"]').click();
    const onHome = await page
      .waitForURL("**/home", { timeout: NAV_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    check("verification accepted — redirected to /home", onHome, onHome ? "" : page.url());
    if (!onHome) {
      const err = await page
        .locator('p[class*="text-destructive"]')
        .first()
        .textContent()
        .catch(() => "");
      if (err) check("no inline auth error", false, err.trim());
      return;
    }

    check("dashboard feed rendered (Global tab)", await dashboardVisible(page));
    check(
      "composer present",
      (await page.getByPlaceholder("Say it anyway…").count()) > 0,
    );

    // A real sign-up must not be bounced straight back to /auth by the
    // self-healing session check — wait a beat and confirm we're still on
    // the dashboard with a live session.
    await sleep(2000);
    const stillHome = page.url().includes("/home");
    check(
      "session holds after settle (no bounce to /auth)",
      stillHome,
      stillHome ? "" : `bounced to ${page.url()}`,
    );

    // 7. The session must be live in the browser. The auth client stores
    //    its keys namespaced (__convexAuthJWT_<ns>), so scan for them
    //    instead of assuming the bare key names.
    let stored = await readStoredTokens(page);
    jwt = stored.jwt;
    check("session JWT stored", typeof jwt === "string" && jwt.length > 20);
    check(
      "session refresh token stored",
      typeof stored.refresh === "string" && stored.refresh.length > 20,
    );
    check(
      "session resolves server-side",
      typeof jwt === "string"
        ? (await (async () => {
            convex.setAuth(jwt);
            const me = await convex
              .query(api.users.getCurrentUser)
              .catch(() => null);
            convex.clearAuth();
            return me !== null && me.username === username;
          })())
        : false,
    );

    // 8. Full auth loop — forgot password → reset code → new password.
    // 8a. Sign out to start the reset journey from a clean slate.
    await signOut(page);
    check(
      "signed out before the reset flow",
      page.url() === `${SITE_URL}/`,
      page.url(),
    );

    // 8b. Request a password reset for the same throwaway account.
    await page.goto(`${SITE_URL}/auth`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#email", { timeout: TIMEOUT });
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await page.waitForSelector("#forgot-email", { timeout: TIMEOUT });
    await page.fill("#forgot-email", email);
    await page.locator('form button[type="submit"]').click();
    const onResetStep = await page
      .waitForSelector("#reset-code", { timeout: NAV_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    check(
      "forgot-password reached the reset step",
      onResetStep,
      onResetStep ? "" : `page stayed on ${page.url()}`,
    );
    if (!onResetStep) {
      const err = await page
        .locator('p[class*="text-destructive"]')
        .first()
        .textContent()
        .catch(() => "");
      if (err) check("no inline auth error", false, err.trim());
      return;
    }

    // 8c. Read the reset code out of Resend (subject: Reset your PureWire
    //     password).
    let resetCode = null;
    try {
      resetCode = await fetchCodeFromResend(email, /reset/i);
    } catch (err) {
      check("reset code retrieved from Resend", false, err.message);
    }
    check(
      "reset code retrieved from Resend",
      typeof resetCode === "string" && resetCode.length === 6,
      resetCode ? `code ${resetCode.slice(0, 2)}••••` : "",
    );
    if (!resetCode) return;

    // 8d. Set the new password.
    await page.fill("#reset-code", resetCode);
    await page.fill("#new-password", newPassword);
    await page.locator('form button[type="submit"]').click();
    const resetDone = await page
      .waitForURL("**/home", { timeout: NAV_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    check(
      "new password accepted — redirected to /home",
      resetDone,
      resetDone ? "" : page.url(),
    );
    if (!resetDone) {
      const err = await page
        .locator('p[class*="text-destructive"]')
        .first()
        .textContent()
        .catch(() => "");
      if (err) check("no inline auth error", false, err.trim());
      return;
    }
    currentPassword = newPassword;
    check("dashboard after reset", await dashboardVisible(page));

    // 8e. The OLD password must no longer work. Race the inline error
    //     against a redirect so an unexpected successful sign-in fails fast
    //     instead of burning the full navigation timeout.
    await signOut(page);
    await page.goto(`${SITE_URL}/auth`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#email", { timeout: TIMEOUT });
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.locator('form button[type="submit"]').click();
    const oldPasswordOutcome = await Promise.race([
      page
        .waitForURL("**/home", { timeout: NAV_TIMEOUT })
        .then(() => "signed-in"),
      page
        .waitForSelector('p[class*="text-destructive"]', {
          timeout: NAV_TIMEOUT,
        })
        .then(() => "rejected"),
    ]);
    check(
      "old password rejected",
      oldPasswordOutcome === "rejected",
      oldPasswordOutcome === "signed-in" ? `unexpectedly signed in (${page.url()})` : "",
    );
    if (oldPasswordOutcome !== "rejected") return;

    // 8f. Sign in with the NEW password and confirm the dashboard.
    await page.fill("#password", newPassword);
    await page.locator('form button[type="submit"]').click();
    const backHome = await page
      .waitForURL("**/home", { timeout: NAV_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    check(
      "sign-in with the new password works",
      backHome,
      backHome ? "" : page.url(),
    );
    if (!backHome) {
      const err = await page
        .locator('p[class*="text-destructive"]')
        .first()
        .textContent()
        .catch(() => "");
      if (err) check("no inline auth error", false, err.trim());
      return;
    }
    check("dashboard after new-password sign-in", await dashboardVisible(page));

    // 8g. Capture the fresh session for cleanup.
    stored = await readStoredTokens(page);
    jwt = stored.jwt;
    check(
      "fresh session JWT stored after new-password sign-in",
      typeof jwt === "string" && jwt.length > 20,
    );
  } finally {
    // Erase the throwaway account on every exit path — success or failure —
    // before the browser closes. Only claims success when the delete call
    // actually went through. If the current session token is gone, signing
    // in with the currently-valid password (which may be the reset one)
    // recovers a session to delete with.
    if (typeof jwt !== "string" && accountCreated) {
      try {
        const res = await convex.action("auth:signIn", {
          provider: "password",
          params: { email, password: currentPassword, flow: "signIn" },
        });
        jwt = res?.tokens?.token ?? null;
      } catch {
        jwt = null;
      }
    }
    if (typeof jwt === "string") {
      try {
        convex.setAuth(jwt);
        await convex.mutation(api.account.deleteAccount);
        erased = true;
      } catch {
        erased = false;
      } finally {
        convex.clearAuth();
      }
    } else if (accountCreated) {
      console.log(
        "    ⚠ the account exists but no usable session could be recovered.",
      );
      console.log(
        `      Manual removal may be needed for ${username} <${email}>.`,
      );
    }
    await browser.close();
  }
  check("throwaway account erased", !accountCreated || erased);

  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nFull auth-loop E2E crashed:", e);
  process.exit(1);
});
