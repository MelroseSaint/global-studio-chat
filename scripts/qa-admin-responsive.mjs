#!/usr/bin/env node
/**
 * PureWire production admin dashboard responsive QA.
 *
 * Signs in as the admin on the live site through the real Auth form
 * (handling the Turnstile gate the same way the permanent browser QA
 * does), then walks EVERY admin section — AI review, Racism, Stories,
 * Users, Silenced, Security, Content, Tickets, Blocklist, Announcements —
 * through the real section dropdown at 320px, 390px, 768px, the Amazon
 * Fire tablet portrait width (800px), and desktop (1024px). At every stop
 * it verifies the page has no horizontal overflow and no element leaks
 * past the viewport, that the section picker itself fits the screen, and
 * that each panel actually rendered (either its live rows or its designed
 * empty state). On the Users section it also proves the rows use kebab
 * menus instead of a button wall, and on the stats strip it confirms the
 * responsive grid adapts (2/3/5-across) instead of overflowing.
 *
 * It guards the dashboard's decluttered responsive layout so a regression
 * (a control cluster pushed past the fold, a cramped picker row) is
 * caught on the next push instead of by a user on a phone.
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
// How long to keep polling for a section's panel content before giving up. The
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
 * Tailwind bands the stats grid responds to, keyed off the width number
 * (not the label) so any future width stays correct: <sm 2-across,
 * sm 3-across, md+ the full 5-across row (Admin.tsx: grid-cols-2
 * sm:grid-cols-3 md:grid-cols-5).
 */
const statColsAt = (width) => (width >= 768 ? 5 : width >= 640 ? 3 : 2);

/**
 * Every admin section, in the grouped dropdown order (Moderation,
 * Accounts, Platform — see Admin.tsx ADMIN_TABS). The old 7-tab row was
 * replaced by this dropdown so ten panels stay organized on every screen
 * width.
 */
const SECTIONS = [
  "AI review",
  "Racism",
  "Stories",
  "Users",
  "Silenced",
  "Security",
  "Content",
  "Tickets",
  "Blocklist",
  "Announcements",
];

/**
 * Switch the admin to a section through the real dropdown: click the
 * trigger, then the option in the portal. Radix Select renders items in a
 * portal, so the item is looked up globally (not inside the trigger).
 */
// The section picker is always the FIRST enabled combobox on the
// dashboard: it renders in the header row before any panel, so panel
// Selects (the Blocklist filters, the Users role picker) come after it in
// the DOM and `.first()` never confuses them.
const PICKER =
  '[data-slot="select-trigger"]:not([data-disabled])';

// Narrow to the first enabled trigger (the picker) for every use.
const pickerLocator = (page) => page.locator(PICKER).first();

async function selectSection(page, label) {
  await pickerLocator(page).click();
  const item = page
    .locator('[data-slot="select-item"]', { hasText: label })
    .first();
  await item.waitFor({ state: "visible", timeout: TIMEOUT });
  await item.click();
}


