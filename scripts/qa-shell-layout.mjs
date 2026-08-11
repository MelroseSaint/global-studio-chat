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
 * Run (signed-in sessions come from the harness when possible — the
 * password never lives in this file, see lib/qa-secrets.mjs):
 *
 *   TEST_HARNESS_SECRET=<secret> npm run qa:shell-layout   # CI path
 *   ADMIN_PASSWORD=<admin password> npm run qa:shell-layout # local fallback
 *   # or: printf '%s' '<admin password>' > .freebuff/.admin-password
 *
 * With TEST_HARNESS_SECRET set, ONE admin session is minted via the
 * harness and seeded into every width's browser context, so the QA never
 * touches the auth library's password sign-in rate limit (10/hour per
 * identifier) — the failure mode that redded this job in CI when the
 * healthcheck chain and the 5-per-width sign-ins shared the admin's
 * budget. Without it (local only), each width falls back to a password
 * sign-in.
 *
 * Overrides: SITE_URL (default https://purewire.vercel.app),
 * ADMIN_EMAIL (default monroedoses@gmail.com), CONVEX_URL (default
 * https://outgoing-seal-727.convex.cloud), HEADED=1 to watch the
 * browser, BROWSER_TIMEOUT_MS (default 30000).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing auth.
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
// The QA signs in as the platform admin — but NOT via the password flow
// when it can avoid it. The auth library rate-limits password sign-ins to
// 10/hour/identifier, and this QA opens one browser context PER WIDTH (5
// widths), so the old sign-in-per-width design burned up to 5 of those
// attempts per run — and shared the same admin identifier as the whole
// healthcheck chain, so CI runs would trip "too many sign-in attempts" on
// the 3rd-4th width and fail the gate. With TEST_HARNESS_SECRET, the QA
// instead mints ONE admin session via the harness and seeds it into every
// context's localStorage (`__convexAuthJWT_<ns>` / refresh token, the same
// keys the app's Convex client reads — the refresh-timing QA uses this
// exact pattern). The password flow stays only as a no-secret fallback for
// local runs.
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 30000);
const NAV_TIMEOUT = 45000;
const reporter = createReporter();
const { check } = reporter;
// How long each surface gets to stream its lazy chunk + queries before the
// layout is measured. `domcontentloaded` fires before the signed-in shell
// mounts (lazy chunk + Convex queries), so a flat beat can measure a page
// that is still a blank shell — a false negative on a slow runner or a
// live site under load. The QA tests LAYOUT, not load speed, so it first
// waits for the surface to actually mount (nav surface for every page, the
// feed tab strip on /home), then gives the layout a short settle beat.
const SETTLE_MS = 2200;
const MOUNT_TIMEOUT_MS = 12000;

/** [label, width, height] — the width bands the shell responds to.
 *  `ipad9-*` are the iPad (9th gen) dimensions (810×1080 / 1080×810) —
 *  the entry-level 10.2\" model, the narrowest modern iPad: 810px portrait
 *  is past `md` but under `lg` (icon-rail sidebar), 1080px landscape
 *  crosses `lg` (full-width sidebar). The Pro-11 width (834) used to be
 *  the only tablet band, so the tighter 9th-gen widths were never guarded. */
const WIDTHS = [
  ["mobile", 390, 844],
  ["tablet", 768, 1024],
  ["ipad9 portrait", 810, 1080],
  ["ipad9 landscape", 1080, 810],
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
 * Wait for the signed-in shell to mount: the width-appropriate nav surface
 * (bottom bar on phones, sidebar on tablets/desktops) is present on every
 * authenticated page once the lazy shell chunk + queries resolve, so it is
 * the reliable "shell is up" signal. On /home the feed tab strip is the
 * surface the checks care about, so wait for it too. Bounded — if the
 * shell never mounts in time, the subsequent structural checks fail for
 * real instead of flaking on a slow load.
 */
async function waitForMount(page, width) {
  const wantBottom = width < 640;
  const start = Date.now();
  while (Date.now() - start < MOUNT_TIMEOUT_MS) {
    const mounted = await page.evaluate((bottom) => {
      const navPresent = bottom
        ? [...document.querySelectorAll("div, nav")].some((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return (
              cs.position === "fixed" &&
              r.top >= window.innerHeight - 90 &&
              el.querySelectorAll("a, button").length >= 3
            );
          })
        : [...document.querySelectorAll("aside, nav")].some((el) => {
            const r = el.getBoundingClientRect();
            return r.left < 100 && r.width > 40 && r.height > 200;
          });
      return navPresent;
    }, wantBottom);
    if (mounted) return;
    await page.waitForTimeout(300);
  }
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

/**
 * Mint ONE admin session through the harness and return the localStorage
 * seed object for it, or null when no TEST_HARNESS_SECRET is available
 * (local runs fall back to the password flow). The ns must match what the
 * app's Convex client uses for its storage keys — derived from the URL,
 * exactly as refresh-timing-qa does.
 */
async function mintAuthSeed() {
  if (!HARNESS_SECRET) return null;
  const { ConvexHttpClient } = await import("convex/browser");
  const { api } = await import("../src/convex/_generated/api.js");
  const client = new ConvexHttpClient(CONVEX_URL);
  const admin = await client.mutation(api.testHarness.mintAdminSession, {
    secret: HARNESS_SECRET,
  });
  if (!admin?.token || !admin?.refreshToken) {
    throw new Error("harness mintAdminSession returned no token");
  }
  console.log("signed in: one harness-minted admin session (shared across widths)");
  return {
    ns: CONVEX_URL.replace(/[^a-zA-Z0-9]/g, ""),
    token: admin.token,
    refreshToken: admin.refreshToken,
  };
}

async function main() {
  const authSeed = await mintAuthSeed();
  if (!authSeed && !ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  console.log(`\nPureWire shell layout QA (${SITE_URL})\n`);
  const browser = await launchBrowser({ headed: HEADED });
  try {
    for (const [label, width, height] of WIDTHS) {
      console.log(`\n--- ${label} (${width}px) ---`);
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      if (authSeed) {
        await context.addInitScript(
          (seed) => {
            try {
              localStorage.setItem(`__convexAuthJWT_${seed.ns}`, seed.token);
              localStorage.setItem(
                `__convexAuthRefreshToken_${seed.ns}`,
                seed.refreshToken,
              );
            } catch (_) {}
          },
          authSeed,
        );
      }
      const page = await context.newPage();
      page.setDefaultTimeout(TIMEOUT);
      if (!authSeed) {
        await signIn(page, {
          siteUrl: SITE_URL,
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          timeoutMs: TIMEOUT,
          navTimeoutMs: NAV_TIMEOUT,
        });
      }
      for (const [path, name] of SURFACES) {
        await page.goto(`${SITE_URL}${path}`, { waitUntil: "domcontentloaded" });
        await waitForMount(page, width);
        // The feed tab strip is what the screenshot regressions hit, so
        // wait for it specifically before the settle beat on /home.
        if (name === "feed") {
          await page
            .waitForSelector('[data-slot="tabs-list"] [data-slot="tabs-trigger"]', {
              timeout: MOUNT_TIMEOUT_MS,
            })
            .catch(() => {});
        }
        await page.waitForTimeout(SETTLE_MS);
        await measurePage(page, `${label}: ${name}`, check);
        if (name === "feed") {
          await inspectFeedTabs(page, label);
          await inspectNavSurface(page, label, width);
        }
      }
      await context.close();
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
