import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

import { normalizeEmailIdentity } from "@/lib/format";

import { saltedEmailHash } from "./privacy";
import { computeRiskScore } from "./security";

import type { MutationCtx } from "./_generated/server";

import { EmailVerification, PasswordReset } from "./auth/email";

export const ADMIN_EMAIL = "monroedoses@gmail.com";

interface ProfileParams {
  email?: string | null;
  name?: string | null;
  username?: string | null;
}

/** Build a PureWire user profile from sign-in parameters. */
function buildProfile(params: ProfileParams) {
  // Identity is decided on the canonical email: Gmail/Outlook spell the
  // same inbox in many ways (dots, +tags), and one inbox gets one badge.
  const email = normalizeEmailIdentity(String(params.email ?? ""));
  const username =
    String(params.username ?? "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_]/g, "") || undefined;
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

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
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
        const typed = ctx as unknown as MutationCtx;
        if (user.emailHash === undefined) {
          // One inbox can only ever claim one verified badge: if another
          // account already owns this canonical identity, reject the signup.
          // (The auth callback ctx is typed with the library's generic data
          // model, so cast to the project's generated ctx for the email index.)
          const existing = await typed.db
            .query("users")
            .withIndex("email", (q) => q.eq("email", canonicalEmail))
            .first();
          if (existing !== null && existing._id !== userId) {
            throw new Error(
              "An account with this email already exists. One inbox gets one badge.",
            );
          }
        }
        // Always converge to the salted hash on every auth event: accounts
        // created before the salt was configured are re-salted here, so no
        // stored identifier is ever left unsalted once EMAIL_HASH_SALT is
        // set. The write is skipped when the value is already correct.
        const emailHash = await saltedEmailHash(canonicalEmail);
        if (user.emailHash !== emailHash) {
          await ctx.db.patch(userId, { emailHash });
        }
      }
      // The moment the one-time email code is redeemed, the account is
      // verified — attach the verified badge token right away. The auth
      // library sets emailVerificationTime, then calls this callback. Only
      // attach when the badge was never decided: this callback fires on
      // every auth-library update (each sign-in), so an explicit admin
      // decision (setVerified false) must never be silently undone.
      if (user.emailVerificationTime !== undefined && user.verified === undefined) {
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
    },
  },
});
