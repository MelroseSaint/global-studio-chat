#!/usr/bin/env node
/**
 * PureWire browser-automation detector QA.
 *
 * Asserts the scoring engine in src/lib/automation-signal.ts on synthetic
 * browser environments — the exact same code path a real browser runs:
 *
 *   - A clean headless-browser profile (the CI browser itself): no
 *     webdriver flag, no CDP/Playwright globals, a normal UA, plugins and
 *     permissions present, a real chrome frame — must score 0 with zero
 *     signals, so a legit headless CI runner is never flagged.
 *   - A simulated Playwright-driven profile: webdriver=true, cdc_-prefixed
 *     globals, __playwright present, HeadlessChrome UA, empty plugin
 *     inventory, stripped Chrome APIs, no permissions, outer===inner
 *     viewport — must score high with the right signals, so a driven
 *     browser is caught before its account ever reaches real users.
 *   - A headed Selenium profile: webdriver=true with chrome/plugins intact
 *     — caught by webdriver + the runtime-hint signal compounding, yet
 *     below the auto bar.
 *   - An anti-detection stealth profile: webdriver patched false, UA,
 *     plugins, and chrome API all restored — still caught by the residual
 *     CDP-injected cdc_ global and the headless outer===inner viewport,
 *     both compounding and below the auto bar.
 *   - A fully hardened bot: Playwright-with-stealth that also patches the
 *     viewport and removes the cdc_ globals — every easy AND hard tell
 *     scrubbed except touch-consistency. The zero-touch-on-a-mobile-UA
 *     tell still trips, proving a residual signal survives even the best
 *     client-side patching.
 *   - Partial profiles: a single weak signal (e.g. only a bare UA) must
 *     NOT trip the ≥70 + 2-signal escalation bar alone.
 *
 * Honest gap, documented on purpose: the hardened profile marks the upper
 * bound of what client-side detection alone can promise. One weak
 * residual signal (score 15) can never reach the ≥70 + 2-signal
 * escalation bar by itself — that bar exists so no single signal can
 * convict anyone. A fully-stealthed bot is therefore caught client-side
 * only as a weak hint; the real backstops are the server-side layers
 * this module feeds (proof-of-work, rate limits, behavioral/farm
 * scoring, and member reports). The test asserts the gap is real rather
 * than pretending detection is total.
 *
 * Pure offline unit test: imports detectAutomation directly (Node 22+
 * type stripping + the same resolve hook the other QA scripts use). No
 * harness, no network.
 *
 *   node scripts/automation-qa.mjs
 *
 * Exit codes: 0 all checks passed, 1 a check failed.
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const baseUrl = new URL(context.parentURL ?? import.meta.url);
    let target;
    if (specifier.startsWith("@/")) {
      target = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
    } else if (specifier.startsWith("./")) {
      target = new URL(specifier, baseUrl);
    } else {
      return nextResolve(specifier, context);
    }
    try {
      return nextResolve(target.href, context);
    } catch (err) {
      for (const ext of [".ts", ".js"]) {
        try {
          const candidate = new URL(`${target.href}${ext}`);
          if (existsSync(candidate)) return nextResolve(candidate.href, context);
        } catch {
          // fall through
        }
      }
      throw err;
    }
  },
});

const { detectAutomation } = await import("../src/lib/automation-signal.ts");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ────────────────────────────────────────────────────────────
//  Synthetic browser profiles
// ────────────────────────────────────────────────────────────

/** A normal desktop Chrome: everything real browsers report. */
const cleanChrome = () => ({
  navigator: {
    webdriver: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    plugins: { length: 5 },
    mimeTypes: { length: 10 },
    permissions: {},
    maxTouchPoints: 0,
  },
  window: {
    getOwnPropertyNames: () => [
      "window",
      "document",
      "location",
      "chrome",
      "onload",
    ],
    chrome: { csi: () => {}, loadTimes: () => {} },
    outerWidth: 1920,
    outerHeight: 1040,
    innerWidth: 1920,
    innerHeight: 960,
  },
});

