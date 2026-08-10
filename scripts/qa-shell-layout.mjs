#!/usr/bin/env node
/**
 * PureWire signed-in shell layout QA — production.
 *
 * The admin-responsive and pages-inflation QAs cover the admin dashboard,
 * the iOS layout QA covers emulated iPhones/iPads, and the landing page is
 * covered by the seo/pages audits — but the signed-in app shell (the feed,
 * explore, messages, notifications, profile, settings) had no committed
 * guard at generic desktop / tablet / mobile widths. This closes that gap.
 *
 * Signs in as the admin on the live site and walks the main shell surfaces
 * at 390px (phone), 768px (tablet), and 1440px (desktop), asserting:
 *
 *   - no horizontal overflow and no element leaks past the viewport
 *     (the same measurePage detector the other browser QAs trust),
 *   - the feed tab strip (Global | Following | Latest | Local | Photos &
 *     videos) renders every label inside the viewport with none clipped —
 *     the tab row is the one surface the screenshot regressions hit,
 *   - the right navigation surface for the width: the bottom tab bar on
 *     phones, the sidebar on tablets and desktops.
 *
 * Run (the password never lives in this file — see lib/qa-secrets.mjs):
 *
 *   ADMIN_PASSWORD=<admin password> npm run qa:shell-layout
 *   # or: printf '%s' '<admin password>' > .freebuff/.admin-password
 *
 * Overrides: SITE_URL (default https://purewire.vercel.app),
 * ADMIN_EMAIL (default monroedoses@gmail.com), HEADED=1 to watch the
 * browser, BROWSER_TIMEOUT_MS (default 30000).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing password.
 */
import {
  createReporter,
  launchBrowser,
  measurePage,
  signIn,
} from "./lib/qa-browser.mjs";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 30000);
const NAV_TIMEOUT = 45000;
const reporter = createReporter();
const { check } = reporter;
// How long each surface gets to stream its lazy chunk + queries before the
// layout is measured — a flat settle beat, generous enough for a slow
// runner because the assertions themselves are structural, not timing.
const SETTLE_MS = 2200;

/** [label, width, height] — the three width bands the shell responds to. */
const WIDTHS = [
  ["mobile", 390, 844],
  ["tablet", 768, 1024],
  ["desktop", 1440, 900],
];

/** The signed-in shell surfaces — the same set a user actually navigates. */
const SURFACES = [
  ["/home", "feed"],
  ["/explore", "explore"],
  ["/messages", "messages"],
  ["/notifications", "notifications"],
  ["/u/adminmelrose", "profile"],
  ["/settings", "settings"],
];

/**
 * The feed tab strip — the top bar in the screenshot regressions: every
 * tab label must sit fully inside the viewport and never be clipped by its
 * own container (the strip truncates on narrow screens by design, but a
 * truncated label is a regression, not a design).
 */
async function inspectFeedTabs(page, widthLabel) {
  const tabs = page.locator('[data-slot="tabs-list"] [data-slot="tabs-trigger"]');
  const count = await tabs.count();
  check(`${widthLabel}: feed tab strip rendered`, count > 0, `tabs=${count}`);
  if (count === 0) return;
  const info = await tabs.evaluateAll((els) =>
    els.map((t) => {
      const b = t.getBoundingClientRect();
      const span = t.querySelector("span") ?? t;
      return {
        text: t.textContent.trim(),
        inViewport: b.left >= -1 && b.right <= window.innerWidth + 1,
        notClipped: span.scrollWidth <= span.clientWidth + 1,
      };
    }),
  );
  const off = info.filter((t) => !t.inViewport).map((t) => t.text);
  const clipped = info.filter((t) => !t.notClipped).map((t) => t.text);
  check(
    `${widthLabel}: all feed tab labels in viewport`,
    off.length === 0,
    off.length ? `off-screen: ${off.join(", ")}` : "",
  );
  check(
    `${widthLabel}: no feed tab label clipped`,
    clipped.length === 0,
    clipped.length ? `clipped: ${clipped.join(", ")}` : "",
  );
}

/**
 * The right navigation surface for the width: a fixed bottom bar on phones
 * (the shell swaps the sidebar for a bottom tab bar below `sm`), and the
 * icon sidebar on tablets and desktops. A phone showing the sidebar (or a
 * desktop showing the bottom bar) is the shell's layout regression.
 */
async function inspectNavSurface(page, widthLabel, width) {
  const nav = await page.evaluate(() => {
    const bottomBar = [...document.querySelectorAll("div, nav")].some((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return (
        cs.position === "fixed" &&
        r.top >= window.innerHeight - 90 &&
        el.querySelectorAll("a, button").length >= 3
      );
    });
    const sidebar = [...document.querySelectorAll("aside, nav")].some((el) => {
      const r = el.getBoundingClientRect();
      return r.left < 100 && r.width > 40 && r.height > 200;
    });
    return { bottomBar, sidebar };
  });
  if (width < 640) {
    check(`${widthLabel}: bottom tab bar on phone`, nav.bottomBar);
  } else {
    check(
      `${widthLabel}: sidebar on ${width < 1024 ? "tablet" : "desktop"}`,
      nav.sidebar,
    );
  }
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  console.log(`\nPureWire shell layout QA (${SITE_URL})\n`);
  const browser = await launchBrowser({ headed: HEADED });
  try {
    for (const [label, width, height] of WIDTHS) {
      console.log(`\n--- ${label} (${width}px) ---`);
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      page.setDefaultTimeout(TIMEOUT);
      await signIn(page, {
        siteUrl: SITE_URL,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        timeoutMs: TIMEOUT,
        navTimeoutMs: NAV_TIMEOUT,
      });
      for (const [path, name] of SURFACES) {
        await page.goto(`${SITE_URL}${path}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(SETTLE_MS);
        await measurePage(page, `${label}: ${name}`, check);
        if (name === "feed") {
          await inspectFeedTabs(page, label);
          await inspectNavSurface(page, label, width);
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  reporter.summary();
  if (reporter.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nShell layout QA crashed:", e.message ?? e);
  process.exit(1);
});
