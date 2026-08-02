#!/usr/bin/env node
/**
 * PureWire production browser-driven end-to-end auth check.
 *
 * Drives a real Chromium (Playwright) against the live site: loads the
 * Auth page, detects the Turnstile human-check gate (the widget only
 * renders when VITE_TURNSTILE_SITE_KEY is set — currently inactive on the
 * production bundle), signs in as the admin with a real password, confirms
 * the dashboard (/home) loads with the admin's nav, then signs out and
 * proves the session tokens are gone from localStorage.
 *
 * This complements scripts/admin-auth-qa.mjs: that one drives the auth API
 * directly with a fresh HTTP client, this one proves the real UI path —
 * form fill, Turnstile gate, redirect, dashboard render, sign-out — in a
 * genuine browser.
 *
 * Run (the password comes from the environment, never from this file):
 *
 *   ADMIN_PASSWORD=<admin password> npm run qa:admin-auth-browser
 *
 * Overrides: SITE_URL (default https://outgoing-seal-727.convex.site),
 * ADMIN_EMAIL (default monroedoses@gmail.com), HEADED=1 to watch the
 * browser on screen, BROWSER_TIMEOUT_MS (default 20000).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing password.
 */
import { chromium } from "playwright";

const SITE_URL = process.env.SITE_URL ?? "https://outgoing-seal-727.convex.site";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 20000);
const NAV_TIMEOUT = 45000;

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

/**
 * Detect the Turnstile gate state. Returns:
 *  - "inactive" when the widget isn't rendered (no VITE_TURNSTILE_SITE_KEY),
 *    in which case the server-side check reports the challenge disabled and
 *    the Auth page treats the gate as a no-op;
 *  - "passed" when the widget rendered and produced a token (managed mode
 *    auto-passes for legitimate traffic);
 *  - "blocked" when the widget rendered but no token arrived — headless
 *    automation can be challenged, and a human or a test-mode site key is
 *    needed.
 */
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

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log("ADMIN_PASSWORD is not set. Run with:");
    console.log("  ADMIN_PASSWORD=<admin password> npm run qa:admin-auth-browser");
    process.exit(2);
  }
  console.log(`\nPureWire production browser E2E auth QA (${SITE_URL})\n`);
  const browser = await chromium.launch({ headless: !HEADED });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(TIMEOUT);

    // 1. Load the Auth page and confirm the form rendered.
    await page.goto(`${SITE_URL}/auth`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#email", { timeout: TIMEOUT });
    check("auth page rendered (sign-in form visible)", true);

    // 2. Turnstile human-check gate.
    const gate = await detectTurnstile(page);
    if (gate === "inactive") {
      check(
        "Turnstile gate inactive on this deployment (no site key)",
        true,
      );
      console.log(
        "    (The widget only renders when VITE_TURNSTILE_SITE_KEY is set;",
      );
      console.log(
        "     with no key the gate is a no-op and sign-in proceeds directly.)",
      );
    } else {
      check("Turnstile gate widget present", true);
      check(
        "Turnstile gate passed (token produced)",
        gate === "passed",
        gate === "blocked"
          ? "the challenge didn't auto-pass under automation — run with HEADED=1 and complete it by hand, or use a test-mode site key"
          : "",
      );
      if (gate === "blocked") {
        // finish() exits the process (exit 1) for a failed check, which
        // skips the finally — close the browser here so it never leaks.
        await browser.close();
        return finish();
      }
    }

    // 3. Fill the real sign-in form and submit.
    await page.fill("#email", ADMIN_EMAIL);
    await page.fill("#password", ADMIN_PASSWORD);
    await page.locator('form button[type="submit"]').click();

    // 4. The Auth page redirects to /home once the session resolves, or
    //    shows an inline error (wrong password, outage, gate failure). Race
    //    the two so a failed sign-in resolves in seconds instead of burning
    //    the full navigation timeout. The error paragraph is matched by its
    //    text-destructive class — a more precise selector than the generic
    //    destructive-styled elements elsewhere on the page.
    // Both sides use NAV_TIMEOUT so the race can only reject in the genuine
    // neither-happened anomaly, never on a slow-but-legitimate rejection.
    const outcome = await Promise.race([
      page
        .waitForURL("**/home", { timeout: NAV_TIMEOUT })
        .then(() => "home"),
      page
        .waitForSelector('p[class*="text-destructive"]', {
          timeout: NAV_TIMEOUT,
        })
        .then(() => "error"),
    ]);
    if (outcome === "home") {
      check("redirected to /home after sign-in", true);
    } else {
      const url = page.url();
      const errorText = await page
        .locator('p[class*="text-destructive"]')
        .first()
        .textContent()
        .catch(() => "");
      check(
        "redirected to /home after sign-in",
        false,
        `${url}${errorText ? ` — page error: ${errorText.trim()}` : ""}`,
      );
      const verifyStep = await page.getByText("Verify your email").count();
      if (verifyStep > 0) {
        console.log(
          "    ⚠ Landed on the email-verify step — the admin account is",
        );
        console.log(
          "      expected to be already verified, so this shouldn't happen.",
        );
      }
      // Same leak guard: finish() exits the process for the failed check.
      await browser.close();
      return finish();
    }

    // 5. Dashboard content: feed tabs, composer, and the admin-only nav item
    //    (which proves the session actually resolved to the admin role).
    check(
      "dashboard feed rendered (Global tab)",
      (await page.getByRole("tab", { name: "Global" }).count()) > 0,
    );
    check(
      "composer present",
      (await page.getByPlaceholder("Say it anyway…").count()) > 0,
    );
    check(
      "admin nav item visible",
      (await page.getByRole("link", { name: "Admin" }).count()) > 0,
    );

    // 6. Sign out from the sidebar and confirm we land back on the landing
    //    page.
    await page.getByRole("button", { name: "Sign out" }).click();
    try {
      await page.waitForURL(`${SITE_URL}/`, { timeout: NAV_TIMEOUT });
      check("returned to landing after sign-out", true);
    } catch {
      check("returned to landing after sign-out", false, page.url());
    }

    // 7. The session tokens must be gone from storage.
    const jwt = await page.evaluate(() =>
      localStorage.getItem("__convexAuthJWT"),
    );
    const refresh = await page.evaluate(() =>
      localStorage.getItem("__convexAuthRefreshToken"),
    );
    check("JWT cleared from localStorage", jwt === null, String(jwt).slice(0, 24));
    check(
      "refresh token cleared from localStorage",
      refresh === null,
      String(refresh).slice(0, 24),
    );
  } finally {
    await browser.close();
  }

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
  console.error("\nBrowser E2E auth QA crashed:", e);
  process.exit(1);
});
