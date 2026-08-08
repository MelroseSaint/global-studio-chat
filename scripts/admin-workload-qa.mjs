#!/usr/bin/env node
/**
 * PureWire admin moderationWorkload crash-class regression QA.
 *
 * Guards the exact failure that once replaced the whole app with React
 * Router's bare "Unexpected Application Error!" page: `admin:moderationWorkload`
 * is admin-gated (requireAdmin -> assertAdminIpVerified), and in this Convex
 * version useQuery THROWS query errors during render. Two independent
 * guarantees are asserted against the LIVE deployment:
 *
 *   1. Query returns data — a minted admin session, IP-verified through the
 *      backend /admin/ip/verify action (so the binding is fresh), must get a
 *      real workload payload ({ openTickets, aiReview }), never an error.
 *      Then the binding is aged server-side (harness) and the SAME query must
 *      refuse with a CLEAN ConvexError — "Admin access requires device IP
 *      verification" in err.data — not a masked "Server Error". A masked
 *      error is exactly the crash class: it means someone reverted the
 *      ConvexError wrapping or the query's admin gate, and the app would
 *      crash on load again. Finally, re-verifying restores the data, proving
 *      the self-heal path the shell relies on.
 *
 *   2. Page stays up — a browser loads /admin with a freshly minted admin
 *      session (JWT seeded before boot, exactly like the INP harness). The
 *      shell must render the Admin page (device-verify screen or dashboard)
 *      with NO React Router "Unexpected Application Error!" page and NO
 *      app fallback ("Something went wrong"). This is the user-visible half
 *      of the regression: a crash in the shell's workload badge used to
 *      blank the entire app.
 *
 * Harness-gated (TEST_HARNESS_SECRET), like the admin-ip and phishing QAs.
 * Requires playwright (devDependency) for the browser half.
 *
 * Run:
 *   TEST_HARNESS_SECRET=<secret> npm run qa:admin-workload
 *
 * Overrides: CONVEX_URL (default the production deployment),
 * SITE_URL (default https://purewire.vercel.app).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing secret.
 */
import { chromium } from "playwright";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { assertAdminIpVerified } from "./lib/qa-admin-ip.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const SITE_URL = process.env.SITE_URL ?? "https://purewire.vercel.app";
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;

/**
 * Exit after letting undici's connection pool drain. On Windows, calling
 * process.exit() while a fetch keep-alive handle is mid-close can trip a
 * libuv assertion (UV_HANDLE_CLOSING); the short grace lets teardown
 * finish first. (No .unref(): the timer must fire so the exit code is
 * guaranteed, and 150ms is a negligible tail.)
 */
