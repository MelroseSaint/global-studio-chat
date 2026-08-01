import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

import { sha256Hex } from "./privacy";
import { computeRiskScore } from "./security";

import { EmailVerification, PasswordReset } from "./auth/email";

export const ADMIN_EMAIL = "monreodoses@gmail.com";

interface ProfileParams {
  email?: string | null;
  name?: string | null;
  username?: string | null;
}

/** Build a PureWire user profile from sign-in parameters. */
function buildProfile(params: ProfileParams) {
  const email = String(params.email ?? "").toLowerCase().trim();
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
      // Privacy: the user record carries only a SHA-256 hash of the email,
      // never plain-text. Existing accounts get backfilled on their next
      // update through the auth library.
      if (user.email !== undefined && user.emailHash === undefined) {
        await ctx.db.patch(userId, { emailHash: await sha256Hex(user.email) });
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