/**
 * Wait for a section's panel to actually render. Each panel either shows
 * live rows carrying a recognizable control, or its designed empty state
 * (Users has no empty state — it just needs rows). Polls for either up to
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
 * The per-section structural check. Each panel either renders live rows
 * with a recognizable control or its designed empty state — both are
 * correct, so each check accepts either, and reports which one it found.
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
    tab: "Racism",
    control: "button:has-text('Clear page'), button:has-text('Clear')",
    empty: "No posts flagged for racism review.",
  },
  {
    tab: "Stories",
    control: "button:has-text('Clear page')",
    empty: "No stories waiting on review.",
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
  {
    tab: "Announcements",
    control: "button:has-text('New'), button:has-text('Post announcement')",
    empty: "No announcements yet",
  },
];

async function inspectAdmin(page, widthLabel, width) {
  await page.goto(`${SITE_URL}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(PICKER, { timeout: TIMEOUT });
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

  // Stats strip: present at every width, and the grid adapts 2/3/5-across
  // (phones / sm / md+) instead of the old swipe-to-reveal overflow.
  const statsGrid = page.locator('div[class*="sm:grid-cols-3"]').first();
  check(`${widthLabel}: stats strip present`, await statsGrid.isVisible());
  const statCols = await statsGrid.evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
  );
  const expectedStatCols = statColsAt(width);
  check(
    `${widthLabel}: stats grid ${expectedStatCols}-across (not cramped)`,
    statCols === expectedStatCols,
    `cols=${statCols}`,
  );

  // Section picker: the dropdown replaces the old 7-tab row, so the whole
  // picker row (Select trigger + Shortcuts button) must fit the viewport at
  // every width — no wrap, no overflow. The Select trigger is the one
  // control every section walk depends on, so it staying visible is the
  // exact "can't even navigate" regression this gate exists to catch.
  const trigger = pickerLocator(page);
  const triggerBox = await trigger.boundingBox();
  check(
    `${widthLabel}: section picker trigger fits the viewport`,
    triggerBox !== null &&
      triggerBox.x >= 0 &&
      triggerBox.x + triggerBox.width <= width + 1,
    triggerBox ? `x=${Math.round(triggerBox.x)} w=${Math.round(triggerBox.width)}` : "no box",
  );
  // The Shortcuts button is the trigger's sibling in the same picker row;
  // it staying in the viewport proves the whole row fits (the old tab row
  // used to squeeze past the fold at these widths).
  const shortcuts = page.getByRole("button", { name: "Admin keyboard shortcuts" });
  const shortcutsBox = await shortcuts.boundingBox().catch(() => null);
  check(
    `${widthLabel}: Shortcuts button fits the viewport`,
    shortcutsBox !== null &&
      shortcutsBox.x >= 0 &&
      shortcutsBox.x + shortcutsBox.width <= width + 1,
    shortcutsBox ? `x=${Math.round(shortcutsBox.x)} w=${Math.round(shortcutsBox.width)}` : "no box",
  );

  // The dropdown must list all ten sections (the ten-panel promise of the
  // declutter). Open it, count the options, then close it again.
  await trigger.click();
  await page.waitForSelector('[data-slot="select-item"]', { timeout: TIMEOUT });
  const sectionItems = await page
    .locator('[data-slot="select-item"]')
    .allTextContents();
  check(
    `${widthLabel}: section dropdown lists all ${SECTIONS.length} panels`,
    SECTIONS.every((s) =>
      sectionItems.some((t) => t.trim().startsWith(s)),
    ),
    `items: ${sectionItems.map((t) => t.trim()).join(" | ") || "(none)"}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Walk every section: open the dropdown, pick it, WAIT for its panel,
  // then measure + structural check. Waiting on the selector itself (not a
  // fixed sleep) is what keeps this green on a slow CI runner — the
  // existing browser QA learned that lesson the hard way on the live site.
  for (const { tab, control, empty } of TAB_CONTROLS) {
    await selectSection(page, tab);
    const state = await waitForPanel(page, { control, empty });
    await measurePage(page, `${widthLabel}: ${tab} section`, check);
    const hasControl = state === "controls";
    const hasEmpty = state === "empty";
    check(
      `${widthLabel}: ${tab} section rendered (controls or empty state)`,
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
        // The kebab menu is the dropdown trigger; `control` is the
        // Verify/Unverify button, which toggles verification and opens no
        // menu. Clicking the kebab is what reveals "Remove account".
        await page
          .locator('button[aria-label*="Actions for"]')
          .first()
          .click();
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
    if (tab === "Users") {
      // The removal log is collapsed by default so a wall of old removals
      // never buries the user list (the tablet declutter). Data-aware: when
      // the deployment has no removals the component renders nothing.
      const logToggle = page.locator('button:has-text("Removal log")');
      if ((await logToggle.count()) > 0) {
        const entries = page.locator('text=/removed by /');
        check(
          `${widthLabel}: removal log collapsed by default`,
          (await entries.count()) === 0,
          `${await entries.count()} entries visible before expanding`,
        );
        await logToggle.click();
        await page.waitForTimeout(400);
        check(
          `${widthLabel}: removal log expands to show entries`,
          (await entries.count()) > 0,
        );
        await logToggle.click();
        await page.waitForTimeout(200);
      }
    }
    if (tab === "Tickets") {
      // Long ticket messages clamp at 3 lines behind a "Show more" toggle,
      // so one huge support message can't blow a card taller than the
      // screen. Data-aware: only messages long enough to clamp render the
      // toggle (short messages and the empty state skip).
      const showMore = page.getByRole("button", { name: "Show more", exact: true });
      if ((await showMore.count()) > 0) {
        check(
          `${widthLabel}: long ticket messages clamped (Show more present)`,
          true,
        );
        await showMore.first().click();
        await page.waitForTimeout(300);
        const showLess = page.getByRole("button", { name: "Show less", exact: true });
        check(
          `${widthLabel}: ticket clamp expands to Show less`,
          (await showLess.count()) > 0,
        );
        await showLess.first().click();
        await page.waitForTimeout(200);
      }
    }
    if (tab === "Security") {
      // The per-account audit trail is collapsed behind its "Audit trail"
      // toggle, so a long history never inflates every row (the tablet
      // declutter). Data-aware: only flagged accounts carry the toggle.
      const trailToggle = page.locator('button:has-text("Audit trail")');
      if ((await trailToggle.count()) > 0) {
        check(
          `${widthLabel}: audit trail collapsed by default`,
          (await page.getByText("Current flags").count()) === 0,
        );
        await trailToggle.first().click();
        // The history streams in after the toggle opens — poll, don't sleep.
        const deadline = Date.now() + PANEL_WAIT_MS;
        while (Date.now() < deadline) {
          if ((await page.getByText("Current flags").count()) > 0) break;
          await page.waitForTimeout(PANEL_POLL_MS);
        }
        check(
          `${widthLabel}: audit trail expands to show the history`,
          (await page.getByText("Current flags").count()) > 0,
        );
        await trailToggle.first().click();
        await page.waitForTimeout(200);
      }
    }
    if (tab === "AI review") {
      // The per-post evidence block (scan signals) is collapsed behind its
      // "Evidence" toggle, so the queue stays scannable. Data-aware: only
      // posts waiting on review carry the toggle. EXACT name match — the
      // dashboard also has a "Preview media evidence" button whose text
      // contains "Evidence".
      const evidenceToggle = page.getByRole("button", {
        name: "Evidence",
        exact: true,
      });
      if ((await evidenceToggle.count()) > 0) {
        check(
          `${widthLabel}: AI review evidence collapsed by default`,
          (await page.getByText("AI detector").count()) === 0,
        );
        await evidenceToggle.first().click();
        await page.waitForTimeout(300);
        check(
          `${widthLabel}: AI review evidence expands to show the scan`,
          (await page.getByText("AI detector").count()) > 0,
        );
        await evidenceToggle.first().click();
        await page.waitForTimeout(200);
      }
    }
  }
}

/**
 * Walk the admin's public profile and assert the reconciled counters
 * render truthfully on the LIVE site: the corrected "Posts: 1" (stuck at
 * 5 before the count-drift fix), Followers/Following at their real
 * values, the post card with its "Original" badge, and no overflow. Runs
 * at the desktop stop — the profile is a single-column page whose phone/
 * tablet geometry is already covered by the pages-inflation QA.
 */
