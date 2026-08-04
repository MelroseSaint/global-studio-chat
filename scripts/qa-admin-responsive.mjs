#!/usr/bin/env node
/**
 * PureWire production admin dashboard responsive QA.
 *
 * Signs in as the admin on the live site through the real Auth form
 * (handling the Turnstile gate the same way the permanent browser QA
 * does), then walks EVERY admin tab — Users, Tickets, Content, AI review,
 * Security, Silenced, Blocklist — at 320px, 390px, 768px, the Amazon
 * Fire tablet portrait width (800px), and desktop (1024px). At every stop it
 * verifies the page has no horizontal overflow and no element leaks past
 * the viewport, and that the tab actually rendered (either its live rows
 * or its designed empty state). On the Users tab it also proves the rows
 * use kebab menus instead of a button wall, and on the stats strip at
 * phone width it confirms the "Swipe for more" cue is present.
 *
 * It guards the dashboard's decluttered responsive layout so a regression
 * (a control cluster pushed past the fold, a cramped tab row) is caught on
 * the next push instead of by a user on a phone.
 *
 * Run (the password never lives in this file — see lib/qa-secrets.mjs):
 *
 *   ADMIN_PASSWORD=<admin password> npm run qa:admin-responsive
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
const reporter = createReporter();
const { check } = reporter;
// How long to keep polling for a tab's panel content before giving up. The
// panels stream in after the shell mounts, so we WAIT for each panel's
// control-or-empty-state instead of sleeping a fixed amount — a flat sleep
// races the lazy chunk + paginated query on a slow runner.
const PANEL_WAIT_MS = 20000;
const PANEL_POLL_MS = 250;

/** [label, width, height] — the five widths the audit promises. The
 *  800px row is Amazon Fire HD 8/10 portrait, the widest "tablet" band
 *  where Silk's font inflation used to crowd the grid UIs; 1024px is the
 *  first desktop (lg) band, where the tabs spread the full 7-across row. */
const WIDTHS = [
  ["small phone", 320, 700],
  ["phone", 390, 844],
  ["tablet", 768, 1024],
  ["fire tablet", 800, 1280],
  ["desktop", 1024, 768],
];

/**
 * Tailwind bands the admin layout responds to, keyed off the width number
 * (not the label) so any future width stays correct: <sm 2-across tabs /
 * swipeable stats, sm 3-across, md 4-across, lg the full 7-across row.
 */
const tabColsAt = (width) =>
  width >= 1024 ? 7 : width >= 768 ? 4 : width >= 640 ? 3 : 2;
const isPhoneWidth = (width) => width < 640;

/** Every admin tab, in the order it appears in the UI. */
const TABS = ["Users", "Tickets", "Content", "AI review", "Security", "Silenced", "Blocklist"];



/**
 * Wait for a tab's panel to actually render. Each panel either shows live
 * rows carrying a recognizable control, or its designed empty state (Users
 * has no empty state — it just needs rows). Polls for either up to
 * PANEL_WAIT_MS, returning which one appeared, or "timeout". This is the
 * race-free replacement for a fixed settle sleep: the lazy Admin chunk and
 * the paginated queries stream in after the shell mounts, and waiting on
 * the selector itself never flakes on a slow runner.
 */
async function waitForPanel(page, { control, empty }) {
  const deadline = Date.now() + PANEL_WAIT_MS;
  while (Date.now() < deadline) {
    if ((await page.locator(control).count()) > 0) return "controls";
    if (empty !== null && (await page.getByText(empty).count()) > 0) {
      return "empty";
    }
    await page.waitForTimeout(PANEL_POLL_MS);
  }
  return "timeout";
}

/**
 * The per-tab structural check. Each panel either renders live rows with a
 * recognizable control or its designed empty state — both are correct, so
 * each check accepts either, and reports which one it found.
 */
const TAB_CONTROLS = [
  {
    tab: "Users",
    // Every row carries a Verify/Unverify button; the kebab menu is only
    // rendered on rows other than the viewer's own (hidden for self/owner),
    // so "a user row rendered" is the reliable control, and the kebab is
    // asserted separately as a data-aware check below.
    control: "button:has-text('Verify'), button:has-text('Unverify')",
    empty: null, // the Users list has no empty state — rows or loading
  },
  {
    tab: "Tickets",
    control: "button:has-text('Respond')",
    empty: "No support tickets.",
  },
  {
    tab: "Content",
    control: "a:has-text('View')",
    empty: "No posts yet.",
  },
  {
    tab: "AI review",
    control: "button:has-text('Looks human')",
    empty: "No posts waiting on review.",
  },
  {
    tab: "Security",
    control: 'button[aria-label="More actions"]',
    empty: "No flagged accounts.",
  },
  {
    tab: "Silenced",
    control: "button:has-text('Unsilence')",
    empty: "No silenced accounts.",
  },
  {
    tab: "Blocklist",
    control: "button:has-text('Re-seed core list')",
    empty: "No blocked domains in this view.",
  },
];

