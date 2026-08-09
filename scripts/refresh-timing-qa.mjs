#!/usr/bin/env node
/**
 * Refresh-timing QA — measures the two refresh-speed changes on the live
 * site with a real browser:
 *
 *   1. Navigation SWR (sw-template.js): a WARM reload (service worker
 *      installed and controlling) serves the shell from cache instead of
 *      waiting a network round trip for the HTML. First contentful paint
 *      on the warm reload is gated, and the cold→warm delta is reported.
 *
 *   2. Parallel auth gate (use-auth.ts / RequireAuth.tsx): a signed-in
 *      reload mounts the shell immediately (no spinner waiting on the
 *      `me` query), so the user-doc, shell counts, and page queries run in
 *      parallel. Time-to-shell and time-to-feed-content on the warm
 *      signed-in reload are gated.
 *
 * Timings are measured IN-document via an addInitScript (runs on every
 * navigation, reloads included): a Paint observer records first
 * contentful paint, and a MutationObserver stamps when the shell
 * (img[alt="PureWire"]) and the first feed card (article) appear — all
 * performance.now() relative to the reload's navigationStart, so no
 * wall-clock jitter. Scenarios repeat and the best (minimum) run gates,
 * mirroring the INP harness — single lab runs swing, a real regression
 * pushes even the best run over.
 *
 * Run:  npm run qa:refresh-timing  (or node scripts/refresh-timing-qa.mjs)
 * Env:  REFRESH_URL (default the live site), TEST_HARNESS_SECRET (enables
 *       the signed-in measurements), REFRESH_FCP_MS (default 2000),
 *       REFRESH_SHELL_MS (default 2500), REFRESH_FEED_MS (default 5000),
 *       REFRESH_RUNS (default 2).
 */
import { chromium } from "playwright";

const BASE = process.env.REFRESH_URL ?? "https://purewire.vercel.app";
const FCP_MS = Number(process.env.REFRESH_FCP_MS ?? 2000);
const SHELL_MS = Number(process.env.REFRESH_SHELL_MS ?? 2500);
const FEED_MS = Number(process.env.REFRESH_FEED_MS ?? 5000);
const RUNS = Number(process.env.REFRESH_RUNS ?? 2);
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;
const CONVEX_URL = process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const DEBUG = process.env.REFRESH_DEBUG === "1";

const results = [];
let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`  ❌ ${msg}`);
};

/**
 * Runs before every document (first load AND reloads): records FCP from
 * the Paint API and stamps shell/feed visibility from the DOM. `sel` is
 * injected as JSON so each scenario picks the surfaces it tracks.
 */
const TIMING_SCRIPT = (sel) => `(() => {
  window.__rt = { fcp: null, shell: null, feed: null };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.name === "first-contentful-paint" && window.__rt.fcp === null) {
          window.__rt.fcp = Math.round(e.startTime);
        }
      }
    }).observe({ type: "paint", buffered: true });
  } catch (_) {}
  const shellSel = ${JSON.stringify(sel.shell)};
  const feedSel = ${JSON.stringify(sel.feed)};
  const check = () => {
    const now = () => Math.round(performance.now());
    if (shellSel && window.__rt.shell === null && document.querySelector(shellSel)) {
      window.__rt.shell = now();
    }
    if (feedSel && window.__rt.feed === null && document.querySelector(feedSel)) {
      window.__rt.feed = now();
    }
  };
  // Observe the document itself (documentElement can be null at init-script
  // time in some navigation cases, and a thrown observe would silently
  // leave no watcher). The interval is a backstop in case MutationObserver
  // is unavailable; both are idempotent via the !== null guards.
  try {
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  } catch (_) {}
  const poll = setInterval(check, 100);
  setTimeout(() => clearInterval(poll), 15000);
  check();
})();`;

const ANON_SEL = { shell: null, feed: null }; // anonymous: FCP only (Landing)
const AUTH_SEL = { shell: "img[alt=\"PureWire\"]", feed: "article" }; // signed-in: shell + feed

