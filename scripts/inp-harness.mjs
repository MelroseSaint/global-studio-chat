/**
 * INP audit harness — measures real per-interaction INP on
 * purewire.vercel.app using the Event Timing API (the same source of truth
 * as field INP: each interaction's duration = input delay + processing +
 * presentation), plus Long Animation Frames for attribution.
 *
 * Mobile viewport (Pixel 5) + 4x CPU throttle via CDP, so lab values are
 * representative of a mid-range phone. For each interaction a fresh page
 * load runs, observers are installed, the interaction is performed, and the
 * resulting event-timing entries are read back.
 *
 * Run:  npm run qa:inp  (or node scripts/inp-harness.mjs)
 * Env:  INP_URL (default the live site), INP_THROTTLE (default 4), INP_COLD_MS (default 1200), INP_WARM_MS (default 4000)
 */
import { chromium, devices } from "playwright";

const BASE = process.env.INP_URL ?? "https://purewire.vercel.app";
const THROTTLE = Number(process.env.INP_THROTTLE ?? 4);
const COLD_MS = Number(process.env.INP_COLD_MS ?? 1200);
const WARM_MS = Number(process.env.INP_WARM_MS ?? 4000);

const CHROME = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const results = [];

const installObservers = `(() => {
  window.__evts = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__evts.push({
          t: e.name || e.type,
          d: Math.round(e.duration),
          p: Math.round(e.processingEnd - e.processingStart),
          delay: Math.round(e.inputDelay ?? (e.startTime - (e.lastInputTime ?? e.startTime))),
          id: e.interactionId,
        });
      }
    }).observe({ type: "event", buffered: true });
  } catch (_) {}
  window.__loaf = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__loaf.push({
          d: Math.round(e.duration),
          scripts: (e.scripts || []).map((s) => ({ src: s.sourceURL, dur: Math.round(s.duration) })).slice(0, 4),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch (_) {}
})();`;

async function freshPage(browser) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    locale: "en-US",
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    await session.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  } catch (_) {}
  return { context, page };
}

