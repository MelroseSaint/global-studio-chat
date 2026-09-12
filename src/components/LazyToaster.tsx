import { useEffect, useState, type ComponentType } from "react";

/**
 * The toast surface, mounted lazily after first paint. sonner shares the ui
 * chunk with the radix primitives, so importing it eagerly would drag the
 * whole ui chunk onto the initial critical path — for a surface that only
 * matters once the user interacts. Toasts fire from user actions, so none
 * can be lost before this mounts.
 */
export function LazyToaster() {
  const [Toaster, setToaster] = useState<ComponentType | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("@/components/ui/sonner")
      .then((m) => {
        if (!cancelled) setToaster(() => m.Toaster);
      })
      .catch(() => {
        // Toasts are a convenience — a failed lazy load changes nothing.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return Toaster ? <Toaster /> : null;
}
