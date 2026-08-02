import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
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
  }

  render(): ReactNode {
    if (this.state.error) {
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
          <Button onClick={() => window.location.reload()}>
            Reload PureWire
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
