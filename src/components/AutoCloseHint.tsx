import { Hourglass } from "lucide-react";
import { useState } from "react";

const DAY_MS = 86_400_000;

/**
 * The "nearing the auto-close limit" hint shown on a post's comment
 * composer (author or admin only, since they're the ones who can act on
 * it). Two independent triggers, joined with a dot: the comment-count leg
 * ("93 of 100 comments") when the thread is within 10 comments of the
 * threshold, and the age leg ("closes in 12 days") when the post is
 * within 10 days of the age threshold. Renders nothing when neither
 * applies — and never on an already-closed thread, where the composer is
 * replaced by the closed notice anyway.
 */
export function AutoCloseHint({
  commentCount,
  threshold,
  ageMs,
  createdAt,
}: {
  commentCount?: number | null;
  threshold?: number | null;
  ageMs?: number | null;
  createdAt?: number | null;
}) {
  // Frozen "now" at mount — Date.now() in render is impure (React
  // Compiler rule), and a "closes in N days" hint doesn't need to tick.
  const [now] = useState(() => Date.now());
  const count = commentCount ?? 0;
  const nearCount =
    threshold != null && count < threshold && count >= threshold - 10;
  const remainingMs = ageMs && createdAt ? ageMs - (now - createdAt) : 0;
  const nearAge =
    Boolean(ageMs) && Boolean(createdAt) && remainingMs > 0 && remainingMs <= 10 * DAY_MS;
  if (!nearCount && !nearAge) return null;

  const bits: string[] = [];
  if (nearCount) bits.push(`${count} of ${threshold} comments`);
  if (nearAge) {
    const days = Math.max(1, Math.ceil(remainingMs / DAY_MS));
    bits.push(`closes in ${days} ${days === 1 ? "day" : "days"}`);
  }
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Hourglass className="size-3.5 shrink-0" />
      {bits.join(" · ")}
    </p>
  );
}
