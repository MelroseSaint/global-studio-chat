import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

import { EmailVerification, PasswordReset } from "./auth/email";

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
      // One-time codes verify the account (email verification on sign-up
      // and password resets). There are no guest or anonymous accounts on
      // PureWire — every account is created with a real email and must
      // verify it with a code.
      verify: EmailVerification,
      reset: PasswordReset,
    }),
  ],
});