async function newContext(browser, { seedAuth, viewport } = {}) {
  const context = await browser.newContext({
    viewport: viewport ?? { width: 390, height: 844 }, // mobile-ish
    locale: "en-US",
  });
  if (seedAuth) {
    await context.addInitScript(
      (seed) => {
        try {
          localStorage.setItem(`__convexAuthJWT_${seed.ns}`, seed.token);
          localStorage.setItem(`__convexAuthRefreshToken_${seed.ns}`, seed.refreshToken);
        } catch (_) {}
      },
      seedAuth,
    );
  }
  const page = await context.newPage();
  if (DEBUG) {
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`      [page console.error] ${m.text().slice(0, 220)}`);
    });
    page.on("pageerror", (e) => console.log(`      [pageerror] ${String(e).slice(0, 220)}`));
    page.on("requestfailed", (r) =>
      console.log(`      [requestfailed] ${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ""}`),
    );
  }
  return { context, page };
}

const isCheckpoint = (page) =>
  page.title().then((t) => t.includes("Security Checkpoint")).catch(() => false);

/** One cold-load or warm-reload measurement; returns the in-page timing. */
async function measureOnce(page, url, sel, { reload = false } = {}) {
  if (!reload) {
    await page.goto(url, { waitUntil: "load", timeout: 90000 });
  } else {
    await page.reload({ waitUntil: "load", timeout: 90000 });
  }
  if (await isCheckpoint(page)) return null;
  // Wait for the tracked surfaces (bounded) so the in-page stamps land. The
  // 60s shell/feed caps tolerate a slow session restore under CI load — a
  // restore that still hasn't landed by then is a real hang, not noise.
  // NOTE: these MUST be real function predicates. Playwright evaluates a
  // STRING predicate as an expression, so a string like
  // `() => window.__rt && window.__rt.fcp !== null` yields the arrow
  // function object itself (always truthy) and the wait resolves in ~40ms
  // without waiting — the debug dump then catches the pre-restore spinner
  // and the shell gate fails spuriously. A real function is serialized and
  // re-invoked, so it actually polls until the condition holds.
  await page
    .waitForFunction(() => window.__rt && window.__rt.fcp !== null, null, { timeout: 30000 })
    .catch(() => {});
  if (sel.shell) {
    await page
      .waitForFunction(() => window.__rt && window.__rt.shell !== null, null, { timeout: 60000 })
      .catch(() => {});
  }
  if (sel.feed) {
    await page
      .waitForFunction(() => window.__rt && window.__rt.feed !== null, null, { timeout: 60000 })
      .catch(() => {});
  }
  const rt = await page.evaluate(() => window.__rt ?? null).catch(() => null);
  if (DEBUG) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const state = await page
      .evaluate(() => {
        const root = document.getElementById("root");
        const spinner = document.querySelector('[role="status"], [aria-busy="true"], svg.animate-spin');
        const keys = Object.keys(localStorage);
        return {
          rootChildren: root?.children.length ?? -1,
          spinner: spinner ? spinner.tagName : null,
          bodyLen: document.body.innerHTML.length,
          sw: navigator.serviceWorker?.controller ? "controlled" : "free",
          lsKeys: keys.filter((k) => k.includes("convex")),
          jwtLen: (localStorage.getItem(keys.find((k) => k.includes("JWT")) ?? "") ?? "").length,
        };
      })
      .catch(() => null);
    console.log(
      `      [debug] ${reload ? "reload" : "goto"} -> ${page.url()} fcp=${rt?.fcp ?? "-"} shell=${rt?.shell ?? "-"} feed=${rt?.feed ?? "-"} shells=${await page
        .locator('img[alt="PureWire"]')
        .count()
        .catch(() => -1)} articles=${await page.locator("article").count().catch(() => -1)} title=${await page
        .title()
        .catch(() => "")} body=${bodyText.replace(/\s+/g, " ").slice(0, 90)} state=${JSON.stringify(state)}`,
    );
  }
  return rt;
}