async function inspectProfile(page, widthLabel) {
  await page.goto(`${SITE_URL}/u/adminmelrose`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Posts", { timeout: TIMEOUT });
  const stats = await page.evaluate(() => {
    const text = document.body.innerText;
    const num = (label) => {
      const m = text.match(new RegExp(`(\\d+)\\s*${label}`));
      return m ? Number(m[1]) : null;
    };
    return {
      posts: num("Posts"),
      followers: num("Followers"),
      following: num("Following"),
    };
  });
  // The count-drift regression was "counter stuck at 5 while the profile
  // showed 1 post" — the honest guarantee is the header number MATCHES the
  // posts actually rendered on the page. Poll until the post cards stream
  // in (paginated query), then compare. Data-aware: the admin's real post
  // count changes as QA or the owner posts, so a fixed constant would go
  // stale — the reconciliation itself is what's pinned.
  const cardStart = Date.now();
  const cardDeadline = cardStart + PANEL_WAIT_MS;
  let cards = 0;
  while (Date.now() < cardDeadline) {
    cards = await page.locator("article").count();
    if (stats.posts !== null && cards >= stats.posts) break;
    await page.waitForTimeout(PANEL_POLL_MS);
  }
  check(
    `${widthLabel}: profile Posts count matches rendered posts`,
    stats.posts !== null && cards === stats.posts,
    `header ${stats.posts} vs ${cards} card(s)`,
  );
  check(
    `${widthLabel}: profile Followers 0`,
    stats.followers === 0,
    `actual ${stats.followers}`,
  );
  check(
    `${widthLabel}: profile Following 0`,
    stats.following === 0,
    `actual ${stats.following}`,
  );
  // The "Original" badge streams in with the post card's AI-scan verdict,
  // so a single instant count races it on a slow runner — poll, don't
  // sleep (the same lesson as the tab panels).
  const badgeStart = Date.now();
  const badgeDeadline = badgeStart + PANEL_WAIT_MS;
  let badgeSeen = false;
  while (Date.now() < badgeDeadline) {
    if ((await page.getByText("Original", { exact: true }).count()) > 0) {
      badgeSeen = true;
      break;
    }
    await page.waitForTimeout(PANEL_POLL_MS);
  }
  check(
    `${widthLabel}: profile post card renders with the Original badge`,
    badgeSeen,
    badgeSeen ? "" : `not seen in ${Date.now() - badgeStart}ms`,
  );
  await measurePage(page, `${widthLabel}: profile`, check);
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  console.log(`\nPureWire admin dashboard responsive QA (${SITE_URL})\n`);
  const browser = await launchBrowser({ headed: HEADED });
  try {
    // ONE page, ONE sign-in: the browser context keeps the session, so the
    // widths below just resize the viewport. Signing in afresh per width
    // was the CI flake — after the first sign-in the context is already
    // authenticated, /auth redirects instead of rendering #email, and the
    // second signIn call times out waiting for the form (locally the
    // hydration race happened to let #email flash before the redirect; on
    // a slow runner the redirect always wins).
    const page = await browser.newPage({
      viewport: { width: WIDTHS[0][1], height: WIDTHS[0][2] },
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
    for (const [label, width, height] of WIDTHS) {
      console.log(`\n--- ${label} (${width}px) ---`);
      await page.setViewportSize({ width, height });
      await inspectAdmin(page, label, width);
      // The corrected-count profile walk: at the desktop stop only.
      if (width === 1024) {
        await inspectProfile(page, label);
      }
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
