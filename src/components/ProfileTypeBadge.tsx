import { cn } from "@/lib/utils";

/**
 * The member's explicit profile-type declaration, shown as a small badge
 * next to their name everywhere they appear.
 *
 * Design rules (per the identity spec): the two types are EQUAL
 * classifications — same shape, same size, same weight. Creator gets the
 * platform's primary tint, User stays neutral; neither resembles a
 * verification checkmark (verified is a separate badge) and neither reads
 * as a warning or restricted status. A Creator badge means only that the
 * member identified themselves that way — nothing about verification,
 * originality, fame, or endorsement.
 */
export function ProfileTypeBadge({
  profileType,
  className,
}: {
  profileType: string | null | undefined;
  className?: string;
}) {
  if (profileType !== "creator" && profileType !== "user") return null;
  const isCreator = profileType === "creator";
  return (
    <span
      title={
        isCreator
          ? "This account identifies as a Creator"
          : "This account identifies as a User"
      }
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
        isCreator
          ? "border-primary/20 bg-primary/10 text-primary"
          : "border-border bg-muted/60 text-muted-foreground",
        className,
      )}
    >
      {isCreator ? "Creator" : "User"}
    </span>
  );
}
