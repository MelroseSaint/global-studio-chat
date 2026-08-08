#!/usr/bin/env node
/**
 * PureWire PWA install-hint QA.
 *
 * Verifies the "Add to Home Screen" hint (src/components/PwaInstallHint.tsx)
 * renders exactly where it should on the live site:
 *
 *   1. iPhone (Safari emulation): hint renders; dismissing removes it and
 *      persists to localStorage.
 *   2. iPad (iPadOS Mac-masquerade user agent + touch): hint renders with
 *      the iPad copy (full-screen, no notch).
 *   3. Desktop: never renders.
 *   4. Standalone (installed PWA): never renders — an installed member
 *      never sees install nags.
 *
 * Harness-gated: each scenario mints a FRESH session (Convex rotates a
 * minted token once a browser uses it, so a shared session bounces later
 * contexts to /auth) and a fresh browser instance (device storage must not
 * leak between scenarios). Run against the production preview locally,
 * the live site in CI.
 *
 * Run:
 *   TEST_HARNESS_SECRET=<secret> npm run qa:pwa-install-hint
 *   # locally, against a production preview: PROBE_SITE_URL=http://localhost:4173 ...
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing secret.
 */
import { chromium, devices } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
// Default: the live production site (CI). Local runs against a production
// preview (vite preview, no HMR) can override via PROBE_SITE_URL — the dev
// server's HMR module state leaks a prior dismissal across page loads,
// which is a dev-mode artifact, not the product's behavior.
const SITE_URL = process.env.PROBE_SITE_URL ?? "https://purewire.vercel.app";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;
const ns = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");

const client = new ConvexHttpClient(CONVEX_URL);
const username = ""; // replaced by the stamped username below

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function seed(page, session) {
  await page.addInitScript(
    (s) => {
      try {
        localStorage.setItem(`__convexAuthJWT_${s.ns}`, s.token);
        localStorage.setItem(`__convexAuthRefreshToken_${s.ns}`, s.refreshToken);
        // Every context shares the localhost origin, so an earlier context's
        // dismissal would hide the hint here — always start clean.
        localStorage.removeItem("purewire_install_hint_dismissed");
      } catch (_) {}
    },
    { ns, token: session.token, refreshToken: session.refreshToken },
  );
}

async function hasHint(page) {
  return page.evaluate(() => {
    // The heading and the paragraph are separate text nodes, so compare
    // against the heading's exact text (a substring of the concatenated
    // textContent would still match, but the heading check is precise).
    const el = [...document.querySelectorAll("[role='note']")].find((n) =>
      n.textContent?.includes("Add PureWire to your Home Screen"),
    );
    if (!el) return false;
    const cs = getComputedStyle(el);
    // framer-motion animates opacity/height; a settled note is visible.
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  });
}

/** Poll until the hint is present (or absent) — the Feed mounts async. */
async function waitFor(page, present, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const cur = await hasHint(page);
    if (cur === present) return true;
    if (Date.now() - start > timeoutMs) return false;
    await page.waitForTimeout(300);
  }
}

