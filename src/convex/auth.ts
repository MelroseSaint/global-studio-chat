import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

import { EmailVerification, PasswordReset } from "./auth/email";

const ADMIN_EMAIL = "monreodoses@gmail.com";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const email = String(params.email ?? "")
          .toLowerCase()
          .trim();
        const username =
          String(params.username ?? "")
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9_]/g, "") || undefined;
        const isAdmin = email === ADMIN_EMAIL;
        return {
          email,
          name: String(params.name ?? username ?? email.split("@")[0]),
          ...(username !== undefined ? { username } : {}),
          ...(isAdmin
            ? { verified: true as const, role: "admin" as const }
            : { role: "user" as const }),
          followersCount: 0,
          followingCount: 0,
          postsCount: 0,
        };
      },
      verify: EmailVerification,
      reset: PasswordReset,
    }),
  ],
});
