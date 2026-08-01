import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";

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

  return {
    isLoading: isAuthenticated && user === undefined,
    isAuthenticated,
    user,
    signIn,
    signOut,
  };
}
