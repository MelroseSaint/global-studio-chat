import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect } from "react";

import { api } from "@/convex/_generated/api";

/**
 * Auth state hook. Use this everywhere instead of reaching into
 * @convex-dev/auth/react directly.
 *
 * Returns:
 * - `isLoading`: true while the auth state is being resolved (session
 *   restore on load, or the signed-in user document still loading)
 * - `isAuthenticated`: whether the user has a valid session
 * - `user`: the current user document (null when signed out)
 * - `signIn` / `signOut`: auth actions
 */
export function useAuth() {
  const { signIn, signOut } = useAuthActions();
  // The auth client restores the stored session asynchronously: on a fresh
  // page load it reads the token from storage and confirms it with the
  // server. During that window `useAuthToken()` is null even for a signed-in
  // user, so `isAuthenticated` alone would flip false and gate components
  // (RequireAuth) would bounce to /auth before the session is restored —
  // the login-page flash on every refresh. `useConvexAuth().isLoading` is
  // true exactly until the initial auth state resolves; folding it in keeps
  // isLoading honest during restore.
  const { isLoading: authResolving } = useConvexAuth();
  const token = useAuthToken();
  const isAuthenticated = token !== null;
  const user = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? undefined : "skip",
  );

  /**
   * Self-healing session: only one state is truly unrecoverable — the
   * account a session belongs to was deleted server-side (the query
   * resolves to `null` and nothing can ever refresh it). Clear the session
   * in that case so the user can sign in fresh instead of carrying a dead
   * token into every call.
   *
   * Deliberately NOT signed out on an expired JWT: access tokens are
   * short-lived by design (1 hour) and the auth client silently refreshes
   * them with the stored refresh token, while sessions are configured to
   * last effectively forever. Treating expiry as a dead session is what
   * logged members out automatically — every hour, and on every tab
   * refocus after the token turned over.
   */
  useEffect(() => {
    // A stale session can also appear while the tab sits in the background:
    // the account is deleted server-side. Browsers suspend background
    // tabs, so the query never resolves until the tab regains focus —
    // re-run the check on `visibilitychange` so the dead session is
    // cleared immediately instead of lingering until the next navigation.
    // The check is idempotent, so running it on both paths is harmless.
    const clearStaleSession = () => {
      if (!isAuthenticated || !token) return;
      if (user === null) {
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
    // True while the session is still being restored on load OR while the
    // signed-in user document is loading. Only when this settles do gate
    // components (RequireAuth, the Auth page's redirect, NotFound) make an
    // auth decision — so a refresh never flashes the login page before the
    // stored session is restored.
    isLoading: authResolving || (isAuthenticated && user === undefined),
    isAuthenticated,
    user,
    signIn,
    signOut,
  };
}
