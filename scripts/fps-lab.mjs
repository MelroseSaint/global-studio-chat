#!/usr/bin/env node
/**
 * PureWire FPS lab — iPad (9th gen) scroll smoothness at 810px.
 *
 * A lab-mode measurement (not a hard CI gate — shared CI runners make
 * absolute FPS too noisy to gate on, and the point of this script is to
 * give a developer a REPEATABLE number on their own machine): opens the
 * live site in an emulated iPad 9th gen (810×1080, DPR 2, touch, iPad
 * Safari UA) with a 4x CPU throttle via CDP — the A13-era iPad is roughly
 * a 3-4x-throttled modern CPU — signs in, then measures real frames
 * during a programmatic feed scroll:
 *
 *   - average FPS over the scroll + settle window,
 *   - p95 frame interval (the "feels janky" tail),
 *   - long-frame percentage (frames > 50 ms — the dropped-frame class
 *     the eye perceives as stutter).
 *
 * The verdict thresholds are deliberately generous (a lab floor, not a
 * perf target) and env-overridable:
 *
 *   FPS_LAB_MIN_AVG_FPS   (default 40)
 *   FPS_LAB_MAX_P95_MS    (default 60)
 *   FPS_LAB_MAX_LONG_PCT  (default 10)
 *   FPS_LAB_THROTTLE      (default 4)
 *   FPS_LAB_SCROLL_MS     (default 3000)
 *
 * Run:
 *   npm run lab:fps
 *
 * Overrides: SITE_URL (default https://purewire.vercel.app), ADMIN_EMAIL,
 * HEADED=1 to watch the browser, BROWSER_TIMEOUT_MS (default 30000).
 * Exit codes: 0 = within the lab floor, 1 = below it, 2 = missing password.
 */
import { devices } from "playwright";

import { launchBrowser, signIn } from "./lib/qa-browser.mjs";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 30000);
const THROTTLE = Number(process.env.FPS_LAB_THROTTLE ?? 4);
const SCROLL_MS = Number(process.env.FPS_LAB_SCROLL_MS ?? 3000);
const MIN_AVG_FPS = Number(process.env.FPS_LAB_MIN_AVG_FPS ?? 40);
const MAX_P95_MS = Number(process.env.FPS_LAB_MAX_P95_MS ?? 60);
const MAX_LONG_PCT = Number(process.env.FPS_LAB_MAX_LONG_PCT ?? 10);

// iPad (9th gen): 810×1080 at 2x, touch — the target device. Playwright's
// "iPad (gen 7)" descriptor matches the 9th gen's logical viewport.
const IPAD9 = devices["iPad (gen 7)"];

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  console.log(
    `\nPureWire FPS lab — ${SITE_URL}\n` +
      `iPad 9th gen 810×1080 @2x, CPU throttle ${THROTTLE}x, scroll ${SCROLL_MS}ms\n` +
      `Floor: avg ≥ ${MIN_AVG_FPS} FPS, p95 ≤ ${MAX_P95_MS} ms, long frames ≤ ${MAX_LONG_PCT}%\n`,
  );

  const browser = await launchBrowser({ headed: HEADED });
  try {
    const context = await browser.newContext({ ...IPAD9 });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    // The A13 approximation: throttle the emulated device's CPU.
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

    await signIn(page, {
      siteUrl: SITE_URL,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      timeoutMs: TIMEOUT,
      navTimeoutMs: 45000,
    });
    await page.goto(`${SITE_URL}/home`, { waitUntil: "domcontentloaded" });
    // Let the feed stream its first page + lazy chunks before measuring.
    await page.waitForTimeout(3000);

    const result = await page.evaluate(
      async ({ scrollMs }) => {
        const frames = [];
        const collect = (t) => {
          frames.push(t);
          requestAnimationFrame(collect);
        };
        requestAnimationFrame(collect);

        const scrollStart = performance.now();
        const maxY = Math.max(1, document.body.scrollHeight - window.innerHeight);
        await new Promise((resolve) => {
          const step = () => {
            const now = performance.now();
            const prog = Math.min(1, (now - scrollStart) / scrollMs);
            window.scrollTo(0, prog * maxY);
            if (prog < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
        // Settle window — frames after the scroll ends (reflow, images).
        await new Promise((r) => setTimeout(r, 1000));

        const end = performance.now();
        const intervals = [];
        for (let i = 1; i < frames.length; i++) {
          intervals.push(frames[i] - frames[i - 1]);
        }
        const measured = end - scrollStart - 0;
        const avgFps = (frames.length - 1) / (measured / 1000);
        const longFrames = intervals.filter((d) => d > 50).length;
        // Percentile helper must live here — this callback runs in the
        // browser context, where the Node-scope `pct` doesn't exist.
        const pctile = (arr, p) => {
          const sorted = [...arr].sort((a, b) => a - b);
          return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
        };
        return {
          frames: frames.length,
          measuredMs: Math.round(measured),
          avgFps: Math.round(avgFps * 10) / 10,
          p95Ms: Math.round(pctile(intervals, 0.95) * 10) / 10,
          p50Ms: Math.round(pctile(intervals, 0.5) * 10) / 10,
          longPct: Math.round((longFrames / intervals.length) * 1000) / 10,
        };
      },
      { scrollMs: SCROLL_MS },
    );

    console.log("=== 810px feed scroll ===");
    console.log(`  frames:       ${result.frames} over ${result.measuredMs} ms`);
    console.log(`  avg FPS:      ${result.avgFps}`);
    console.log(`  p50 frame:    ${result.p50Ms} ms`);
    console.log(`  p95 frame:    ${result.p95Ms} ms`);
    console.log(`  long (>50ms): ${result.longPct}%`);

    const ok =
      result.avgFps >= MIN_AVG_FPS &&
      result.p95Ms <= MAX_P95_MS &&
      result.longPct <= MAX_LONG_PCT;
    console.log(
      `\n${ok ? "✅" : "❌"} FPS lab verdict: ${
        ok ? "within the floor" : "below the lab floor"
      } (avg≥${MIN_AVG_FPS}, p95≤${MAX_P95_MS}ms, long≤${MAX_LONG_PCT}%)`,
    );
    if (!ok) {
      console.log(
        "Lab measurements on shared runners are noisy — re-run on the target\n" +
          "device or with HEADED=1 before treating a failure as a regression.",
      );
    }
    process.exit(ok ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("fps-lab failed:", err);
  process.exit(1);
});