/** A Playwright-driven headless Chrome, the way bot operators ship it. */
const playwrightProfile = () => ({
  navigator: {
    webdriver: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
    plugins: { length: 0 },
    mimeTypes: { length: 0 },
    permissions: undefined,
    maxTouchPoints: 0,
  },
  window: {
    getOwnPropertyNames: () => [
      "window",
      "document",
      "cdc_adoQpoasnfa76pfcZLmcfl_Page",
      "__playwright",
      "location",
      "chrome",
    ],
    // Real Playwright drivers set window.__playwright via an init script
    // (and expose cdc_-prefixed objects) — mirror that so the detector's
    // global-name check actually fires, not just the key listing.
    __playwright: { mode: "run" },
    chrome: {}, // headless Chrome: present but stripped of csi/loadTimes
    outerWidth: 1280,
    outerHeight: 720,
    innerWidth: 1280,
    innerHeight: 720,
  },
});

/**
 * Headed Selenium (chromedriver): navigator.webdriver is true — the single
 * most reliable automation flag — but chrome.csi/loadTimes are intact and
 * plugins/permissions exist, because chromedriver doesn't strip the
 * browser like a CDP-injected run does. Webdriver always pairs with the
 * runtime-hint signal, so this is two compounding signals even though the
 * score stays below the automatic shadowban bar (proportional, never
 * auto-conviction from one marker family).
 */
const seleniumProfile = () => ({
  navigator: {
    webdriver: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    plugins: { length: 5 },
    mimeTypes: { length: 10 },
    permissions: {},
    maxTouchPoints: 0,
  },
  window: {
    getOwnPropertyNames: () => ["window", "document", "location", "chrome", "onload"],
    chrome: { csi: () => {}, loadTimes: () => {} },
    outerWidth: 1920,
    outerHeight: 1040,
    innerWidth: 1920,
    innerHeight: 960,
  },
});

/**
 * Anti-detection stealth (e.g. puppeteer-extra-plugin-stealth): the easy
 * tells are patched — webdriver forced false, a normal Chrome UA, plugins
 * and chrome.csi/loadTimes restored, permissions present. But the hard
 * tells remain: the CDP-injected cdc_-prefixed global that stealth cannot
 * scrub (it doesn't know about it), and the outer===inner viewport of a
 * headless run (no chrome frame). So a patched bot is still detected by
 * compounding residual signals, and still stays below the auto-escalation
 * bar — exactly the proportional philosophy.
 */
const stealthProfile = () => ({
  navigator: {
    webdriver: false, // patched
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", // patched
    plugins: { length: 5 }, // patched present
    mimeTypes: { length: 10 },
    permissions: {}, // patched present
    maxTouchPoints: 0,
  },
  window: {
    getOwnPropertyNames: () => [
      "window",
      "document",
      "cdc_adoQpoasnfa76pfcZLmcfl_Page", // CDP remnant — not scrubbed
      "location",
      "chrome",
    ],
    chrome: { csi: () => {}, loadTimes: () => {} }, // patched present
    outerWidth: 1280,
    outerHeight: 720,
    innerWidth: 1280,
    innerHeight: 720, // headless: no chrome frame
  },
});

/**
 * Fully hardened bot: Playwright-with-stealth taken all the way — the
 * viewport is patched to a real phone frame (outer ≠ inner), the
 * cdc_-prefixed globals are scrubbed, __playwright is gone, and every
 * surface this detector reads looks real: webdriver false, a normal
 * Android Chrome Mobile UA, plugins and chrome.csi/loadTimes restored,
 * permissions present. The ONE thing the patching misses is
 * touch-consistency: the UA claims a touch-capable Android phone but
 * maxTouchPoints is 0 — a real Android device always reports touch
 * points, and no stealth plugin patches navigator.maxTouchPoints to lie
 * the other way. That residual tell is exactly the weak signal this test
 * asserts survives, and its single-signal score is the honest gap the
 * header documents.
 */
const hardenedProfile = () => ({
  navigator: {
    webdriver: false, // patched
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    plugins: { length: 5 }, // patched present
    mimeTypes: { length: 10 },
    permissions: {}, // patched present
    maxTouchPoints: 0, // ← the residual tell: a real Android phone reports > 0
  },
  window: {
    getOwnPropertyNames: () => [
      // cdc_ globals scrubbed; __playwright gone — nothing left here
      "window",
      "document",
      "location",
      "chrome",
      "onload",
    ],
    chrome: { csi: () => {}, loadTimes: () => {} }, // patched present
    outerWidth: 412, // real phone frame: outer ≠ inner, no dimensionClue
    outerHeight: 915,
    innerWidth: 412,
    innerHeight: 824,
  },
});

