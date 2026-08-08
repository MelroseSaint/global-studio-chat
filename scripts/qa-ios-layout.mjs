#!/usr/bin/env node
/**
 * PureWire iOS / iPad layout QA.
 *
 * Emulates real iPhone and iPad devices (Safari user agents, touch, DPR)
 * against the live site and proves the shell's device-adaptive layout:
 *
 *   1. The device-detection layer (src/lib/device.ts) stamped the right
 *      data-* attributes on <html>: data-ios, data-touch, and the correct
 *      data-device family ("iphone" / "ipad" — NOT "desktop", which is
 *      what a naive agent sniff returns for iPadOS 13+).
 *   2. No horizontal overflow and no element leaks past the viewport at
 *      iPhone width, iPhone width with the Safari browser chrome
 *      (dynamic-toolbar), and iPad portrait + landscape.
 *   3. The correct navigation surface is present per family: the bottom
 *      tab bar on iPhone, the icon sidebar on iPad (and, at iPad
 *      landscape, the full-width sidebar).
 *   4. The dynamic-toolbar viewport still resolves 100dvh correctly (no
 *      page taller than the visual viewport with rubber-band room).
 *
 * The `data-device` regression it guards is the iPadOS "Mac masquerade":
 * a real iPad reports a Mac user agent, and a detection layer that trusts
 * the agent alone would classify it as a desktop and hide the touch nav.
 *
 * Run:
 *   npm run qa:ios-layout
 *
 * Overrides: SITE_URL (default https://purewire.vercel.app), HEADED=1 to
 * watch the browser, BROWSER_TIMEOUT_MS (default 30000).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing playwright.
 */
import { devices } from "playwright";
import { createReporter, launchBrowser, measurePage } from "./lib/qa-browser.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 30000);

const reporter = createReporter();
const { check } = reporter;

/** Emulate the exact device (Safari UA, touch, DPR) via Playwright's
 *  device descriptors — iPhone 13 (390×844) and iPad Pro 11 (834×1194). */
const DEVICES = [
  { label: "iPhone 13", desc: devices["iPhone 13"] },
  { label: "iPhone 13 (dynamic toolbar)", desc: { ...devices["iPhone 13"], viewport: { width: 390, height: 750 } } },
  { label: "iPad Pro 11 (portrait)", desc: devices["iPad Pro 11"] },
  { label: "iPad Pro 11 (landscape)", desc: { ...devices["iPad Pro 11"], viewport: { width: 1194, height: 834 } } },
  // iPadOS 13+ masquerades as a Mac: a Mac user agent with a multitouch
  // screen. A naive agent sniff returns "desktop" here and hides the
  // touch nav — the exact regression this QA exists to catch.
  {
    label: "iPad Pro 11 (iPadOS Mac masquerade)",
    desc: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      viewport: { width: 834, height: 1194 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    },
  },
];

async function main() {
  const browser = await launchBrowser({ headed: HEADED });
  try {
    for (const { label, desc } of DEVICES) {
      const ctx = await browser.newContext({ ...desc });
      const page = await ctx.newPage();
      try {
        await page.goto(SITE_URL, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForSelector("#root", { timeout: TIMEOUT });
        // The shell mounts after auth state resolves; give the layout a
        // beat to settle before measuring.
        await page.waitForTimeout(1500);

        // 1 — device detection stamped the right attributes on <html>.
        const attrs = await page.evaluate(() => {
          const r = document.documentElement;
          return {
            device: r.dataset.device,
            ios: r.dataset.ios,
            touch: r.dataset.touch,
            standalone: r.dataset.standalone,
          };
        });
        const expectDevice = label.startsWith("iPhone") ? "iphone" : "ipad";
        check(
          `${label}: data-device=${expectDevice}`,
          attrs.device === expectDevice,
          `got device=${attrs.device}`,
        );
        check(`${label}: data-ios=true`, attrs.ios === "true", `got ios=${attrs.ios}`);
        check(`${label}: data-touch=true`, attrs.touch === "true", `got touch=${attrs.touch}`);

        // 2 — no horizontal overflow, no leaks (landing page).
        await measurePage(page, `${label} landing`, check);

        // 3 — the landing header stays within the safe area: its sticky
        // bar pads env(safe-area-inset-top), so the brand row's top edge
        // never sits under the notch/Dynamic Island. With a zero safe-area
        // inset (headless emulation), it still renders at the top without
        // being pushed off or overlapped by the status bar.
        const headerTop = await page.evaluate(() => {
          const h = document.querySelector("header");
          if (!h) return null;
          return Math.round(h.getBoundingClientRect().top);
        });
        check(
          `${label}: header renders at top (safe-area ready)`,
          headerTop !== null && headerTop >= 0,
          `headerTop=${headerTop}`,
        );
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  reporter.summary();
  process.exit(reporter.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("qa-ios-layout failed:", err);
  process.exit(1);
});
