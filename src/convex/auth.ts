import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";

import { normalizeEmailIdentity } from "@/lib/format";

import { DISPOSABLE_EMAIL_DOMAINS } from "./emailDomainList";
import {
  disposableEmailDomain,
  disposableEmailReason,
} from "./emailGate";
import { currentEmailHashVersion, saltedEmailHash } from "./privacy";
import { computeRiskScore } from "./security";

import type { MutationCtx } from "./_generated/server";

import { EmailVerification, PasswordReset } from "./auth/email";

export const ADMIN_EMAIL = "monroedoses@gmail.com";

// Account-creation velocity ceiling: new accounts per rolling hour before
// the velocity layer flags signups for human review. 240/hour is ~4 per
// minute sustained — far beyond legitimate organic growth, far below what
// a bot farm needs to be useful.
export const SIGNUP_VELOCITY_LIMIT = 240;

interface ProfileParams {
  email?: string | null;
  name?: string | null;
  username?: string | null;
  // The auth library passes the full params object through; the flow lets
  // the gate reject at SIGNUP (and profile updates) without ever touching
  // a sign-in from an existing account whose domain got denylisted later
  // — that account is handled by the verification re-check instead.
  flow?: string;
}

/** Build a PureWire user profile from sign-in parameters. */
function buildProfile(params: ProfileParams) {
  // Identity is decided on the canonical email: Gmail/Outlook spell the
  // same inbox in many ways (dots, +tags), and one inbox gets one badge.
  const email = normalizeEmailIdentity(String(params.email ?? ""));
  // Disposable/temporary/forwarding domains are rejected BEFORE the
  // account is created — a throw here aborts the signup, and ConvexError's
  // payload surfaces verbatim in the Auth page error banner (never a bare
  // "Server Error"). Existing accounts that sign in later are untouched;
  // the afterUserCreatedOrUpdated re-check catches domains added to the
  // denylist after signup.
  if (params.flow === "signUp" || params.flow === "updateProfile") {
    const verdict = disposableEmailDomain(email, DISPOSABLE_EMAIL_DOMAINS);
    if (verdict !== null) {
      throw new ConvexError(disposableEmailReason(verdict));
    }
  }
  let username =
    String(params.username ?? "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_]/g, "") || undefined;
  // The qa_/pwtest prefixes are reserved for the QA harness's throwaway
  // accounts; a signup claiming one falls back to the email-derived name
  // (never thrown here — a raw throw inside the auth flow surfaces as an
  // opaque auth error, and updateProfile rejects the prefix explicitly).
  if (username !== undefined && /^(qa_|pwtest)/i.test(username)) {
    username = undefined;
  }
  const isAdmin = email === ADMIN_EMAIL;
  return {
    email,
    name: String(
      String(params.name ?? "").trim() || username || email.split("@")[0],
    ),
    ...(username !== undefined ? { username } : {}),
    ...(isAdmin
      ? { verified: true as const, role: "admin" as const }
      : { role: "user" as const }),
    followersCount: 0,
    followingCount: 0,
    postsCount: 0,
  };
}

/**
 * Session horizons. The permanent one is the default: sessions are meant to
 * last until the user signs out. The short one backs the "Keep me signed
 * in" toggle on the Auth page — a device without it gets a 30-day session
 * instead of the decade-long one. Shared by the `session` config below and
 * the `setSessionLifetime` mutation in account.ts.
 */
export const PERMANENT_SESSION_MS = 1000 * 60 * 60 * 24 * 365 * 10; // 10 years
// A shorter, deliberate session for devices where "keep me signed in" is
// off. Matches the auth library's own default before PureWire made
// sessions permanent, so the non-remembered experience is the familiar one.
export const SHORT_SESSION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  // Sessions are effectively permanent: the short-lived access JWT (1 hour
  // by default) is silently refreshed by the client, while the underlying
  // session and refresh token last a decade. Members are only signed out by
  // their own choice, by an admin removing the account, or by an explicit
  // server-side invalidation — never by a timeout. (The library defaults to
  // 30 days, which was logging people out automatically.) A user who turns
  // off "Keep me signed in" opts that session down to SHORT_SESSION_MS via
  // account.setSessionLifetime after sign-in.
  session: {
    totalDurationMs: PERMANENT_SESSION_MS,
    inactiveDurationMs: PERMANENT_SESSION_MS,
  },
  providers: [
    Password({
      profile(params) {
        return buildProfile(params);
      },
      // One-time codes verify the account (email verification on sign-up
      // and password resets). There are no guest or anonymous accounts on
      // PureWire — every account is created with a real email and must
      // verify it with a code.
      verify: EmailVerification,
      reset: PasswordReset,
    }),
  ],
  // Screen every new account against bot/farm signals and flag high-risk
  // signups for a human review in the admin Security tab. The admin email
  // is always trusted, and a status set by an admin (restricted/banned, or
  // an explicit approve) is never overwritten by the auto-scorer.
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, { userId }) {
      const user = await ctx.db.get(userId);
      if (user === null) {
        return;
      }
      // The auth callback ctx is typed with the library's generic data
      // model, which knows only the auth tables — the app's custom tables
      // (signupVelocity, and the email index on users) need the project's
      // generated ctx. Cast once here and use it for those queries.
      const typed = ctx as unknown as MutationCtx;
      // Privacy: the user record carries only a salted SHA-256 hash of the
      // email, never plain-text. Existing accounts get backfilled on their
      // next update through the auth library. The hash is computed from the
      // canonical identity so user@gmail.com, u.ser@gmail.com, and
      // user+spam1@gmail.com all resolve to one inbox — and one badge.
      const canonicalEmail = user.email !== undefined
        ? normalizeEmailIdentity(user.email)
        : undefined;
      // Backfill: converge pre-canonicalization rows to the canonical stored
      // address so the dedupe below can never be bypassed by an old account
      // holding a dot/plus variant.
      if (
        canonicalEmail !== undefined &&
        user.email !== undefined &&
        user.email !== canonicalEmail
      ) {
        await ctx.db.patch(userId, { email: canonicalEmail });
      }
      if (canonicalEmail !== undefined) {
        if (user.emailHash === undefined) {
          // One inbox can only ever claim one verified badge: if another
          // account already owns this canonical identity, reject the signup.
          const existing = await typed.db
            .query("users")
            .withIndex("email", (q) => q.eq("email", canonicalEmail))
            .first();
          if (existing !== null && existing._id !== userId) {
            // ConvexError so the message crosses the public HTTP boundary:
            // plain Errors are masked as "Server Error" by Convex and the
            // sign-up form would show a generic failure instead of the
            // real one-inbox-one-badge reason.
            throw new ConvexError(
              "An account with this email already exists. One inbox gets one badge.",
            );
          }
        }
        // Always converge to the salted hash on every auth event: accounts
        // created before the salt was configured — or under an older salt
        // version — are re-salted here, so no stored identifier is ever
        // left unsalted or stale once EMAIL_HASH_SALT / EMAIL_HASH_VERSION
        // is set. The write is skipped when both values are already correct.
        const emailHashVersion = currentEmailHashVersion();
        const emailHash = await saltedEmailHash(canonicalEmail, emailHashVersion);
        if (user.emailHash !== emailHash || user.emailHashVersion !== emailHashVersion) {
          await ctx.db.patch(userId, { emailHash, emailHashVersion });
        }
      }
      // The moment the one-time email code is redeemed, the account is
      // verified — attach the verified badge token right away. The auth
      // library sets emailVerificationTime, then calls this callback. Only
      // attach when the badge was never decided: this callback fires on
      // every auth-library update (each sign-in), so an explicit admin
      // decision (setVerified false) must never be silently undone.
      //
      // A denylisted domain is checked AGAIN at this exact moment: a domain
      // added to the list after signup must not slip through, because email
      // verification alone never proves an address is permanent. Such an
      // account is flagged for human review instead of being marked verified.
      if (user.emailVerificationTime !== undefined && user.verified === undefined) {
        const emailVerdict = disposableEmailDomain(
          user.email ?? "",
          DISPOSABLE_EMAIL_DOMAINS,
        );
        if (emailVerdict !== null) {
          await ctx.db.patch(userId, {
            disposableEmailDomain: true,
            accountStatus: "suspicious",
            riskReasons: ["disposable-email-domain"],
          });
          return;
        }
        await ctx.db.patch(userId, { verified: true });
      }
      if (user.role === "admin") {
        return;
      }
      if (user.accountStatus !== undefined) {
        // Already reviewed — the auto-scorer runs only on the first creation.
        // This guarantees an admin decision (approve, restrict, or ban) is
        // never overwritten by a later automatic score.
        return;
      }
      const verdict = computeRiskScore({
        email: user.email ?? "",
        username: user.username ?? "",
        name: user.name ?? "",
      });
      if (verdict.score > 0) {
        await ctx.db.patch(userId, {
          riskScore: verdict.score,
          riskReasons: verdict.reasons,
          accountStatus: verdict.score >= 60 ? "suspicious" : "active",
        });
      }
      // Account-creation velocity: a rolling hourly bucket counter, one row
      // per hour. A bot farm signing up en masse trips it; legitimate growth
      // never approaches the ceiling. A breached account is flagged for
      // human review rather than rejected outright — rejecting a real user
      // is worse than reviewing one. Runs only when this callback is the
      // fresh-creation one (the account was just made), and only when the
      // account isn't already under review.
      if (
        Date.now() - user._creationTime < 5 * 60_000 &&
        user.accountStatus === undefined
      ) {
        const bucket = Math.floor(Date.now() / 3600_000);
        const velocityRow = await typed.db
          .query("signupVelocity")
          .withIndex("by_bucket", (q) => q.eq("bucket", bucket))
          .first();
        const count = (velocityRow?.count ?? 0) + 1;
        if (velocityRow !== null) {
          await typed.db.patch(velocityRow._id, { count });
        } else {
          await typed.db.insert("signupVelocity", { bucket, count });
        }
        if (count > SIGNUP_VELOCITY_LIMIT) {
          await ctx.db.patch(userId, { accountStatus: "suspicious" });
        }
      }
    },
  },
});
