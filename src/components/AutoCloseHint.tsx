import { Hourglass } from "lucide-react";

/**
 * The \"nearing the auto-close limit\" hint shown on a post's comment
 * composer (author or admin only, since they're the ones who can act on
 * it). Renders nothing when the thread is already closed (that surface is
 * replaced by the closed notice anyway), when the count threshold isn't
 * hydrated, or when the thread isn't within striking distance yet.
 */
export function AutoCloseHint({
  commentCount,
  threshold,
}: {
  commentCount?: number | null;
  threshold?: number | null;
}) {
  const count = commentCount ?? 0;
  if (!threshold || count >= threshold) return null;
  // Within 10 comments of the limit — the \"nearing\" window.
  if (count < threshold - 10) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Hourglass className="size-3.5 shrink-0" />
      {count} of {threshold} comments — this thread auto-closes at {threshold}
    </p>
  );
}
