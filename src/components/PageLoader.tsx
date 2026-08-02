import { Spinner } from "@/components/ui/spinner";

/**
 * Branded full-page fallback shown while a lazy page chunk downloads. Keeps
 * first paint lean — only the shell is eager; the page body fills in below.
 */
export function PageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <div className="flex size-14 items-center justify-center rounded-2xl brand-gradient-bg text-white">
        <Spinner className="size-6" aria-hidden />
      </div>
      <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
    </div>
  );
}
