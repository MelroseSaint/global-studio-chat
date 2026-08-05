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
 *   - Partial profiles: a single weak signal (e.g. only a bare UA) must
 *     NOT trip the ≥70 + 2-signal escalation bar alone.
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
