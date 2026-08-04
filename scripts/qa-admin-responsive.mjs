#!/usr/bin/env node
/**
 * PureWire production admin dashboard responsive QA.
 *
 * Signs in as the admin on the live site through the real Auth form
 * (handling the Turnstile gate the same way the permanent browser QA
 * does), then walks EVERY admin tab — Users, Tickets, Content, AI review,
 * Security, Silenced — at 320px, 390px, and 768px. At every stop it
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
import { chromium } from "playwright";

import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";

const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
const HEADED = process.env.HEADED === "1";
const TIMEOUT = Number(process.env.BROWSER_TIMEOUT_MS ?? 30000);
const NAV_TIMEOUT = 45000;
// How long to keep polling for a tab's panel content before giving up. The
// panels stream in after the shell mounts, so we WAIT for each panel's
// control-or-empty-state instead of sleeping a fixed amount — a flat sleep
// races the lazy chunk + paginated query on a slow runner.
const PANEL_WAIT_MS = 20000;
const PANEL_POLL_MS = 250;

/** [label, width, height] — the three widths the audit promises. */
const WIDTHS = [
  ["small phone", 320, 700],
  ["phone", 390, 844],
  ["tablet", 768, 1024],
];

/** Every admin tab, in the order it appears in the UI. */
const TABS = ["Users", "Tickets", "Content", "AI review", "Security", "Silenced", "Blocklist"];

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Detect the Turnstile gate state. "inactive" when the widget isn't
 * rendered (no site key), "passed" when a token was produced, "blocked"
 * when the widget rendered but no token arrived — headless automation can
 * be challenged, and a human or a test-mode site key would be needed.
 */
async function detectTurnstile(page) {
  const widget = page.locator(".cf-turnstile");
  if ((await widget.count()) === 0) return "inactive";
  try {
    await page.waitForSelector(".cf-turnstile iframe", { timeout: 15000 });
  } catch {
    return "blocked";
  }
  try {
    await page.waitForFunction(
      () => {
        const input = document.querySelector(
          'input[name="cf-turnstile-response"]',
        );
        return input !== null && input.value.length > 0;
      },
      { timeout: 20000 },
    );
    return "passed";
  } catch {
    return "blocked";
  }
}

/** Sign in through the real Auth form and land on /home. */
async function signIn(page) {
  await page.goto(`${SITE_URL}/auth`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#email", { timeout: TIMEOUT });
  const gate = await detectTurnstile(page);
  if (gate === "blocked") {
    throw new Error(
      "Turnstile challenge didn't auto-pass under automation — run with HEADED=1 and complete it by hand, or use a test-mode site key.",
    );
  }
  await page.fill("#email", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await page.locator('form button[type="submit"]').click();
  const outcome = await Promise.race([
    page.waitForURL("**/home", { timeout: NAV_TIMEOUT }).then(() => "home"),
    page
      .waitForSelector('p[class*="text-destructive"]', { timeout: NAV_TIMEOUT })
      .then(() => "error"),
  ]);
  if (outcome !== "home") {
    const url = page.url();
    const err = await page
      .locator('p[class*="text-destructive"]')
      .first()
      .textContent()
      .catch(() => "");
    throw new Error(`sign-in did not land on /home (${url}${err ? ` — ${err}` : ""})`);
  }
}

/**
 * Measure the current page: page-level horizontal overflow plus any
 * non-fixed element whose right edge passes the viewport without a
 * clipping ancestor (overflow hidden/auto/scroll). The stats strip's cards
 * intentionally extend past the fold inside their own scroll container —
 * the clipping-ancestor check is what tells that apart from a real leak.
 */
async function measurePage(page, label) {
  const vp = await page.evaluate(() => ({
    innerW: window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
  }));
  check(
    `${label}: no horizontal overflow`,
    vp.scrollW <= vp.innerW,
    `scrollW=${vp.scrollW} innerW=${vp.innerW}`,
  );
  const leaks = await page.evaluate(() => {
    const vw = window.innerWidth;
    const out = [];
    const clippedByAncestor = (el) => {
      let n = el.parentElement;
      while (n) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll|hidden)/.test(cs.overflowX)) return true;
        n = n.parentElement;
      }
      return false;
    };
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 2 && r.width > 0 && !clippedByAncestor(el)) {
        if (getComputedStyle(el).position === "fixed") return;
        out.push(
          `<${el.tagName}> r=${Math.round(r.right)} class="${(el.getAttribute("class") || "").slice(0, 60)}"`,
        );
      }
    });
    return out.slice(0, 6);
  });
  check(
    `${label}: no elements leak past the viewport`,
    leaks.length === 0,
    leaks.join(" | "),
  );
}

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
    control: 'button[aria-label*="Actions for"]',
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

async function inspectAdmin(page, widthLabel) {
  await page.goto(`${SITE_URL}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-slot="tabs-list"]', { timeout: TIMEOUT });
  // Wait for the default Users panel (the stats strip + rows stream in
  // after the shell mounts) before measuring the initial view.
  await waitForPanel(page, TAB_CONTROLS[0]);

  await measurePage(page, `${widthLabel}: /admin`);

  // Stats strip: present at every width; the swipe cue only on phones.
  check(
    `${widthLabel}: stats strip present`,
    await page
      .locator('div[class*="snap-x"], div[class*="sm:grid-cols-3"]')
      .first()
      .isVisible(),
  );
  if (widthLabel !== "tablet") {
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

  // Tabs: all seven present. Phones spread 3-across, tablets 4-across,
  // desktops the full 7-across row — never cramped.
  const tabs = page.locator('[data-slot="tabs-list"] [data-slot="tabs-trigger"]');
  check(`${widthLabel}: all 7 admin tabs rendered`, (await tabs.count()) === 7);
  const cols = await page
    .locator('[data-slot="tabs-list"]')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  const expectedCols = widthLabel === "tablet" ? 4 : 3;
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
    await measurePage(page, `${widthLabel}: ${tab} tab`);
    const hasControl = state === "controls";
    const hasEmpty = state === "empty";
    check(
      `${widthLabel}: ${tab} tab rendered (controls or empty state)`,
      state !== "timeout",
      hasControl ? "controls present" : hasEmpty ? `empty state: "${empty}"` : "neither appeared in time",
    );
    if (tab === "Users") {
      check(
        `${widthLabel}: Users rows use kebab menus`,
        hasControl,
        "no kebab menus found — rows may still be loading",
      );
      if (hasControl) {
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
  const browser = await chromium.launch({ headless: !HEADED });
  try {
    for (const [label, width, height] of WIDTHS) {
      console.log(`\n--- ${label} (${width}px) ---`);
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      page.setDefaultTimeout(TIMEOUT);
      await signIn(page);
      await inspectAdmin(page, label);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nAdmin responsive QA crashed:", e.message ?? e);
  process.exit(1);
});
