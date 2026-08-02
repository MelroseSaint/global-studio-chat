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
 * A final remove-account erasure QA (only when TEST_HARNESS_SECRET is set,
 * the same harness the shadowban/pipeline checks use) creates a throwaway
 * account, gives it real data — a post with an uploaded media file and a
 * follow — removes it as the admin, and asserts the full erasure: zero
 * rows in every table the sweep touches (posts, follows, auth sessions,
 * tokens, notifications, …), the uploaded file is deleted from storage,
 * the private removal log kept its one-way identity record, and the
 * profile 404s. It also proves the admin's follower count is recomputed
 * after the removed account's follow is swept.
 *
 * Why a fresh client matters: the bug was a dead JWT left in storage being
 * attached to every `auth:signIn` call, so the server rejected each attempt
 * with "Invalid token". A fresh client proves the clean path works end to
 * end. Server-side, the session is stateless (the JWT is decoded, not
 * looked up), so the honest sign-out proof is that the refresh token no
 * longer mints a session — `{ tokens: null }` — plus the client clearing
 * the token and `getCurrentUser` going null.
 *
 * Run (the password never lives in this file — see lib/qa-secrets.mjs):
 *
 *   ADMIN_PASSWORD=<admin password> npm run qa:admin-auth
 *   # or, to keep the secret out of shell history and chat entirely:
 *   printf '%s' '<admin password>' > .freebuff/.admin-password   # gitignored
 *   npm run qa:admin-auth
 *
 * To also run the remove-account erasure QA, enable the harness on the
 * deployment and pass its secret:
 *
 *   npx convex env set TEST_HARNESS_ENABLED 1
 *   npx convex env set TEST_HARNESS_SECRET <random>
 *   TEST_HARNESS_SECRET=<random> npm run qa:admin-auth
 *   npx convex env remove TEST_HARNESS_ENABLED
 *   npx convex env remove TEST_HARNESS_SECRET
 *
 * Overrides: CONVEX_URL (default: the production deployment), ADMIN_EMAIL
 * (default monroedoses@gmail.com), ADMIN_USERNAME (default adminmelrose),
 * TEST_HARNESS_SECRET (enables the remove-account erasure QA).
 * Exit codes: 0 all checks passed, 1 a check failed, 2 missing password.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";
import { passwordHint, resolveAdminPassword } from "./lib/qa-secrets.mjs";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "monroedoses@gmail.com";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "adminmelrose";
const ADMIN_PASSWORD = resolveAdminPassword();
// Optional: enables the remove-account erasure QA (the harness mints
// throwaway sessions without needing an email OTP).
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny valid 1×1 PNG so the upload pipeline has real bytes to chew on.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Upload a small image exactly like the app: `prepareUpload` for the ticket,
 * then POST to whatever mode it returned. In Cloudinary mode a failed
 * upload (missing/renamed unsigned preset, quota, restricted key) falls
 * back to the ticket's Convex `fallbackUrl`, mirroring MediaUpload.tsx, so
 * the QA proves the erasure of whichever bytes actually got stored.
 * Returns the media item shape a post expects, plus where it landed.
 */
async function uploadMedia(client) {
  const ticket = await client.action(api.media.prepareUpload, {
    contentType: "image/png",
  });
  if (ticket.mode === "convex") {
    const res = await fetch(ticket.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Blob([PNG_1PX], { type: "image/png" }),
    });
    const data = await res.json();
    return { storageId: data.storageId, mode: "convex" };
  }
  const form = new FormData();
  form.append("file", new Blob([PNG_1PX], { type: "image/png" }), "qa.png");
  form.append("upload_preset", ticket.uploadPreset);
  const res = await fetch(ticket.uploadUrl, { method: "POST", body: form });
  if (res.ok) {
    const data = await res.json();
    return { url: data.secure_url, key: data.public_id, mode: "cloudinary" };
  }
  const fb = await fetch(ticket.fallbackUrl, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: new Blob([PNG_1PX], { type: "image/png" }),
  });
  const data = await fb.json();
  return { storageId: data.storageId, mode: "convex-fallback" };
}

