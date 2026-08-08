#!/usr/bin/env node
/**
 * PureWire backend-verified admin IP QA check.
 *
 * Proves the admin device gate (src/convex/adminIp.ts) end to end against a
 * real deployment:
 *
 *   1. Happy path — a fresh admin password sign-in, verified through the
 *      /admin/ip/verify HTTP action, binds the session to the IP the
 *      backend actually OBSERVED (cf-connecting-ip / x-forwarded-for —
 *      never a client claim). The session then has admin power, and a
 *      second verify from the same network refreshes instead of revoking.
 *   2. Enforcement — the binding isn't a client-side nicety: age the
 *      binding server-side (harness) and requireAdmin must refuse the
 *      admin-gated query even though the JWT is valid. Proves the refusal
 *      is backend-enforced, not UI gating.
 *   3. Revocation — simulate the admin's IP changing (harness), then the
 *      next verify must report revoked and delete the session; the
 *      previously-working admin JWT must be powerless afterwards.
 *
 * Steps 2–3 need the QA harness (TEST_HARNESS_ENABLED=1 +
 * TEST_HARNESS_SECRET on the deployment), like the shadowban check. Without
 * it the script runs step 1 and skips 2–3 with a clear notice.
 *
 * Run (the password never lives in this file — see lib/qa-secrets.mjs):
 *
 *   ADMIN_PASSWORD=<admin password> npm run qa:admin-ip
 *   # or: printf '%s' '<admin password>' > .freebuff/.admin-password
 *   #     (gitignored) then: npm run qa:admin-ip
 *
 * To also run the enforcement + revocation QA:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> npm run qa:admin-ip
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Overrides: CONVEX_URL (default: the production deployment),
 * ADMIN_EMAIL (default monroedoses@gmail.com), TEST_HARNESS_SECRET.
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing password.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";
import { assertAdminIpVerified, verifyAdminIp } from "./lib/qa-admin-ip.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_PASSWORD = resolveAdminPassword();
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET;

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

async function signInAsAdmin() {
  const client = new ConvexHttpClient(CONVEX_URL);
  const res = await client.action("auth:signIn", {
    provider: "password",
    params: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      flow: "signIn",
    },
  });
  if (!res?.tokens?.token) {
    throw new Error("auth:signIn returned no session token.");
  }
  client.setAuth(res.tokens.token);
  return { client, token: res.tokens.token };
}

/** Call dashboardStats; returns the error message, or "" when it succeeded. */
async function adminQueryError(client) {
  try {
    await client.query(api.admin.dashboardStats);
    return "";
  } catch (err) {
    // Convex masks EVERY error message at the public HTTP boundary — even a
    // ConvexError's `.message` arrives as "Server Error", with the real
    // payload in `err.data` (see Auth.tsx authErrorMessage, which reads
    // `.data` first for exactly this reason). Prefer the payload so the
    // enforcement checks assert on the REAL refusal reason.
    if (err instanceof Error && "data" in err) {
      const data = err.data;
      if (typeof data === "string" && data.length > 0) {
        return data;
      }
    }
    return err instanceof Error ? err.message : String(err);
  }
}