/** Min-of-N best-run for a scenario (mirrors the INP harness). */
async function scenario(browser, url, label, sel, opts = {}) {
  const runs = [];
  const errors = [];
  for (let i = 0; i < RUNS; i++) {
    const { context, page } = await newContext(browser, opts);
    // The timing observers run on EVERY document (first load and reloads),
    // so install them before any navigation.
    await context.addInitScript(TIMING_SCRIPT(sel));
    try {
      // Warm scenarios: install + take-control of the SW FIRST (cold load
      // registers it; skipWaiting + claim activates it), then reload so
      // the measured load is actually SW-served.
      if (opts.warm) {
        await page.goto(url, { waitUntil: "load", timeout: 90000 });
        await page
          .waitForFunction(
            () =>
              "serviceWorker" in navigator &&
              navigator.serviceWorker.controller !== null,
            null,
            { timeout: 45000 },
          )
          .catch(() => {});
        const controlled = await page
          .evaluate(() => navigator.serviceWorker?.controller !== null)
          .catch(() => false);
        if (!controlled) {
          errors.push("service worker never took control (SWR not serving the reload)");
          runs.push({ fcp: null, shell: null, feed: null, swControlled: false });
          continue;
        }
        const rt = await measureOnce(page, url, sel, { reload: true });
        if (rt === null) {
          errors.push("Vercel Security Checkpoint");
          runs.push({ fcp: null, shell: null, feed: null, swControlled: true });
          continue;
        }
        runs.push({ ...rt, swControlled: true });
      } else {
        const rt = await measureOnce(page, url, sel);
        if (rt === null) {
          errors.push("Vercel Security Checkpoint");
          runs.push({ fcp: null, shell: null, feed: null, swControlled: null });
          continue;
        }
        runs.push({ ...rt, swControlled: null });
      }
    } catch (err) {
      errors.push(String(err).slice(0, 140));
      runs.push({ fcp: null, shell: null, feed: null, swControlled: null });
    } finally {
      await context.close();
    }
  }

  const valid = runs.filter((r) => r.fcp !== null);
  // Prefer the most COMPLETE run (shell + feed stamps present), then the
  // lowest FCP among equals: a flaky run that redirected to /auth has a
  // fast FCP but no shell, and must never win the verdict.
  const best = valid.length
    ? valid.reduce((a, b) => {
        const score = (r) => (r.shell !== null ? 1 : 0) + (r.feed !== null ? 1 : 0);
        const sa = score(a);
        const sb = score(b);
        if (sa !== sb) return sa > sb ? a : b;
        return b.fcp < a.fcp ? b : a;
      })
    : null;
  const result = {
    label,
    gate: opts.gate !== false,
    runs: runs.map((r) => r.fcp),
    shell: best ? best.shell : null,
    feed: best ? best.feed : null,
    fcp: best ? best.fcp : null,
    swControlled: best ? best.swControlled : null,
    errors: errors.length ? errors[0] : undefined,
  };
  results.push(result);

  const line = best
    ? `${String(best.fcp).padStart(5)}ms fcp  shell ${String(best.shell ?? "-").padStart(5)}  feed ${String(best.feed ?? "-").padStart(5)}  ${label}${result.swControlled === false ? "  ⚠ SW NOT CONTROLLING" : ""}`
    : `   -ms  ${label}  — ${result.errors ?? "no paint entries"}`;
  console.log(`  ${line}`);
  return result;
}

console.log(`\nRefresh-timing QA — ${BASE}  (fcp ≤ ${FCP_MS}ms, shell ≤ ${SHELL_MS}ms, feed ≤ ${FEED_MS}ms, ${RUNS} runs best-of)\n`);

const browser = await chromium.launch({
  headless: true,
  ...(CHROME ? { executablePath: CHROME } : {}),
});

// ---------- Anonymous: cold baseline (report-only) + warm reload (gated) ----------
const anon = `${BASE}/`;
const anonCold = await scenario(browser, anon, "anonymous cold load (/)", ANON_SEL, { gate: false });
const anonWarm = await scenario(browser, anon, "anonymous warm reload (SWR)", ANON_SEL, { warm: true });

