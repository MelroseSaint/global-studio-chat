import { useQuery } from "convex/react";
import { Link2, Loader2 } from "lucide-react";
import { Link } from "react-router";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ProfileTypeBadge } from "@/components/ProfileTypeBadge";
import { RichText } from "@/components/SharedPostEmbed";
import { UserAvatar } from "@/components/UserAvatar";
import { VoiceNote } from "@/components/VoiceNote";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A comment referenced by a share, rendered as a preview card — the
 * comment-share mirror of SharedPostCard. Lives in its own component
 * because useQuery can't run inside a message/comment map loop. The
 * original is fetched through the normal visibility rules
 * (api.posts.getCommentForShare), so a deleted comment, a blocked or
 * silenced author, or a removed account degrades to a muted "no longer
 * available" note — never a broken card or leaked content.
 *
 * Used by comment threads (popup, post page, replies) and DM threads so a
 * shared comment renders identically everywhere. Any kind of comment is
 * shareable — text, voice note, or a reply — and the card shows the
 * original with its author, media, and a link back to the thread it lives
 * in.
 */
export function SharedCommentEmbed({
  commentId,
  className,
}: {
  commentId: string;
  className?: string;
}) {
  const comment = useQuery(api.posts.getCommentForShare, {
    commentId: commentId as Id<"comments">,
  });
  if (comment === undefined) {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs opacity-80">
        <Loader2 className="size-3.5 animate-spin" />
        Loading comment…
      </div>
    );
  }
  if (comment === null) {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Link2 className="size-3.5 shrink-0" />
        This comment is no longer available.
      </div>
    );
  }
  const author = comment.author;
  return (
    <div
      className={cn(
        "mt-1.5 overflow-hidden rounded-xl border bg-muted/30",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Shared a comment
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {timeAgo(comment._creationTime)}
        </span>
      </div>
      <div className="px-3 pb-2.5 pt-1.5">
        <div className="flex items-center gap-2">
          {author ? (
            <>
              <UserAvatar user={author} className="size-6 shrink-0" />
              <p className="flex min-w-0 items-center gap-1.5 truncate text-xs font-semibold">
                {author.name || author.username || "Unknown"}
                <ProfileTypeBadge profileType={author.profileType} />
              </p>
            </>
          ) : (
            <span className="text-xs font-semibold text-muted-foreground">
              Unknown
            </span>
          )}
        </div>
        {comment.content ? (
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-foreground/90">
            <RichText text={comment.content} />
          </p>
        ) : null}
        {comment.media?.kind === "audio" ? (
          <VoiceNote
            media={comment.media}
            trackId={`shared-${comment._id}`}
            className="max-w-[180px]"
          />
        ) : null}
        <Link
          to={`/post/${comment.hostPostId}`}
          onClick={(e) => e.stopPropagation()}
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
        >
          View original
        </Link>
      </div>
    </div>
  );
}