async function main() {
  console.log(`\nPureWire backend-verified admin IP QA — ${CONVEX_URL}\n`);

  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
    process.exit(2);
  }

  // ── 1. Happy path: verify binds the observed IP, admin power works ──
  console.log("1. Happy path — verify binds the observed IP\n");
  const { client, token } = await signInAsAdmin();
  const verdict = await assertAdminIpVerified({ convexUrl: CONVEX_URL, token });
  check(
    "first verification establishes a binding",
    verdict.established === true,
    JSON.stringify(verdict),
  );
  const err1 = await adminQueryError(client);
  check("admin-gated query succeeds after verification", err1 === "", err1);

  const again = await assertAdminIpVerified({ convexUrl: CONVEX_URL, token });
  check(
    "second verification from the same network refreshes (not revoked)",
    again.revoked === false,
    JSON.stringify(again),
  );

  // ── 2 + 3. Enforcement + revocation (harness-gated) ──
  console.log("\n2. Enforcement — a stale binding is refused by the backend");
  console.log("3. Revocation — an IP change kills the session\n");
  if (!HARNESS_SECRET) {
    console.log(
      "  Skipping — set TEST_HARNESS_SECRET (and TEST_HARNESS_ENABLED=1 on the\n  deployment) to run the enforcement + revocation QA.",
    );
  } else {
    const minted = await client.mutation(api.testHarness.mintAdminSession, {
      secret: HARNESS_SECRET,
    });
    check("harness minted an admin session", !!minted?.token);
    const mintedClient = new ConvexHttpClient(CONVEX_URL);
    mintedClient.setAuth(minted.token);
    const first = await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: minted.token });
    check(
      "minted session verified (binding established)",
      first.ok === true,
      JSON.stringify(first),
    );
    const errBefore = await adminQueryError(mintedClient);
    check("minted session has admin power before expiry", errBefore === "", errBefore);

    // Age the binding server-side: requireAdmin must now refuse even with
    // a valid JWT — enforcement is backend-enforced, not UI gating. Runs as
    // the MINTED session (the harness ages the caller's own binding).
    const expired = await mintedClient.mutation(api.testHarness.expireAdminIpBinding, {
      secret: HARNESS_SECRET,
    });
    check("harness aged the session's binding", expired.expired === true, JSON.stringify(expired));
    const errStale = await adminQueryError(mintedClient);
    check(
      "stale binding → admin power refused (backend-enforced)",
      /IP verification|requires device/i.test(errStale),
      errStale || "unexpectedly succeeded",
    );

    // Re-verify (same network) → binding re-established → power returns.
    const reestablished = await assertAdminIpVerified({ convexUrl: CONVEX_URL, token: minted.token });
    check(
      "re-verify re-establishes the binding",
      reestablished.ok === true && reestablished.revoked !== true,
      JSON.stringify(reestablished),
    );
    const errRestored = await adminQueryError(mintedClient);
    check("admin power returns after re-verification", errRestored === "", errRestored);

    // Simulate the IP changing server-side, then verify from the real
    // client IP — the stored hash no longer matches, so the backend must
    // revoke the session outright. Runs as the minted session too.
    const tampered = await mintedClient.mutation(api.testHarness.simulateAdminIpChange, {
      secret: HARNESS_SECRET,
    });
    check(
      "harness tampered with the session's IP binding",
      tampered.tampered === true,
      JSON.stringify(tampered),
    );
    const afterChange = await verifyAdminIp({ convexUrl: CONVEX_URL, token: minted.token });
    check(
      "verify reports REVOKED after an IP change",
      afterChange.ok === true && afterChange.revoked === true,
      JSON.stringify(afterChange),
    );
    const errAfter = await adminQueryError(mintedClient);
    check(
      "admin power is gone after the revocation",
      /IP verification|requires device|Not authenticated/i.test(errAfter),
      errAfter || "unexpectedly still has power",
    );
    // Revocation must be STICKY: the JWT may still decode (stateless), but
    // re-verifying after the session row was deleted must NOT re-establish
    // a binding — the endpoint reports revoked again, so a JWT-only thief
    // can never revive the dead session.
    const reVerify = await verifyAdminIp({ convexUrl: CONVEX_URL, token: minted.token });
    check(
      "re-verifying a revoked session stays revoked (sticky revocation)",
      reVerify.ok === true && reVerify.revoked === true,
      JSON.stringify(reVerify),
    );
    const errReVerify = await adminQueryError(mintedClient);
    check(
      "admin power does not return after re-verification",
      /IP verification|requires device|Not authenticated/i.test(errReVerify),
      errReVerify || "unexpectedly regained power",
    );
  }

  console.log(
    `\n${passed} passed, ${failed} failed${failures.length ? " — " + failures.join("; ") : ""}\n`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nQA crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
