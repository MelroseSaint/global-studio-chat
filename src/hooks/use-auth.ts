import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";

// @convex-dev/auth namespaces its storage keys by the Convex URL (escaped
// to alphanumerics) — see useNamespacedStorage: `__convexAuthJWT_<url>`.
// Mirroring that here lets the loading gate read, synchronously, whether a
// session can possibly be restored on this device.
const CONVEX_AUTH_NAMESPACE = (import.meta.env.VITE_CONVEX_URL ?? "").replace(
  /[^a-zA-Z0-9]/g,
  "",
);

// Dead-session confirmation windows (see clearStaleSession in useAuth): a
// `user === null` observation is only trusted after the query stays null
// past the first grace window AND is still null after a second confirm
// window — each check reads the LIVE query result, so a session that
// recovers mid-window (the deploy settles, the socket reconnects) cancels
// the sign-out. A deploy swap can transiently null the `me` query; these
// windows make that self-healing instead of logging the member out.
const STALE_SESSION_GRACE_MS = 5000;
const STALE_SESSION_CONFIRM_MS = 8000;

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

  // The auth client's `isLoading` starts true for *every* visitor — even an
  // anonymous one with nothing to restore — because the storage read is
  // async. Folding it in unconditionally made every public page pay a
  // spinner→form double render on mount (measured ~100-160ms of extra
  // tap-to-paint on throttled mobile for nav→/auth). A session can only be
  // *restored* when a JWT actually exists in storage, which is a synchronous
  // read — so hold the restore gate only when there's a token to restore.
  // Wrapped in try/catch because storage access can throw in private mode /
  // sandboxed frames (same guard the Auth page's remember-me toggle uses);
  // on failure we pessimistically assume nothing can be restored.
  const [hasStoredSession] = useState(() => {
    try {
      return (
        window.localStorage.getItem(`__convexAuthJWT_${CONVEX_AUTH_NAMESPACE}`) !=
        null
      );
    } catch {
      return false;
    }
  });
  const user = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? undefined : "skip",
  );

  // Live mirror of `user` for the deferred sign-out check: the effect's
  // closure captures `user` at schedule time, but the confirm timer fires
  // later — it must see the CURRENT value, not the value from when the
  // null was first observed (the query may have recovered meanwhile).
  const userRef = useRef(user);
  userRef.current = user;

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
   *
   * A `user === null` observation is NOT proof the session is dead by
   * itself: during a deploy the backend is swapped mid-flight, so the `me`
   * query can transiently resolve null (the new deployment momentarily
   * rejecting the old JWT, the socket reconnecting) and then recover on
   * its own once the swap settles. Signing out on that FIRST null would
   * permanently erase the stored tokens — logging every member out over a
   * deploy blip. So the sign-out is CONFIRMED: wait a grace window, then
   * RE-CHECK the live query result (not the closure) before erasing, and
   * give it one more confirm window if still null. The `me` query
   * re-runs automatically when the deployment settles, so a recovered
   * session updates `userRef.current` while the timer is still pending
   * and the sign-out is skipped. Only a null that persists through both
   * windows — a genuinely deleted account — erases the session.
   */
  useEffect(() => {
    // A stale session can also appear while the tab sits in the background:
    // the account is deleted server-side. Browsers suspend background
    // tabs, so the query never resolves until the tab regains focus —
    // re-run the check on `visibilitychange` so the dead session is
    // cleared (after the same confirmation) instead of lingering until the
    // next navigation. The check is idempotent, so running it on both
    // paths is harmless.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearStaleSession = () => {
      if (!isAuthenticated || !token) return;
      if (user !== null) return; // healthy — nothing to clear
      // `user === null`: don't erase on the first observation. Wait a
      // grace window (a deploy swap is sub-second to a few seconds; the
      // query re-resolves once the new deployment settles), then confirm
      // the session is REALLY dead by re-checking the CURRENT query
      // result. If it recovered, the user stays logged in — the shell
      // simply re-renders with the fresh user document.
      if (timer !== undefined) return; // already scheduled
      timer = setTimeout(() => {
        timer = undefined;
        if (cancelled || userRef.current !== null) return;
        // Still null after the grace window — could be a slower deploy.
        // One more confirm window, re-checking live again, before the
        // final sign-out.
        timer = setTimeout(() => {
          timer = undefined;
          if (cancelled || userRef.current !== null) return;
          void signOut();
        }, STALE_SESSION_CONFIRM_MS);
      }, STALE_SESSION_GRACE_MS);
    };
    clearStaleSession();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearStaleSession();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isAuthenticated, token, user, signOut]);

  return {
    // True while the session is still being restored on load OR while the
    // signed-in user document is loading. Only when this settles do gate
    // components (the Auth page's redirect, NotFound) make an auth
    // decision — so a refresh never flashes the login page before the
    // stored session is restored. The restore window only matters when a
    // JWT exists in storage (see hasStoredSession above) — an anonymous
    // visitor has nothing to restore, so the gate stays closed and the
    // public pages render their real content on the first frame.
    isLoading:
      (authResolving && hasStoredSession) ||
      (isAuthenticated && user === undefined),
    // The narrowest auth gate: true only while a STORED session is being
    // restored (the few ms the auth client reads the token). Route guards
    // (RequireAuth) mount the shell on this instead of on isLoading, so a
    // signed-in refresh renders the app immediately and the `me` document,
    // the shell's unread counts, and the page's own queries all start in
    // PARALLEL — the old serialized gate (wait for `me`, then mount, then
    // query the page) added a full round trip to every authed refresh.
    // Pages that need the user document guard themselves (Settings and
    // Admin return null until `user` resolves).
    isAuthRestoring: authResolving && hasStoredSession,
    isAuthenticated,
    user,
    signIn,
    signOut,
  };
}
