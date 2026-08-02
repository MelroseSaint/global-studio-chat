import { motion } from "framer-motion";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { LogoDropdown } from "@/components/LogoDropdown";
import { useAuth } from "@/hooks/use-auth";

export function NotFound() {
  const { isLoading, isAuthenticated } = useAuth();
  const signedOut = !isLoading && !isAuthenticated;

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background:
            "radial-gradient(500px 300px at 50% 0%, oklch(0.62 0.22 300 / 0.25), transparent)",
        }}
      />
      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-6">
        <LogoDropdown />
        <Button variant="ghost" size="sm" asChild>
          <Link to="/home">Go home</Link>
        </Button>
      </header>
      <main className="relative flex flex-1 items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="flex max-w-md flex-col items-center gap-4 text-center"
        >
          <p className="brand-gradient-text text-7xl font-black tracking-tight">
            404
          </p>
          <h1 className="text-3xl font-bold tracking-tight">
            This page doesn&apos;t exist
          </h1>
          <p className="text-sm text-muted-foreground sm:text-base">
            The link may be broken, or the post or profile may have been
            removed.
          </p>
          {signedOut ? (
            <p className="rounded-full border border-border/60 bg-card/60 px-4 py-2 text-sm text-muted-foreground">
              This content may need you to be signed in.{" "}
              <Link
                to="/auth"
                className="font-medium text-primary hover:underline"
              >
                Sign in to PureWire
              </Link>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link to="/home">Back to your feed</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/explore">Explore</Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/support">Contact support</Link>
            </Button>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