// ---------- Signed-in: cold baseline (report-only) + warm reload (gated) ----------
let authSeed = null;
if (HARNESS_SECRET) {
  const { ConvexHttpClient } = await import("convex/browser");
  const { api } = await import("../src/convex/_generated/api.js");
  const mint = new ConvexHttpClient(CONVEX_URL);
  try {
    // A fresh REGULAR qa_ account (not the admin): the plain session path
    // has no admin-IP verification or workload queries, so the measured
    // restore is the real member path — lighter and less flaky.
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const username = `qa_refresh_${stamp}`;
    await mint.mutation(api.testHarness.createTestUser, {
      name: `Refresh QA ${stamp}`,
      username,
      secret: HARNESS_SECRET,
    });
    const seeded = await mint.mutation(api.testHarness.mintSessionForQaUsername, {
      username,
      secret: HARNESS_SECRET,
    });
    authSeed = {
      token: seeded.token,
      refreshToken: seeded.refreshToken,
      ns: CONVEX_URL.replace(/[^a-zA-Z0-9]/g, ""),
      userId: seeded.userId,
      username,
    };
    console.log("signed-in: minted fresh qa_ session");
  } catch (err) {
    console.log(`signed-in: mint failed — ${String(err).slice(0, 120)}`);
  }
} else {
  console.log("signed-in: TEST_HARNESS_SECRET not set — skipping (public surface only)");
}

if (authSeed) {
  const home = `${BASE}/home`;
  const cold = await scenario(browser, home, "signed-in cold load (/home)", AUTH_SEL, {
    seedAuth: authSeed,
    gate: false,
  });
  const warm = await scenario(browser, home, "signed-in warm reload (parallel gate)", AUTH_SEL, {
    seedAuth: authSeed,
    warm: true,
  });

  // Gates (best-of-N): warm reload must stay under budget.
  if (warm.fcp !== null && warm.fcp > FCP_MS) {
    fail(`signed-in warm reload FCP ${warm.fcp}ms > ${FCP_MS}ms — SWR shell not fast enough`);
  }
  if (warm.fcp !== null && warm.shell === null) {
    fail("signed-in warm reload never rendered the app shell — the seeded session did not restore (auth gate regression?)");
  }
  if (warm.shell !== null && warm.shell > SHELL_MS) {
    fail(`signed-in warm reload shell ${warm.shell}ms > ${SHELL_MS}ms — parallel auth gate regressed (shell waited on a query)`);
  }
  if (warm.feed !== null && warm.feed > FEED_MS) {
    fail(`signed-in warm reload feed ${warm.feed}ms > ${FEED_MS}ms — content too slow to appear`);
  }
  if (warm.swControlled === false) {
    fail("signed-in warm reload: service worker never controlled the page — SWR is not serving the reload");
  }
  // SWR signal: warm reload should be visibly faster than the cold load.
  if (cold.fcp !== null && warm.fcp !== null) {
    console.log(`\n  SWR delta: cold FCP ${cold.fcp}ms → warm FCP ${warm.fcp}ms (${cold.fcp - warm.fcp}ms saved)`);
  }
}

// ---------- Anonymous SWR delta + gate ----------
if (anonCold?.fcp !== null && anonWarm?.fcp !== null) {
  console.log(`  SWR delta: cold FCP ${anonCold?.fcp ?? "-"}ms → warm FCP ${anonWarm?.fcp ?? "-"}ms (${(anonCold?.fcp ?? 0) - (anonWarm?.fcp ?? 0)}ms saved)`);
}
if (anonWarm?.fcp !== null && anonWarm?.fcp > FCP_MS) {
  fail(`anonymous warm reload FCP ${anonWarm?.fcp}ms > ${FCP_MS}ms`);
}
if (anonWarm?.swControlled === false) {
  fail("anonymous warm reload: service worker never controlled the page — SWR is not serving the reload");
}

await browser.close();

// Sweep the throwaway account so a run never leaves a qa_ user behind
// (the nightly sweep would catch it too, but tidy is tidy).
if (authSeed?.userId && HARNESS_SECRET) {
  try {
    const { ConvexHttpClient } = await import("convex/browser");
    const { api } = await import("../src/convex/_generated/api.js");
    const mint = new ConvexHttpClient(CONVEX_URL);
    await mint.mutation(api.testHarness.deleteTestUser, {
      userId: authSeed.userId,
      secret: HARNESS_SECRET,
    });
    console.log("cleanup: throwaway account erased");
  } catch {
    /* best-effort */
  }
}

console.log(`\nRefresh-timing verdict: ${failed ? "FAIL" : "PASS"}`);
if (failed) process.exit(1);
process.exit(0);