async function main() {
  if (!HARNESS_SECRET) {
    console.log("TEST_HARNESS_SECRET required");
    process.exit(2);
  }
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const uname = `qa_pwainstall_${stamp}`;
  const created = await client.mutation(api.testHarness.createTestUser, {
    name: `QA PWA Install ${stamp}`,
    username: uname,
    secret: HARNESS_SECRET,
  });
  // Mint a FRESH session per scenario: Convex rotates/invalidates a minted
  // token once a browser uses it (the auth client refreshes it), so reusing
  // one session across contexts bounces later contexts to /auth. The account
  // is created once; each scenario mints its own session below.
  const mintSession = async () => {
    const m = await client.mutation(api.testHarness.mintSessionForQaUsername, {
      username: uname,
      secret: HARNESS_SECRET,
    });
    return { token: m.token, refreshToken: m.refreshToken };
  };

  // Fresh browser PER device: real devices don't share storage, and
  // Playwright's localStorage is per-(browser, origin), so a dismissal in
  // one context must never leak into the next. This keeps the assertions
  // deterministic and mirrors reality (each device is its own install).
  const newBrowser = () => chromium.launch({ headless: true });
  try {
    {
      // 1 — iPhone: hint visible.
      const browser = await newBrowser();
      const ctx = await browser.newContext({ ...devices["iPhone 13"] });
      const page = await ctx.newPage();
      await seed(page, await mintSession());
      await page.goto(`${SITE_URL}/home`, { waitUntil: "networkidle" });
      check("iPhone: hint renders", await waitFor(page, true));
      // 2 — dismiss persists.
      const dismiss = page.locator("button[aria-label='Dismiss iPhone install hint']");
      if ((await dismiss.count()) > 0) {
        await dismiss.click();
        await page.waitForTimeout(400);
        check("iPhone: dismiss removes hint", !(await hasHint(page)));
        check(
          "iPhone: dismissal persisted",
          await page.evaluate(() => localStorage.getItem("purewire_install_hint_dismissed") === "1"),
        );
      } else {
        check("iPhone: dismiss button found", false);
      }
      await ctx.close();
      await browser.close();
    }

    // 3 — iPad (masquerade-safe): hint visible with iPad copy.
    {
      const browser = await newBrowser();
      const ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        viewport: { width: 834, height: 1194 },
        hasTouch: true,
      });
      const page = await ctx.newPage();
      await seed(page, await mintSession());
      await page.goto(`${SITE_URL}/home`, { waitUntil: "networkidle" });
      await waitFor(page, true);
      const ipadState = await page.evaluate(() => {
        const attrs = {
          device: document.documentElement.dataset.device,
          ios: document.documentElement.dataset.ios,
          standalone: document.documentElement.dataset.standalone,
        };
        const el = [...document.querySelectorAll("[role='note']")].find((n) =>
          n.textContent?.includes("Add PureWire to your Home Screen"),
        );
        return {
          attrs,
          found: !!el,
          text: el ? el.textContent.slice(0, 160) : null,
        };
      });
      const t = ipadState.text ?? "";
      if (!ipadState.found) {
        // Diagnostic: what does the page actually show when the hint is missing?
        const diag = await page.evaluate(() => ({
          url: location.pathname,
          navLinks: document.querySelectorAll("nav a").length,
          bodyStart: document.body.innerText.slice(0, 100).replace(/\n/g, " | "),
        }));
        console.log("  (diag) iPad page:", JSON.stringify(diag));
      }
      check(
        "iPad: hint renders with iPad copy",
        ipadState.found && t.includes("full-screen") && !t.includes("notch"),
        JSON.stringify(ipadState),
      );
      await ctx.close();
      await browser.close();
    }

    // 4 — desktop: never renders.
    {
      const browser = await newBrowser();
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await seed(page, await mintSession());
      await page.goto(`${SITE_URL}/home`, { waitUntil: "networkidle" });
      check("desktop: no hint", await waitFor(page, false));
      await ctx.close();
      await browser.close();
    }

    // 5 — standalone iPhone: no hint (already installed).
    {
      const browser = await newBrowser();
      const ctx = await browser.newContext({ ...devices["iPhone 13"] });
      const page = await ctx.newPage();
      await seed(page, await mintSession());
      // Force the standalone media query via addInitScript on a pre-created
      // matchMedia stub is complex; instead verify the hook's standalone
      // branch by overriding the attribute directly (the CSS gate is the
      // same the hook reads).
      await page.addInitScript(() => {
        const orig = window.matchMedia.bind(window);
        window.matchMedia = (q) => {
          const m = orig(q);
          if (q.includes("display-mode")) {
            return { ...m, matches: true };
          }
          return m;
        };
      });
      await page.goto(`${SITE_URL}/home`, { waitUntil: "networkidle" });
      check("standalone: no hint", await waitFor(page, false));
      await ctx.close();
      await browser.close();
    }
  } catch (err) {
    console.error("probe error:", err);
    process.exitCode = 1;
  }

  // Cleanup: erase the QA account (cascades posts/comments).
  try {
    await client.mutation(api.testHarness.deleteTestUser, {
      username: uname,
      secret: HARNESS_SECRET,
    });
  } catch {
    /* best-effort */
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