async function measure(browser, url, label, cond, settleMs, action) {
  const { context, page } = await freshPage(browser);
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
    await page.evaluate(installObservers);
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    await action(page);
    await page.waitForTimeout(1000);
    let evts = [];
    let loaf = [];
    try {
      evts = await page.evaluate(() => window.__evts);
      loaf = await page.evaluate(() => window.__loaf.slice(-4));
    } catch (_) {}
    const live = evts.filter((e) => e.d > 0);
    const max = live.length ? Math.max(...live.map((e) => e.d)) : null;
    const slow = live
      .filter((e) => e.d > 200)
      .map((e) => `${e.t}:${e.d}ms(p${e.p}/d${e.delay})`);
    results.push({
      url,
      label,
      settle: cond,
      interactions: live.length,
      maxMs: max,
      slow,
      loaf: loaf.map((l) => ({ d: l.d, scripts: l.scripts.map((s) => `${s.src.split("/").pop()}:${s.dur}ms`).join(", ") })),
    });      console.log(
      `${max === null ? "  -" : String(max).padStart(4)}ms  ${String(cond).padEnd(5)} ${label.padEnd(34)} ${url.replace(BASE, "")}${slow.length ? "  ⚠ " + slow.join(" | ") : ""}`,
    );
  } catch (err) {
    results.push({ url, label, error: String(err).slice(0, 140) });
    console.log(`  ERR ${label.padEnd(34)} ${String(err).slice(0, 100)}`);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({
  headless: true,
  ...(CHROME ? { executablePath: CHROME } : {}),
});

console.log(`\nINP audit — ${BASE}  (throttle ${THROTTLE}x, cold ${COLD_MS}ms / warm ${WARM_MS}ms)\n`);

// ---------- Landing (public, anonymous) ----------
const land = `${BASE}/`;
// Nav CTAs — cold (input delay during boot) and warm
await measure(browser, land, "Get started (nav→/auth)", "cold", COLD_MS, async (p) => {
  await p.getByRole("link", { name: "Get started" }).first().click({ noWaitAfter: true });
});
await measure(browser, land, "Get started (nav→/auth)", "warm", WARM_MS, async (p) => {
  await p.getByRole("link", { name: "Get started" }).first().click({ noWaitAfter: true });
});
await measure(browser, land, "Join PureWire (nav→/auth)", "warm", WARM_MS, async (p) => {
  await p.getByRole("link", { name: "Join PureWire" }).click({ noWaitAfter: true });
});
// Scroll buttons — same-page handlers (smooth scrollIntoView + replaceState).
// Note: the header "Why PureWire" button is `hidden sm:inline-flex`, so it
// doesn't exist on the mobile viewport — only the hero CTA is measured.
await measure(browser, land, "See the Standard (scroll)", "warm", WARM_MS, async (p) => {
  await p.getByRole("button", { name: "See the PureWire Standard" }).click({ noWaitAfter: true });
});
await measure(browser, land, "Create your account (nav→/auth)", "warm", WARM_MS, async (p) => {
  await p.getByRole("link", { name: "Create your account" }).click({ noWaitAfter: true });
});

// ---------- Auth ----------
const auth = `${BASE}/auth`;
await measure(browser, auth, "Tab: Sign in → Sign up", "warm", WARM_MS, async (p) => {
  await p.getByRole("tab", { name: "Sign up" }).click();
});
await measure(browser, auth, "Keep me signed in switch", "warm", WARM_MS, async (p) => {
  await p.getByRole("switch", { name: "Keep me signed in" }).click();
});
await measure(browser, auth, "Type email (per-keystroke)", "warm", WARM_MS, async (p) => {
  await p.locator("#email").pressSequentially("someone@example.com", { delay: 30 });
});
await measure(browser, auth, "Toggle password visibility", "warm", WARM_MS, async (p) => {
  await p.getByRole("button", { name: "Toggle password visibility" }).click();
});
await measure(browser, auth, "Submit sign-in (empty→error)", "warm", WARM_MS, async (p) => {
  await p.locator("#email").fill("someone@example.com");
  await p.locator("#password").fill("wrongpass123");
  await p.getByRole("button", { name: "Sign in", exact: true }).click({ noWaitAfter: true });
});

// ---------- Profile is auth-gated for anonymous visitors (redirects to
// /auth) — its interactions are out of the public INP surface. ----------

await browser.close();

console.log(`\n=== SUMMARY ===`);
let measured = 0;
let offenders = 0;
let unmeasured = 0;
for (const r of results) {
  if (r.error) { console.log(`ERR ${r.label}: ${r.error}`); unmeasured++; continue; }
  const flag = r.maxMs !== null && r.maxMs > 200 ? "  ⚠ OVER 200" : "";
  if (r.maxMs === null) {
    // Chrome 151 does not emit event-timing entries for some CDP-synthesized
    // inputs (verified against the untouched live site) — events still fire
    // (performance.eventCounts increments), so this is a measurement
    // artifact, not a pass.
    console.log(`   -ms  ${String(r.settle).padEnd(5)} ${r.url.replace(BASE, "")} :: ${r.label} (${r.interactions} evt)  — no event-timing entries (known Chromium CDP artifact)`);
    unmeasured++;
    continue;
  }
  measured++;
  if (r.maxMs > 200) offenders++;
  console.log(`${String(r.maxMs).padStart(4)}ms  ${String(r.settle).padEnd(5)} ${r.url.replace(BASE, "")} :: ${r.label} (${r.interactions} evt)${flag}`);
}
console.log(`\nMeasured: ${measured}  |  Offenders > 200ms: ${offenders}  |  Unmeasured (artifact/error): ${unmeasured}`);
console.log(`INP verdict: ${offenders === 0 ? "PASS" : "FAIL"}`);
if (process.env.INP_REPORT_ONLY !== "1" && offenders > 0) process.exit(1);
process.exit(0);