/**
 * 7. Remove-account erasure QA (harness-gated). Creates a throwaway,
 * gives it a post with an uploaded file and a follow, removes it as the
 * admin, then asserts the full erasure: zero rows in every table the sweep
 * touches, the media file deleted, the removal log kept its one-way record,
 * the profile 404s, and the admin's follower count is recomputed.
 */
async function removeAccountChecks() {
  console.log("\n7. Remove-account erasure QA");
  // A dedicated client for the harness + public queries — the main `client`
  // lives inside main() and was already signed out and cleared.
  const client = new ConvexHttpClient(CONVEX_URL);
  const { enabled } = await client.query(api.testHarness.isEnabled);
  if (!enabled) {
    console.log("  (skip) the QA harness is disabled on this deployment — enable it");
    console.log("  with TEST_HARNESS_ENABLED=1 + TEST_HARNESS_SECRET to run this step.");
    return;
  }
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const username = `qa_rm_${stamp}`;
  const created = await client.mutation(api.testHarness.createTestUser, {
    name: "QA Remove",
    username,
    secret: HARNESS_SECRET,
  });
  check("created a throwaway account for removal", !!(created && created.token));
  if (!created?.userId) return;

  let storageId = null;
  // The Cloudinary secure_url when the upload landed there (convex mode
  // has no URL — it probes the storage file instead).
  let mediaUrl = null;
  let removed = false;
  try {
    // Give the account real data: a post with an uploaded file, and a follow.
    const userClient = new ConvexHttpClient(CONVEX_URL);
    userClient.setAuth(created.token);
    const media = await uploadMedia(userClient);
    storageId = media.storageId ?? null;
    mediaUrl = media.url ?? null;
    check(
      "throwaway uploaded a media file",
      typeof storageId === "string" || typeof mediaUrl === "string",
      `mode: ${media.mode}`,
    );
    // Only attach media if the upload actually landed somewhere — `media` is
    // optional on createPost, and a bogus `{ url: null }` item would fail
    // schema validation and crash the QA instead of failing the check.
    const mediaItem = storageId
      ? [{ storageId, kind: "image", stripped: true }]
      : typeof mediaUrl === "string"
        ? [{ url: mediaUrl, key: media.key, kind: "image", stripped: true }]
        : undefined;
    const postRes = await userClient.mutation(api.posts.createPost, {
      content: `Remove-account QA post ${stamp} — original text written by a human.`,
      ...(mediaItem ? { media: mediaItem } : {}),
      aiMediaStatus: "clean",
    });
    check(
      "throwaway posted with media",
      postRes.ok === true,
      postRes.ok ? "" : String(postRes.error),
    );
    // Capture the admin's follower baseline BEFORE the follow, so after the
    // removal the recomputed count must equal the true pre-follow state.
    const adminFollowersBefore =
      (await client.query(api.users.getProfile, {
        username: ADMIN_USERNAME,
      }))?.followersCount ?? 0;
    await userClient.mutation(api.users.follow, { username: ADMIN_USERNAME });

    // Sanity: the traces exist before the removal.
    const before = await client.query(api.testHarness.getTestUserTraces, {
      userId: created.userId,
      secret: HARNESS_SECRET,
      storageIds: storageId ? [storageId] : [],
    });
    check("pre-removal: post row exists", before.counts.posts === 1);
    check("pre-removal: follow row exists", before.counts.follows === 1);
    check("pre-removal: auth session exists", before.counts.authSessions === 1);
    if (storageId) {
      check("pre-removal: media file exists", before.storage[0]?.exists === true);
    }

    // Remove the account as the admin (fresh sign-in — the session from
    // step 1 was already signed out).
    const adminClient = new ConvexHttpClient(CONVEX_URL);
    const adminRes = await adminClient.action("auth:signIn", {
      provider: "password",
      params: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, flow: "signIn" },
    });
    adminClient.setAuth(adminRes.tokens.token);
    await adminClient.mutation(api.admin.removeAccount, {
      userId: created.userId,
      standardId: "no-spam",
      note: "Remove-account QA verification",
    });
    removed = true;
    check("admin removeAccount completed", true);

    // The erasure must be total — zero rows in every table the sweep
    // touches, the uploaded file deleted, and the profile gone.
    const after = await client.query(api.testHarness.getTestUserTraces, {
      userId: created.userId,
      secret: HARNESS_SECRET,
      storageIds: storageId ? [storageId] : [],
    });
    check("user row is gone", after.userExists === false);
    check("zero posts remain", after.counts.posts === 0);
    check(
      "zero comments/likes/shares remain",
      after.counts.comments === 0 &&
        after.counts.likes === 0 &&
        after.counts.shares === 0,
    );
    check("zero follows remain", after.counts.follows === 0);
    check("zero auth sessions remain", after.counts.authSessions === 0);
    check("zero auth accounts remain", after.counts.authAccounts === 0);
    check(
      "zero auth tokens/codes/verifiers remain",
      after.counts.authRefreshTokens === 0 &&
        after.counts.authVerificationCodes === 0 &&
        after.counts.authVerifiers === 0,
    );
    check(
      "zero notifications/tickets/blocks remain",
      after.counts.notifications === 0 &&
        after.counts.supportTickets === 0 &&
        after.counts.blocks === 0,
    );
    check(
      "zero rate-limit/flag/moderation rows remain",
      after.counts.rateLimits === 0 &&
        after.counts.silentFlagEvents === 0 &&
        after.counts.moderationLog === 0,
    );
    check("zero stories remain", after.counts.stories === 0);
    if (storageId) {
      check(
        "uploaded media file is deleted from storage",
        after.storage[0]?.exists === false,
      );
    } else if (typeof mediaUrl === "string") {
      // Cloudinary mode: the removal schedules a signed destroy with
      // invalidate=true, which purges the CDN edge — poll the stored URL
      // until it 404s, the same way signup-e2e-prod.mjs does.
      const deadline = Date.now() + 30_000;
      let status = 0;
      let gone = false;
      while (Date.now() < deadline) {
        status = await fetch(mediaUrl, { method: "GET" })
          .then((r) => r.status)
          .catch(() => 0);
        if (status === 404) {
          gone = true;
          break;
        }
        await sleep(2000);
      }
      check(
        "cloudinary media gone after removal (URL 404)",
        gone,
        gone ? "" : `still HTTP ${status} after 30s`,
      );
    }
    check(
      "removal log kept the one-way record",
      after.removalLog !== null &&
        after.removalLog.username === username &&
        after.removalLog.standardId === "no-spam",
    );
    check(
      "profile 404s after removal",
      (await client.query(api.users.getProfile, { username })) === null,
    );
    const adminFollowersAfter =
      (await client.query(api.users.getProfile, {
        username: ADMIN_USERNAME,
      }))?.followersCount ?? 0;
    check(
      "admin follower count restored after removal",
      adminFollowersAfter === adminFollowersBefore,
      `before ${adminFollowersBefore}, after ${adminFollowersAfter}`,
    );

    // The removed account's old session must resolve nothing.
    const ghost = new ConvexHttpClient(CONVEX_URL);
    ghost.setAuth(created.token);
    check(
      "removed account's old session resolves nothing",
      (await ghost.query(api.users.getCurrentUser)) === null,
    );
  } finally {
    // If the removal never ran, sweep the throwaway so no QA data lingers.
    if (!removed && created?.userId) {
      try {
        await client.mutation(api.testHarness.deleteTestUser, {
          userId: created.userId,
          secret: HARNESS_SECRET,
        });
      } catch {
        // Best-effort sweep.
      }
    }
  }
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.log(passwordHint());
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

  // 7. Remove-account erasure QA — harness-gated (see removeAccountChecks).
  if (HARNESS_SECRET) {
    await removeAccountChecks();
  } else {
    console.log("\n7. Remove-account erasure QA — skipped (set TEST_HARNESS_SECRET to enable).");
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
  console.error("\nAdmin auth QA crashed:", e);
  process.exit(1);
});
