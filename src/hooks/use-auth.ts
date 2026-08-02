import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { useEffect } from "react";

import { api } from "@/convex/_generated/api";

/**
 * Read the `exp` claim (unix seconds) from a JWT payload without verifying
 * the signature. Used to detect a stored token that has already expired.
 */
function jwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1] ?? "";
    // JWT payloads are unpadded base64url; some engines' atob rejects that.
    const base64 = payload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const json = JSON.parse(atob(base64)) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/**
 * Auth state hook. Use this everywhere instead of reaching into
 * @convex-dev/auth/react directly.
 *
 * Returns:
 * - `isLoading`: true while the auth state is being resolved
 * - `isAuthenticated`: whether the user has a valid session
 * - `user`: the current user document (null when signed out)
 * - `signIn` / `signOut`: auth actions
 */
export function useAuth() {
  const { signIn, signOut } = useAuthActions();
  const token = useAuthToken();
  const isAuthenticated = token !== null;
  const user = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? undefined : "skip",
  );

  /**
   * Self-healing session: a stored token can outlive its account. If the
   * token has expired, or the account it belongs to was deleted, nothing can
   * refresh it — but the client keeps attaching it to every call, so
   * sign-in and sign-up fail with "Invalid token" until the stale token is
   * cleared. Detect either case and clear the session so the user can sign
   * in fresh.
   */
  useEffect(() => {
    // A stale session can also appear while the tab sits in the background:
    // the JWT expires, or the account is deleted server-side. Browsers
    // suspend background tabs, so the query never resolves until the tab
    // regains focus — re-run the check on `visibilitychange` so the dead
    // session is cleared immediately instead of lingering until the next
    // navigation. The check is idempotent, so running it on both paths is
    // harmless.
    const clearStaleSession = () => {
      if (!isAuthenticated || !token) return;
      const exp = jwtExpiry(token);
      const stale =
        exp === null || exp * 1000 < Date.now() || user === null;
      if (stale) {
        void signOut();
      }
    };
    clearStaleSession();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearStaleSession();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isAuthenticated, token, user, signOut]);

  return {
    isLoading: isAuthenticated && user === undefined,
    isAuthenticated,
    user,
    signIn,
    signOut,
  };
}