/** Only a bare headless UA — one weak signal, no other markers. */
const bareUaProfile = () => ({
  navigator: {
    webdriver: false,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
    plugins: { length: 5 },
    mimeTypes: { length: 10 },
    permissions: {},
    maxTouchPoints: 0,
  },
  window: {
    getOwnPropertyNames: () => ["window", "document", "location", "chrome"],
    chrome: { csi: () => {}, loadTimes: () => {} },
    outerWidth: 1920,
    outerHeight: 1040,
    innerWidth: 1920,
    innerHeight: 960,
  },
});

// ────────────────────────────────────────────────────────────
//  Assertions
// ────────────────────────────────────────────────────────────

// 1. Clean profile — the CI runner itself must pass clean.
const clean = detectAutomation(cleanChrome());
check("clean profile scores 0", clean.score === 0, JSON.stringify(clean));
check(
  "clean profile has zero signals",
  clean.signals.length === 0,
  JSON.stringify(clean.signals),
);

// 2. Playwright profile — must be caught hard.
const driven = detectAutomation(playwrightProfile());
check(
  "Playwright profile is detected",
  driven.signals.length > 0,
  JSON.stringify(driven.signals),
);
check(
  "Playwright profile scores >= 70",
  driven.score >= 70,
  `score ${driven.score}`,
);
for (const expected of [
  "webdriver",
  "cdpInjected",
  "playwright",
  "headlessChrome",
  "noPlugins",
  "noChromeApi",
  "missingPermissions",
  "dimensionClue",
]) {
  check(
    `Playwright profile signals '${expected}'`,
    driven.signals.includes(expected),
    `signals: ${driven.signals.join(", ")}`,
  );
}

// 3. Escalation shape: ≥70 AND ≥2 independent signals is the server's
//    silent-flag bar. The driven profile must cross it; a clean one must not.
check(
  "driven profile crosses escalation bar",
  driven.score >= 70 && driven.signals.length >= 2,
  `score ${driven.score}, signals ${driven.signals.length}`,
);
check(
  "clean profile does not cross escalation bar",
  !(clean.score >= 70 && clean.signals.length >= 2),
);

// 4. A single weak signal (bare headless UA, everything else normal) must
//    NOT cross the bar alone — no innocent mis-config gets flagged.
const bare = detectAutomation(bareUaProfile());
check(
  "bare-UA profile has exactly one signal",
  bare.signals.length === 1 && bare.signals[0] === "headlessChrome",
  JSON.stringify(bare.signals),
);
check(
  "bare-UA profile stays below escalation bar",
  bare.score < 70 || bare.signals.length < 2,
  `score ${bare.score}, signals ${bare.signals.length}`,
);

// 5. Edge: a browser with webdriver=true alone is still caught (the one
//    strongest single marker) but shouldn't hit 100 (needs compounding).
const webdriverOnly = detectAutomation({
  navigator: {
    webdriver: true,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    plugins: { length: 5 },
    mimeTypes: { length: 10 },
    permissions: {},
    maxTouchPoints: 0,
  },
  window: {
    getOwnPropertyNames: () => ["window", "document", "location", "chrome"],
    chrome: { csi: () => {}, loadTimes: () => {} },
    outerWidth: 1440,
    outerHeight: 900,
    innerWidth: 1440,
    innerHeight: 830,
  },
});
check(
  "webdriver=true alone is flagged",
  webdriverOnly.signals.includes("webdriver"),
  JSON.stringify(webdriverOnly.signals),
);
check(
  "webdriver=true alone is not maxed (no compound)",
  webdriverOnly.score < 100,
  `score ${webdriverOnly.score}`,
);

