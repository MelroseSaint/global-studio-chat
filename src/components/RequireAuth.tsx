import { Navigate, useLocation } from "react-router";

import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/hooks/use-auth";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthRestoring, isAuthenticated } = useAuth();
  const location = useLocation();

  // Gate ONLY on the session-token restore (a few ms) — NOT on the `me`
  // user document loading. Mounting the shell immediately lets the
  // user-doc query, the shell's unread counts, and the page's own data
  // queries run in parallel on a refresh; every authed page guards its own
  // use of the user document. A dead session still resolves to `user ===
  // null`, which signs out and lands here as a redirect — the same
  // outcome, just without the extra serial round trip on every good
  // refresh.
  if (isAuthRestoring) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    const returnTo = encodeURIComponent(
      location.pathname + location.search,
    );
    return <Navigate to={`/auth?returnTo=${returnTo}`} replace />;
  }

  return children;
}
