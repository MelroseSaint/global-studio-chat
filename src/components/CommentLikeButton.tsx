import { useMutation } from "convex/react";
import { Heart } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatLikeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Like/unlike toggle for a comment, with an optimistic count — the same
 * optimistic-rollback pattern as the post card's heart. Shared by the
 * post page and the comment popup so both surfaces behave identically.
 */
export function CommentLikeButton({
  commentId,
  likedByMe,
  likeCount,
  className,
}: {
  commentId: Id<"comments">;
  likedByMe: boolean;
  likeCount: number;
  className?: string;
}) {
  const likeComment = useMutation(api.posts.likeComment);
  const unlikeComment = useMutation(api.posts.unlikeComment);
  const [liked, setLiked] = useState(likedByMe);
  const [count, setCount] = useState(likeCount);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const next = !liked;
    setLiked(next);
    setCount((c) => Math.max(0, c + (next ? 1 : -1)));
    try {
      if (next) await likeComment({ commentId });
      else await unlikeComment({ commentId });
    } catch {
      setLiked(!next);
      setCount((c) => Math.max(0, c + (!next ? 1 : -1)));
      toast.error("Could not update like.");
    } finally {
      setBusy(false);
    }
  };

  // Plain-language label: the count reads as "N likes" (singular "1 like"),
  // and a comment with no likes yet reads simply "Like" — friendlier than a
  // bare number. The aria-label keeps the verb form for screen readers.
  const label = count === 0 ? "Like" : formatLikeLabel(count);

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      aria-label={liked ? "Unlike this comment" : "Like this comment"}
      title={liked ? "Unlike this comment" : "Like this comment"}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] transition-colors hover:bg-primary/10 hover:text-primary",
        liked && "text-primary",
        className,
      )}
    >
      <Heart className={cn("size-4", liked && "fill-current")} />
      <span className="font-semibold tabular-nums">{label}</span>
    </button>
  );
}