// 6. Headed Selenium: webdriver=true with everything else intact. Must be
//    flagged, and must compound (webdriver + the runtime hint) without
//    blowing past the proportional bar — chromedriver is the classic
//    automated setup, but it's not the compounding marker storm of a
//    full CDP-injected run.
const selenium = detectAutomation(seleniumProfile());
check(
  "Selenium profile is flagged (webdriver)",
  selenium.signals.includes("webdriver"),
  JSON.stringify(selenium.signals),
);
check(
  "Selenium profile compounds to 2+ signals",
  selenium.signals.length >= 2,
  `signals: ${selenium.signals.join(", ")}`,
);
check(
  "Selenium profile compounds webdriver + controlledByRuntime",
  selenium.signals.includes("controlledByRuntime"),
  JSON.stringify(selenium.signals),
);
check(
  "Selenium profile scores 50-69 (below auto bar)",
  selenium.score >= 50 && selenium.score < 70,
  `score ${selenium.score}`,
);
check(
  "Selenium profile keeps chrome API intact (no noChromeApi false positive)",
  !selenium.signals.includes("noChromeApi"),
  JSON.stringify(selenium.signals),
);

// 7. Anti-detection stealth: webdriver patched false, UA/plugins/chrome
//    all restored. The residual tells (CDP-injected cdc_ global, headless
//    outer===inner viewport) must still catch it — compounding, but below
//    the automatic shadowban bar so a patched-but-real-looking setup gets
//    proportional treatment, not instant conviction.
const stealth = detectAutomation(stealthProfile());
check(
  "stealth profile is still caught (cdpInjected)",
  stealth.signals.includes("cdpInjected"),
  JSON.stringify(stealth.signals),
);
check(
  "stealth profile compounds to 2+ signals",
  stealth.signals.length >= 2,
  `signals: ${stealth.signals.join(", ")}`,
);
check(
  "stealth profile keeps dimension clue (headless frame)",
  stealth.signals.includes("dimensionClue"),
  JSON.stringify(stealth.signals),
);
check(
  "stealth profile scores 20-69 (below auto bar)",
  stealth.score >= 20 && stealth.score < 70,
  `score ${stealth.score}`,
);
check(
  "stealth profile's patched surfaces do not false-positive",
  !stealth.signals.includes("webdriver") &&
    !stealth.signals.includes("noPlugins") &&
    !stealth.signals.includes("headlessChrome") &&
    !stealth.signals.includes("noChromeApi"),
  JSON.stringify(stealth.signals),
);

// 8. Fully hardened bot: viewport patched, cdc_ globals scrubbed — the
//    only remaining tell is touch-consistency (a touch-capable Android UA
//    reporting zero touch points, which no stealth plugin patches the
//    "real" way). It must still be caught by that residual signal, and the
//    test must assert honestly that a single weak signal cannot escalate
//    alone — that's the documented detection gap, and it's what the
//    server-side layers (POW, rate limits, farm scoring, reports) exist
//    to backstop.
const hardened = detectAutomation(hardenedProfile());
check(
  "hardened profile is still caught (zeroTouchOnTouchUa)",
  hardened.signals.includes("zeroTouchOnTouchUa"),
  JSON.stringify(hardened.signals),
);
check(
  "hardened profile trips exactly one residual signal",
  hardened.signals.length === 1,
  `signals: ${hardened.signals.join(", ")}`,
);
check(
  "hardened profile scores 15 (zero-touch only)",
  hardened.score === 15,
  `score ${hardened.score}`,
);
check(
  "hardened profile's scrubbed surfaces are clean",
  !hardened.signals.includes("webdriver") &&
    !hardened.signals.includes("cdpInjected") &&
    !hardened.signals.includes("playwright") &&
    !hardened.signals.includes("headlessChrome") &&
    !hardened.signals.includes("noPlugins") &&
    !hardened.signals.includes("noChromeApi") &&
    !hardened.signals.includes("missingPermissions") &&
    !hardened.signals.includes("dimensionClue"),
  JSON.stringify(hardened.signals),
);
check(
  "hardened profile stays below escalation bar (the honest gap)",
  hardened.score < 70 || hardened.signals.length < 2,
  `score ${hardened.score}, signals ${hardened.signals.length}`,
);

// ────────────────────────────────────────────────────────────
//  Report
// ────────────────────────────────────────────────────────────

console.log(`\nautomation-qa: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("All automation-detector checks passed.");
process.exit(0);
