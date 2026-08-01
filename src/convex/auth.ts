import { convexAuth } from "@convex-dev/auth/server";
import { Email } from "@convex-dev/auth/providers/Email";
import { Password } from "@convex-dev/auth/providers/Password";

import {
  EmailVerification,
  PasswordReset,
  generateSixDigitToken,
  sendCodeEmail,
} from "./auth/email";

const ADMIN_EMAIL = "monreodoses@gmail.com";

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
      verify: EmailVerification,
      reset: PasswordReset,
    }),
    // Password-less sign-in: request a code by email, then enter it to
    // verify. No guest or anonymous accounts on PureWire — the code is
    // delivered to a real inbox, so every account is email-verified.
    Email({
      id: "emailCode",
      maxAge: 10 * 60, // 10 minutes
      generateVerificationToken: generateSixDigitToken,
      sendVerificationRequest: ({ identifier, token }) =>
        sendCodeEmail(identifier, "Your PureWire sign-in code", token),
    }),
  ],
  // The Email provider has no profile hook in this auth version, so
  // email-code sign-ins create users with only an email address. Give them
  // a username derived from the email and sensible defaults — it can be
  // changed any time in Settings. Password accounts already arrive fully
  // formed from their profile callback, so they're left untouched.
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, { userId }) {
      const user = await ctx.db.get(userId);
      if (user === null || user.username) {
        return;
      }
      const email = String(user.email ?? "").toLowerCase().trim();
      const local = email
        .split("@")[0]
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 24);
      const username = local || "member";
      const isAdmin = email === ADMIN_EMAIL;
      await ctx.db.patch(userId, {
        username,
        name: String(user.name ?? "").trim() || username || email.split("@")[0],
        followersCount: user.followersCount ?? 0,
        followingCount: user.followingCount ?? 0,
        postsCount: user.postsCount ?? 0,
        ...(isAdmin
          ? { verified: true, role: "admin" }
          : { role: user.role ?? "user" }),
      });
    },
  },
});
