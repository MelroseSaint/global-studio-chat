#!/usr/bin/env node
/**
 * Shared Playwright helpers for the PureWire production browser QAs.
 *
 * The responsive QA and the pages-inflation QA both sign in through the
 * real Auth form (Turnstile gate included), measure horizontal overflow
 * and viewport leaks, and simulate Amazon Silk's font inflation. Keeping
 * those helpers here means one source of truth — a fix to the sign-in
 * flow or the leak detector lands in every browser QA at once.
 */
import { chromium } from "playwright";

/** Fresh pass/fail reporter. Usage: const r = createReporter(); r.check(...); */
export function createReporter() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  return {
    check(name, ok, detail = "") {
      if (ok) {
        passed++;
        console.log(`  ✅ ${name}`);
      } else {
        failed++;
        failures.push(name);
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
      }
    },
    get passed() {
      return passed;
    },
    get failed() {
      return failed;
    },
    get failures() {
      return failures;
    },
    summary() {
      console.log(`\n${passed} passed, ${failed} failed`);
      if (failed > 0) {
        console.log("Failed checks:");
        for (const f of failures) console.log(`  - ${f}`);
      }
    },
  };
}

/**
 * Detect the Turnstile gate state. "inactive" when the widget isn't
 * rendered (no site key), "passed" when a token was produced, "blocked"
 * when the widget rendered but no token arrived — headless automation can
 * be challenged, and a human or a test-mode site key would be needed.
 */
export async function detectTurnstile(page, { iframeTimeoutMs = 15000, tokenTimeoutMs = 20000 } = {}) {
  const widget = page.locator(".cf-turnstile");
  if ((await widget.count()) === 0) return "inactive";
  try {
    await page.waitForSelector(".cf-turnstile iframe", { timeout: iframeTimeoutMs });
  } catch {
    return "blocked";
  }
  try {
    await page.waitForFunction(
      () => {
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        return input !== null && input.value.length > 0;
      },
      { timeout: tokenTimeoutMs },
    );
    return "passed";
  } catch {
    return "blocked";
  }
}

/**
 * Sign in through the real Auth form and land on the post-auth home page.
 * Throws (never silently fails) when the gate blocks or the form errors.
 */
export async function signIn(
  page,
  {
    siteUrl,
    email,
    password,
    timeoutMs = 30000,
    navTimeoutMs = 45000,
  },
) {
  await page.goto(`${siteUrl}/auth`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#email", { timeout: timeoutMs });
  const gate = await detectTurnstile(page);
  if (gate === "blocked") {
    throw new Error(
      "Turnstile challenge didn't auto-pass under automation — run with HEADED=1 and complete it by hand, or use a test-mode site key.",
    );
  }
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.locator('form button[type="submit"]').click();
  const outcome = await Promise.race([
    page.waitForURL("**/home", { timeout: navTimeoutMs }).then(() => "home"),
    page
      .waitForSelector('p[class*="text-destructive"]', { timeout: navTimeoutMs })
      .then(() => "error"),
  ]);
  if (outcome !== "home") {
    const url = page.url();
    const err = await page
      .locator('p[class*="text-destructive"]')
      .first()
      .textContent()
      .catch(() => "");
    throw new Error(`sign-in did not land on /home (${url}${err ? ` — ${err}` : ""})`);
  }
}

/**
 * Measure the current page: page-level horizontal overflow plus any
 * non-fixed element whose right edge passes the viewport without a
 * clipping ancestor (overflow hidden/auto/scroll). Swipeable strips whose
 * cards intentionally extend past the fold inside their own scroll
 * container are told apart from a real leak by the clipping-ancestor
 * check. Reports two checks through the reporter.
 */
export async function measurePage(page, label, check) {
  const vp = await page.evaluate(() => ({
    innerW: window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
  }));
  check(
    `${label}: no horizontal overflow`,
    vp.scrollW <= vp.innerW,
    `scrollW=${vp.scrollW} innerW=${vp.innerW}`,
  );
  const leaks = await page.evaluate(() => {
    const vw = window.innerWidth;
    const out = [];
    const clippedByAncestor = (el) => {
      let n = el.parentElement;
      while (n) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll|hidden)/.test(cs.overflowX)) return true;
        n = n.parentElement;
      }
      return false;
    };
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 2 && r.width > 0 && !clippedByAncestor(el)) {
        if (getComputedStyle(el).position === "fixed") return;
        out.push(
          `<${el.tagName}> r=${Math.round(r.right)} class="${(el.getAttribute("class") || "").slice(0, 60)}"`,
        );
      }
    });
    return out.slice(0, 6);
  });
  check(
    `${label}: no elements leak past the viewport`,
    leaks.length === 0,
    leaks.join(" | "),
  );
}

/**
 * Simulate Amazon Silk's font inflation (the classic Fire-tablet clutter
 * cause): Silk font-boosts text on wide layouts, scaling every rem unit.
 * Headless Chrome doesn't reproduce that on its own, so the QA bumps the
 * root font-size and proves the grids survive the larger rem sizes.
 * 21px ≈ 1.3x over the default 16px root.
 */
export async function simulateSilkInflation(page, rootFontPx = 21) {
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootFontPx);
}

/**
 * Launch the QA browser. headless unless HEADED=1.
 */
export async function launchBrowser({ headed = false } = {}) {
  return chromium.launch({ headless: !headed });
}