function exit(code) {
  setTimeout(() => process.exit(code), 150);
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u274c ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Call moderationWorkload; returns { data } on success or { error } on
 * failure. Reads err.data FIRST: Convex masks every error message at the
 * public HTTP boundary as "Server Error", but a ConvexError's real message
 * travels in err.data (see Auth.tsx authErrorMessage). A refusal that has
 * no usable err.data is the masked crash class — exactly what we guard.
 */
async function moderationWorkload(client) {
  try {
    const data = await client.query(api.admin.moderationWorkload);
    return { data };
  } catch (err) {
    if (err instanceof Error && "data" in err) {
      const data = err.data;
      if (typeof data === "string" && data.length > 0) {
        return { error: data };
      }
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Mint an admin session through the harness and set it on a fresh client. */
async function mintedAdmin() {
  const mint = new ConvexHttpClient(CONVEX_URL);
  const minted = await mint.mutation(api.testHarness.mintAdminSession, {
    secret: HARNESS_SECRET,
  });
  if (!minted?.token) {
    throw new Error("Harness did not mint an admin session.");
  }
  const client = new ConvexHttpClient(CONVEX_URL);
  client.setAuth(minted.token);
  // refreshToken is needed by the browser half: the auth client requires
  // BOTH the JWT and the refresh token in storage or it signs out on boot.
  return { client, token: minted.token, refreshToken: minted.refreshToken };
}

async function main() {
  console.log(`\nPureWire admin moderationWorkload crash-class QA — ${CONVEX_URL}\n`);

  if (!HARNESS_SECRET) {
    console.log(
      "Missing TEST_HARNESS_SECRET — set it (matching the deployment's env, with\n" +
        "TEST_HARNESS_ENABLED=1) to run this QA.",
    );
    exit(2);
    return;
  }

  // ── 1. Query returns data after a fresh IP verification ──────────────
  console.log("1. moderationWorkload returns data for a verified admin session\n");
  const { client, token } = await mintedAdmin();
  const verdict = await assertAdminIpVerified({ convexUrl: CONVEX_URL, token });
  check(
    "fresh session IP-verified (binding established)",
    verdict.established === true,
    JSON.stringify(verdict),
  );
  const ok1 = await moderationWorkload(client);
  check(
    "moderationWorkload returns data after verification",
    ok1.error === undefined &&
      typeof ok1.data?.openTickets === "number" &&
      typeof ok1.data?.aiReview === "number",
    ok1.error ?? JSON.stringify(ok1.data),
  );

  // ── 2. Stale binding → CLEAN ConvexError, never masked "Server Error" ─
  console.log("\n2. A stale binding refuses with a clean ConvexError (crash-class guard)\n");
  const expired = await client.mutation(api.testHarness.expireAdminIpBinding, {
    secret: HARNESS_SECRET,
  });
  check("harness aged the session's binding", expired.expired === true, JSON.stringify(expired));
  const stale = await moderationWorkload(client);
  check(
    "stale binding → admin power refused (backend-enforced)",
    stale.error !== undefined,
    stale.data !== undefined ? "unexpectedly returned data" : "",
  );
  check(
    "refusal is a CLEAN ConvexError (device-IP message in err.data)",
    stale.error !== undefined &&
      /Admin access requires device IP verification/i.test(stale.error) &&
      !/^Server Error$/.test(stale.error),
    stale.error ?? "no error",
  );
  check(
    "refusal is NOT the masked 'Server Error' crash class",
    stale.error !== undefined && stale.error !== "Server Error",
    stale.error ?? "no error",
  );

  // ── 3. Re-verification restores data (the shell's self-heal path) ─────
  console.log("\n3. Re-verification restores the workload data\n");
  const reestablished = await assertAdminIpVerified({ convexUrl: CONVEX_URL, token });
  check(
    "re-verify re-establishes the binding",
    reestablished.ok === true && reestablished.revoked !== true,
    JSON.stringify(reestablished),
  );
  const ok3 = await moderationWorkload(client);
  check(
    "moderationWorkload returns data after re-verification",
    ok3.error === undefined &&
      typeof ok3.data?.openTickets === "number" &&
      typeof ok3.data?.aiReview === "number",
    ok3.error ?? JSON.stringify(ok3.data),
  );

  // ── 4. Page stays up (browser, seeded admin session) ─────────────────
  console.log("\n4. /admin renders with the shell up (no router error page)\n");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    check(
      "playwright browsers installed (browser half runs)",
      false,
      String(err).slice(0, 140),
    );
    browser = null;
  }
  if (browser) {
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      // Seed a FRESH minted session before any page script runs. The app's
      // own useAdminIpVerify hook then performs the first verification from
      // THIS browser's IP — exactly like a real admin loading the app — and
      // the shell's workload badge query fires only once verified (the fix
      // this QA protects). Storage keys mirror @convex-dev/auth's
      // useNamespacedStorage: `__convexAuthJWT_<alphanumeric-url>` and
      // `__convexAuthRefreshToken_<alphanumeric-url>`. BOTH are required:
      // the auth client attempts a refresh on boot and signs out if the
      // refresh token is missing (the harness mints both — see
      // mintAdminSession). Only the token is used; mintedAdmin also returns
      // a client, which is intentionally discarded here (the browser does
      // its own verify).
      const fresh = await mintedAdmin();
      const ns = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");
      await page.addInitScript(
        (seed) => {
          try {
            localStorage.setItem(`__convexAuthJWT_${seed.ns}`, seed.token);
            localStorage.setItem(
              `__convexAuthRefreshToken_${seed.ns}`,
              seed.refreshToken,
            );
          } catch (_) {}
        },
        {
          token: fresh.token,
          refreshToken: fresh.refreshToken,
          ns,
        },
      );
      await page.goto(`${SITE_URL}/admin`, {
        waitUntil: "networkidle",
        timeout: 90000,
      });
      // Give the shell + IP-verify heartbeat + admin queries time to settle.
      await page.waitForTimeout(8000);

      const body = await page.evaluate(() => document.body.innerText);
      const url = page.url();
      check("app stayed on /admin (no redirect loop)", url.includes("/admin"), url);

      // The two crash surfaces: React Router's default error page (pre-fix)
      // and the app's own fallback screen.
      check(
        "no React Router 'Unexpected Application Error!' page",
        !body.includes("Unexpected Application Error!"),
        body.includes("Unexpected Application Error!") ? "router error page rendered" : "",
      );
      check(
        "no app fallback screen ('Something went wrong')",
        !body.includes("Something went wrong"),
        body.includes("Something went wrong") ? "fallback rendered" : "",
      );

      // The Admin surface actually rendered: either the device-verify screen
      // (first verify in flight) or the dashboard (fully verified). Either
      // proves the route + shell mounted instead of crashing.
      const adminSurface =
        body.includes("Confirm this device") ||
        body.includes("Verifying device") ||
        body.includes("Admin dashboard");
      check("Admin page surface rendered (verify screen or dashboard)", adminSurface, "");
      if (body.includes("Admin dashboard")) {
        console.log("  (note: dashboard reached — session fully verified)");
      } else if (body.includes("Confirm this device")) {
        // Verified state arrives asynchronously; the page is up regardless.
        console.log("  (note: device-verify screen shown — first verify still in flight)");
      }
    } finally {
      await browser.close();
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed${failures.length ? " — " + failures.join("; ") : ""}\n`,
  );
  exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nQA crashed: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
});
