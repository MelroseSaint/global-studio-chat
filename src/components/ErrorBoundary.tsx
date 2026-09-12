import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { useRouteError } from "react-router";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Dynamic-import failures (a React.lazy chunk 404ing) are self-healing: the
 * chunk hash an already-open tab holds is stale after a deploy, and a reload
 * fetches the fresh index.html + chunk list. Convex query errors are NOT
 * self-healing (the backend is the source of truth), so those still show the
 * fallback. Guarded by sessionStorage so we never reload-loop: exactly one
 * automatic reload per tab; a repeat failure shows the manual fallback.
 */
const CHUNK_RELOAD_KEY = "purewire:chunk-reload-v1";
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
  /Loading chunk .* failed/i,
];

function isStaleChunkError(error: Error): boolean {
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(error.message));
}

/**
 * The calm, reloadable fallback shared by the class ErrorBoundary (catches
 * errors inside its subtree) and the router's route-level errorElement
 * (catches errors thrown by a route element during a data-router render —
 * which the outer boundary CANNOT see, because the router handles them
 * itself).
 */
export function FallbackScreen() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <img
        src="/logo.svg"
        alt="PureWire"
        className="size-12 rounded-xl"
      />
      <h1 className="text-lg font-bold tracking-tight">
        Something went wrong
      </h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        An unexpected error interrupted this screen. Your account, posts,
        and files are safe — reloading fixes it.
      </p>
      {/* Plain button (no UI kit): this boundary renders when the app is
          already failing, and it sits in the eager entry — importing the
          radix Button here would drag the whole ui chunk onto every
          page's critical path, including the public Landing. */}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium whitespace-nowrap text-primary-foreground transition-colors outline-none hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:pointer-events-none disabled:opacity-50"
      >
        Reload PureWire
      </button>
    </div>
  );
}

/**
 * Route-level errorElement. A data router catches errors thrown while
 * rendering a route element and renders the nearest errorElement (or its
 * own default error page) — it does NOT propagate to the ErrorBoundary
 * wrapping the RouterProvider. Without this, a single failing query would
 * replace the app with React Router's bare "Unexpected Application Error!"
 * screen instead of the app's own fallback.
 */
export function RouteError() {
  const error = useRouteError();
  useEffect(() => {
    // Parity with the class boundary's componentDidCatch: a route error
    // must be visible in the console, not silently swallowed.
    console.error("PureWire route crashed:", error);
    if (
      error instanceof Error &&
      isStaleChunkError(error) &&
      !sessionStorage.getItem(CHUNK_RELOAD_KEY)
    ) {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
      window.location.reload();
    }
  }, [error]);
  return <FallbackScreen />;
}

/**
 * Root error boundary. PureWire renders from live backend queries, and a
 * single failing query must never blank the whole app — the worst possible
 * outcome is a blank screen with no explanation. If anything throws during
 * render (a Convex query error, a data-shape mismatch, a bad chunk), this
 * catches it and shows a calm, honest fallback with a reload path instead.
 * The page reload clears the error and re-subscribes to fresh backend state.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("PureWire UI crashed:", error, info);
    // A stale chunk after a deploy 404s and lands here; reloading fetches
    // the new bundle and recovers silently — do that once per tab instead
    // of showing the fallback for an upgrade artifact.
    if (isStaleChunkError(error) && !sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
      window.location.reload();
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return <FallbackScreen />;
    }
    return this.props.children;
  }
}
