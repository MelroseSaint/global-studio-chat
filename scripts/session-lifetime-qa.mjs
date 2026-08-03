#!/usr/bin/env node
/**
 * PureWire "Keep me signed in" session-lifetime QA.
 *
 * Verifies both paths of the toggle against a real deployment. It signs in
 * as the admin through the real password flow (the same path the browser
 * uses), applies each preference with `account.setSessionLifetime`, and
 * reads the actual authSessions row back through the harness-gated
 * `testHarness.getCurrentSessionLifetime` to prove the write landed — not
 * just that the mutation returned a number.
 *
 *   remember=true  → session expirationTime ≈ now + 10 years (permanent)
 *   remember=false → session expirationTime ≈ now + 30 days  (short)
 *
 * The read-back needs the QA harness enabled on the deployment, so to run:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> ADMIN_PASSWORD=<admin password> npm run qa:session-lifetime
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * The password never lives in this file — see lib/qa-secrets.mjs
 * (ADMIN_PASSWORD env or .freebuff/.admin-password).
 *
 * Overrides: CONVEX_URL (default: the production deployment), ADMIN_EMAIL.
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing inputs.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;

// Mirrors convex/auth.ts. 10 years is the permanent platform default; 30
// days is the opted-down "don't keep me signed in" session.
const PERMANENT_MS = 1000 * 60 * 60 * 24 * 365 * 10;
const SHORT_MS = 1000 * 60 * 60 * 24 * 30;
// Tolerances: allow a few minutes of clock drift between this script and
// the deployment, and a little slack on the 10-year figure.
const TOLERANCE_MS = 10 * 60 * 1000; // 10 minutes

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

/** Is the given expirationTime within tolerance of now + horizon? */
function withinHorizon(expirationTime, horizon) {
  const expected = Date.now() + horizon;
  return Math.abs(expirationTime - expected) < TOLERANCE_MS;
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }
  if (!HARNESS_SECRET) {
    console.log(
      "TEST_HARNESS_SECRET is not set. The read-back needs the QA harness;",
    );
    console.log("set TEST_HARNESS_ENABLED=1 + TEST_HARNESS_SECRET on the");
    console.log("deployment, then re-run, then remove both env vars.");
    process.exit(2);
  }
  console.log(`\nPureWire session-lifetime QA (${CONVEX_URL})\n`);

  const { enabled } = await new ConvexHttpClient(CONVEX_URL).query(
    api.testHarness.isEnabled,
  );
  if (!enabled) {
    console.log("The QA harness is disabled on this deployment. Enable it:");
    console.log("  npx convex env set TEST_HARNESS_ENABLED 1");
    console.log("  npx convex env set TEST_HARNESS_SECRET <random>");
    console.log("Then re-run this script, and remove both env vars afterwards.");
    process.exit(2);
  }

  // Sign in as admin through the real password flow — a fresh client with
  // no token, exactly like a clean browser.
  const client = new ConvexHttpClient(CONVEX_URL);
  let signInError = "";
  let tokens = null;
  try {
    const result = await client.action("auth:signIn", {
      provider: "password",
      params: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, flow: "signIn" },
    });
    if (result?.tokens) {
      tokens = result.tokens;
    } else {
      signInError = `unexpected signIn result: ${JSON.stringify(result)}`;
    }
  } catch (err) {
    signInError = err instanceof Error ? err.message : String(err);
  }
  check("password sign-in from a fresh client succeeded", tokens !== null, signInError);
  if (tokens === null) {
    return finish();
  }
  client.setAuth(tokens.token);

  const readBack = () =>
    client.query(api.testHarness.getCurrentSessionLifetime, {
      secret: HARNESS_SECRET,
    });

  try {
    // ── Path 1: "Keep me signed in" OFF → 30-day session ────────────────
    const shortRes = await client.mutation(api.account.setSessionLifetime, {
      remember: false,
    });
    check(
      "remember=false returned a ~30-day horizon",
      withinHorizon(shortRes.expirationTime, SHORT_MS),
      `expirationTime ${shortRes.expirationTime}`,
    );
    const shortRow = await readBack();
    check(
      "authSessions row is capped at ~30 days",
      shortRow !== null && withinHorizon(shortRow.expirationTime, SHORT_MS),
      shortRow ? `remaining ${shortRow.remainingMs}ms` : "no session row",
    );

    // ── Path 2: "Keep me signed in" ON → permanent 10-year session ──────
    const longRes = await client.mutation(api.account.setSessionLifetime, {
      remember: true,
    });
    check(
      "remember=true returned a ~10-year horizon",
      withinHorizon(longRes.expirationTime, PERMANENT_MS),
      `expirationTime ${longRes.expirationTime}`,
    );
    const longRow = await readBack();
    check(
      "authSessions row is extended to ~10 years",
      longRow !== null && withinHorizon(longRow.expirationTime, PERMANENT_MS),
      longRow ? `remaining ${longRow.remainingMs}ms` : "no session row",
    );
    check(
      "permanent horizon is much longer than the short one",
      (longRow?.expirationTime ?? 0) - (shortRow?.expirationTime ?? 0) >
        SHORT_MS,
    );
  } finally {
    // Leave no trace: sign out and clear the token.
    try {
      await client.action("auth:signOut");
    } catch {
      // Already signed out is fine.
    }
    client.clearAuth();
  }

  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nSession-lifetime QA crashed:", e);
  process.exit(1);
});
