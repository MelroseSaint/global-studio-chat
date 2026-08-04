#!/usr/bin/env node
/**
 * PureWire production dense-page inflation QA.
 *
 * Amazon Silk font-boosts text on wide layouts, scaling every rem unit
 * and crowding dense grid UIs (the classic Fire-tablet clutter). The
 * admin-dashboard QA (qa-admin-responsive.mjs) already proves that page
 * survives; this QA applies the same 21px root-font simulation to the
 * other member-facing dense pages at Fire tablet portrait width (800px):
 * Settings, Help & Support, Notifications, and Messages.
 *
 * It signs in as the admin on the live site through the real Auth form
 * (Turnstile gate included), then for each page waits for the lazy chunk
 * heading and for its streaming content to settle (skeletons gone plus a
 * content marker), and asserts there is no page-level horizontal overflow
 * and no element leaks past the viewport under the inflated rem sizes.
 *
 * Run (the password never lives in this file — see lib/qa-secrets.mjs):
 *
 *   ADMIN_PASSWORD=<admin password> npm run qa:pages-inflation
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
  simulateSilkInflation,
} from "./lib/qa-browser.mjs";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 30000);
const NAV_TIMEOUT = 45000;
const CONTENT_WAIT_MS = 20000;
const CONTENT_POLL_MS = 250;

const reporter = createReporter();
const { check } = reporter;

/**
 * Fire-tablet portrait viewport. Width 800px is the widest "tablet" band
 * (Fire HD 8/10 portrait); the QA pins the root font to 21px (~1.3x Silk
 * inflation) before measuring.
 */
const VIEWPORT = { width: 800, height: 1280 };

/**
 * The pages under test. `heading` is the h1 text that proves the lazy
 * chunk mounted; `markers` are the "content actually streamed in" signals
 * — any one matching ends the settle wait. Each page gets its designed
 * empty state plus a generic row selector so a page with live rows never
 * times out waiting for a text that only exists when it's empty.
 */
const PAGES = [
  {
    label: "Settings",
    url: "/settings",
    heading: "Settings",
    markers: [{ text: "Sessions" }],
  },
  {
    label: "Support",
    url: "/support",
    heading: "Help & Support",
    // The tickets list streams after the h2; gate on its content — the
    // designed empty state or a live ticket row (the only element carrying
    // `rounded-xl border p-4`) — not on the synchronous heading.
    markers: [
      { text: "No tickets yet. We're here when you need us." },
      { css: "div[class*='rounded-xl border p-4']" },
    ],
  },
  {
    label: "Notifications",
    url: "/notifications",
    heading: "Notifications",
    markers: [{ text: "You're all caught up" }, { css: "div[class*='cursor-pointer']" }],
  },
  {
    label: "Messages",
    url: "/messages",
    heading: "Messages",
    markers: [{ text: "No conversations yet" }, { css: "button[class*='gap-3']" }],
  },
];

async function markerMatches(page, marker) {
  if (marker.text !== undefined) {
    return (await page.getByText(marker.text, { exact: false }).count()) > 0;
  }
  return (await page.locator(marker.css).count()) > 0;
}

/**
 * Wait for a page to be ready to measure: the lazy chunk's h1 must mount,
 * then skeletons must clear and at least one content marker appear. Keeps
 * the measure from racing the paginated queries the same way the admin QA
 * waits on panel controls rather than sleeping a fixed amount.
 */
async function waitForContent(page, label, { heading, markers }) {
  try {
    await page.waitForSelector(`h1:has-text("${heading}")`, { timeout: TIMEOUT });
  } catch {
    check(`${label}: page rendered (${heading})`, false, "heading never appeared");
    return false;
  }
  const deadline = Date.now() + CONTENT_WAIT_MS;
  while (Date.now() < deadline) {
    const skeletons = await page.locator('[data-slot="skeleton"]').count();
    if (skeletons > 0) {
      await page.waitForTimeout(CONTENT_POLL_MS);
      continue;
    }
    for (const marker of markers) {
      if (await markerMatches(page, marker)) {
        await page.waitForTimeout(400); // final paint beat after the query lands
        return true;
      }
    }
    await page.waitForTimeout(CONTENT_POLL_MS);
  }
  check(`${label}: content rendered`, false, "content markers never appeared");
  return false;
}

async function inspectPage(page, pageDef) {
  await page.goto(`${SITE_URL}${pageDef.url}`, { waitUntil: "domcontentloaded" });
  // page.goto is a FULL document navigation, so any font-size set on a
  // previous page is wiped — the inflation must be re-applied here, on
  // the page actually being measured.
  await simulateSilkInflation(page, 21);
  const ready = await waitForContent(page, pageDef.label, pageDef);
  if (ready) {
    await measurePage(page, `${pageDef.label} (@800px, 21px root font)`, check);
  }
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  console.log(`\nPureWire dense-page inflation QA (${SITE_URL})\n`);
  const browser = await launchBrowser({ headed: HEADED });
  try {
    const page = await browser.newPage({
      viewport: VIEWPORT,
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
    for (const pageDef of PAGES) {
      console.log(`\n--- ${pageDef.label} (800px, 21px root font) ---`);
      await inspectPage(page, pageDef);
    }
  } finally {
    await browser.close();
  }
  reporter.summary();
  if (reporter.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nPages inflation QA crashed:", e.stack ?? e);
  process.exit(1);
});
