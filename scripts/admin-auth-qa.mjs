#!/usr/bin/env node
/**
 * PureWire production admin auth-path QA check.
 *
 * Drives the REAL password sign-in flow against the production deployment —
 * the exact path the stale-token bug broke. A fresh HTTP client (no token
 * attached, exactly like a clean browser after the self-healing fix) calls
 * `auth:signIn` with the admin credentials, the returned session must
 * resolve `users.getCurrentUser` to the admin account, then `auth:signOut`
 * must invalidate the session server-side and the token must be cleared so
 * `getCurrentUser` returns null again. A negative check then confirms a
 * deliberately wrong password is still rejected — no tokens minted and a
 * clear failure signal — so credential validation can't silently regress.
 *
 * Why a fresh client matters: the bug was a dead JWT left in storage being
 * attached to every `auth:signIn` call, so the server rejected each attempt
 * with "Invalid token". A fresh client proves the clean path works end to
 * end. Server-side, the session is stateless (the JWT is decoded, not
 * looked up), so the honest sign-out proof is that the refresh token no
 * longer mints a session — `{ tokens: null }` — plus the client clearing
 * the token and `getCurrentUser` going null.
 *
 * Run (the password comes from the environment, never from this file):
 *
 *   ADMIN_PASSWORD=<admin password> npm run qa:admin-auth
 *
 * Overrides: CONVEX_URL (default: the production deployment), ADMIN_EMAIL
 * (default monroedoses@gmail.com), ADMIN_USERNAME (default adminmelrose).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing password.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "adminmelrose";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

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

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log("ADMIN_PASSWORD is not set. Run with:");
    console.log("  ADMIN_PASSWORD=<admin password> npm run qa:admin-auth");
    process.exit(2);
  }
  console.log(`\nPureWire production admin auth-path QA (${CONVEX_URL})\n`);
  const client = new ConvexHttpClient(CONVEX_URL);

  // 1. Sign in from a FRESH client — no token attached. This is the call
  //    the stale-token bug poisoned: a dead JWT in storage was attached
  //    here, and the server rejected every attempt with "Invalid token".
  let tokens = null;
  let signInError = "";
  try {
    const result = await client.action("auth:signIn", {
      provider: "password",
      params: {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        flow: "signIn",
      },
    });
    if (result?.tokens) {
      tokens = result.tokens;
    } else if (result?.started) {
      signInError = "server asked for a verification code step";
    } else {
      signInError = `unexpected signIn result: ${JSON.stringify(result)}`;
    }
  } catch (err) {
    signInError = err instanceof Error ? err.message : String(err);
  }
  check("password sign-in from a fresh client succeeded", tokens !== null, signInError);
  if (tokens === null) {
    console.log("\nIf this fails with 'Invalid token', a stale session is still");
    console.log("attached somewhere — open the site, load /auth, and let the");
    console.log("self-healing cleanup run before retrying.\n");
    console.log("Note: the wrong-password negative check is skipped because the");
    console.log("happy-path sign-in did not succeed.\n");
    client.clearAuth();
    return finish();
  }

  const { token, refreshToken } = tokens;
  check("sign-in returned a JWT", typeof token === "string" && token.split(".").length === 3);
  check("sign-in returned a refresh token", typeof refreshToken === "string" && refreshToken.length > 0);

  // 2. Attach the session and resolve the current user.
  client.setAuth(token);
  let me = null;
  try {
    me = await client.query(api.users.getCurrentUser);
  } catch (err) {
    check("session resolves getCurrentUser", false, err instanceof Error ? err.message : String(err));
    client.clearAuth();
    return finish();
  }
  check("session resolves getCurrentUser", me !== null);
  if (me !== null) {
    check("role is admin", me.role === "admin", String(me.role));
    check(`username is ${ADMIN_USERNAME}`, me.username === ADMIN_USERNAME, String(me.username));
    check("account is verified", me.verified === true, String(me.verified));
    check(
      "no plaintext email leaves the server",
      !("email" in me),
    );
    check(
      "masked email is present",
      typeof me.maskedEmail === "string" && me.maskedEmail.includes("\u2022\u2022\u2022\u2022"),
      String(me.maskedEmail),
    );
  }

  // 3. Sign out with the session attached — deletes the session server-side.
  let signedOut = true;
  try {
    await client.action("auth:signOut");
  } catch (err) {
    signedOut = false;
    check("auth:signOut completed", false, err instanceof Error ? err.message : String(err));
  }
  if (signedOut) {
    check("auth:signOut completed", true);
  }

  // 4. Server-side proof the session is gone: the old refresh token must no
  //    longer mint a session. The stateless JWT itself stays decodable until
  //    expiry, so the refresh-token rejection is the real signal. The token
  //    is cleared first to mirror the react client, which makes the refresh
  //    call unauthenticated.
  client.clearAuth();
  let refreshRejected = false;
  try {
    const refreshResult = await client.action("auth:signIn", {
      refreshToken,
    });
    refreshRejected = refreshResult?.tokens === null;
  } catch {
    // A thrown error also counts as the session being invalidated.
    refreshRejected = true;
  }
  check("refresh token rejected after sign-out", refreshRejected);

  // 5. Confirm the session is anonymous with no token attached.
  let anon = null;
  try {
    anon = await client.query(api.users.getCurrentUser);
  } catch {
    // A query error without a token also proves nothing resolves.
  }
  check("getCurrentUser is null after clearing the token", anon === null);

  // 6. Negative check: a deliberately wrong password must be rejected —
  //    no tokens minted and a clear failure signal. This proves credential
  //    validation still refuses bad logins while the happy path works. A
  //    single attempt is intentional: repeated failures could trip the
  //    platform's rate-limit/abuse guards on the admin account.
  const badClient = new ConvexHttpClient(CONVEX_URL);
  let badResult = null;
  let badError = "";
  try {
    badResult = await badClient.action("auth:signIn", {
      provider: "password",
      params: {
        email: ADMIN_EMAIL,
        password: `definitely-wrong-${Date.now()}`,
        flow: "signIn",
      },
    });
  } catch (err) {
    badError = err instanceof Error ? err.message : String(err);
  }
  const badTokens = badResult?.tokens ?? null;
  check(
    "wrong-password sign-in returned no tokens",
    badTokens === null,
    badResult ? JSON.stringify(badResult) : "",
  );
  check(
    "wrong-password sign-in was rejected cleanly",
    badError.length > 0 || badTokens === null,
    badError,
  );
  check(
    "rejection surfaced an error (no 'Invalid token' leak)",
    badError.length > 0 && !/invalid token/i.test(badError),
    badError || "(no error message surfaced)",
  );

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
  console.error("\nAdmin auth QA crashed:", e);
  process.exit(1);
});