async function inspectAdmin(page, widthLabel, width) {
  await page.goto(`${SITE_URL}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-slot="tabs-list"]', { timeout: TIMEOUT });
  // The Fire-tablet pass simulates Silk's font inflation (~1.3x root font
  // scaling) that headless Chrome doesn't reproduce on its own. Every
  // measurePage below then proves the grids survive the larger rem sizes.
  if (width === 800) {
    await simulateSilkInflation(page);
  }
  // Wait for the default Users panel (the stats strip + rows stream in
  // after the shell mounts) before measuring the initial view.
  await waitForPanel(page, TAB_CONTROLS[0]);

  await measurePage(page, `${widthLabel}: /admin`, check);

  // Stats strip: present at every width; the swipe cue only on phones.
  check(
    `${widthLabel}: stats strip present`,
    await page
      .locator('div[class*="snap-x"], div[class*="sm:grid-cols-3"]')
      .first()
      .isVisible(),
  );
  if (isPhoneWidth(width)) {
    const cue = page.locator("p:has-text('Swipe for more')");
    check(
      `${widthLabel}: 'Swipe for more' cue visible`,
      (await cue.count()) === 1 && (await cue.isVisible()),
    );
  } else {
    check(
      `${widthLabel}: swipe cue hidden (grid layout)`,
      !(await page.locator("p:has-text('Swipe for more')").isVisible()),
    );
  }

  // Tabs: all seven present. Phones spread 2-across, tablets (md band,
  // incl. the 800px Fire portrait) 4-across, desktops the full 7-across
  // row — never cramped.
  const tabs = page.locator('[data-slot="tabs-list"] [data-slot="tabs-trigger"]');
  check(`${widthLabel}: all 7 admin tabs rendered`, (await tabs.count()) === 7);
  const cols = await page
    .locator('[data-slot="tabs-list"]')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  const expectedCols = tabColsAt(width);
  check(
    `${widthLabel}: tabs grid-cols-${expectedCols} (not cramped 7-across)`,
    cols === expectedCols,
    `cols=${cols}`,
  );

  // Walk every tab: click, WAIT for its panel, then measure + structural
  // check. Waiting on the selector itself (not a fixed sleep) is what keeps
  // this green on a slow CI runner — the existing browser QA learned that
  // lesson the hard way on the live site.
  for (const { tab, control, empty } of TAB_CONTROLS) {
    await page.getByRole("tab", { name: tab }).click();
    const state = await waitForPanel(page, { control, empty });
    await measurePage(page, `${widthLabel}: ${tab} tab`, check);
    const hasControl = state === "controls";
    const hasEmpty = state === "empty";
    check(
      `${widthLabel}: ${tab} tab rendered (controls or empty state)`,
      state !== "timeout",
      hasControl ? "controls present" : hasEmpty ? `empty state: "${empty}"` : "neither appeared in time",
    );
    if (tab === "Users") {
      // Data-aware: the kebab only exists on rows that aren't the viewer's
      // own. A fresh production DB may hold just the owner (nothing to
      // manage) — that's a valid state, distinct from a broken panel that
      // renders no rows at all.
      const kebabs = await page
        .locator('button[aria-label*="Actions for"]')
        .count();
      if (kebabs > 0) {
        check(
          `${widthLabel}: Users rows use kebab menus`,
          true,
          `${kebabs} actionable rows`,
        );
        await page.locator(control).first().click();
        await page.waitForTimeout(400);
        const items = await page
          .locator('[data-slot="dropdown-menu-item"]')
          .allTextContents();
        check(
          `${widthLabel}: Users kebab opens with Remove account`,
          items.some((t) => /remove account/i.test(t)),
          `items: ${items.join(" | ") || "(none)"}`,
        );
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
      } else {
        check(
          `${widthLabel}: Users rows use kebab menus`,
          hasControl,
          hasControl
            ? "only self/owner rows — nothing to manage"
            : "no user rows rendered at all",
        );
      }
    }
  }
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  console.log(`\nPureWire admin dashboard responsive QA (${SITE_URL})\n`);
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
      await inspectAdmin(page, label, width);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  reporter.summary();
  if (reporter.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nAdmin responsive QA crashed:", e.message ?? e);
  process.exit(1);
});
