import {
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { Loader2, Lock, MessageCircle, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PostItem } from "@/components/PostCard";
import { PostMediaGrid, RichText } from "@/components/SharedPostEmbed";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { timeAgo } from "@/lib/format";
import { solveChallenge } from "@/lib/pow";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 500;

interface PreviewComment {
  _id: string;
  author: {
    _id: string;
    name?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
    verified?: boolean | null;
  } | null;
  content: string;
  _creationTime: number;
}

/**
 * A compact, read-only peek at the most recent comments on the post, so
 * the popup shows the conversation before you reply. Mounted only while
 * the dialog is open — post cards in the feed never query comments.
 */
function CommentPreview({ postId }: { postId: Id<"posts"> }) {
  const { results, status } = usePaginatedQuery(
    api.posts.listComments,
    { postId },
    { initialNumItems: 3 },
  );
  const comments = results as unknown as PreviewComment[];

  if (status === "LoadingFirstPage" || comments.length === 0) return null;

  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <MessageCircle className="size-3.5" />
        Comments
      </p>
      <div className="mt-2 space-y-2.5">
        {comments.map((c) => (
          <div key={c._id} className="flex gap-2">
            <UserAvatar user={c.author} className="size-7" />
            <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2">
              <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                <span className="font-semibold">
                  {c.author?.name || c.author?.username || "Unknown"}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {timeAgo(c._creationTime)}
                </span>
              </p>
              <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {c.content}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Popup comment composer: clicking the comment button on a post opens this
 * dialog right where you are — no redirect to the post page. The post is
 * previewed inside for context, and the same proof-of-work gated
 * `addComment` mutation runs as on the detail page.
 */
export function CommentDialog({
  post,
  open,
  onOpenChange,
  onCommented,
}: {
  post: PostItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommented?: () => void;
}) {
  const { user } = useAuth();
  const addComment = useMutation(api.posts.addComment);
  const powChallenge = useQuery(api.pow.getChallenge);
  const navigate = useNavigate();
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const locked = !!post.commentsLocked;
  const author = post.author;
  const authorName =
    author?.name ??
    (author?.username ? `@${author.username}` : "this post");

  // Autofocus the box each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => textareaRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [open]);

  const submit = async () => {
    const text = comment.trim();
    if (!text || submitting || locked) return;
    setSubmitting(true);
    try {
      // Proof-of-work before the write — same scheme as posting/commenting.
      const pow = await solveChallenge(powChallenge);
      const res = await addComment({
        postId: post._id,
        content: text,
        powChallenge: pow.powChallenge,
        powNonce: pow.powNonce,
        powIssuedAt: pow.powIssuedAt,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not comment.");
        return;
      }
      setComment("");
      onCommented?.();
      onOpenChange(false);
      toast.success("Comment posted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not comment.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-5 text-primary" />
            Reply to {authorName}
          </DialogTitle>
          <DialogDescription>
            Share your thoughts publicly on this post.
          </DialogDescription>
        </DialogHeader>

        {locked ? (
          <p className="flex items-center gap-2 rounded-lg border border-muted bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
            <Lock className="size-4 shrink-0" />
            Comments are locked on this post.
          </p>
        ) : (
          <div className="flex gap-3">
            <UserAvatar user={user} className="size-9" />
            <div className="min-w-0 flex-1">
              <Textarea
                ref={textareaRef}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Write a comment…"
                rows={3}
                maxLength={MAX_LENGTH + 10}
                className="resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <span
                className={cn(
                  "mt-1 block text-right text-xs tabular-nums",
                  comment.length > MAX_LENGTH
                    ? "font-semibold text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {comment.length}/{MAX_LENGTH}
              </span>
            </div>
          </div>
        )}

        {/* Compact, non-clickable preview of the post being replied to. */}
        <div className="rounded-xl border bg-muted/30 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <UserAvatar user={post.author} className="size-6" />
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate font-semibold">
                {post.author?.name ?? post.author?.username ?? "Unknown"}
              </span>
              {post.author?.verified ? (
                <VerifiedBadge className="shrink-0" />
              ) : null}
              <span className="truncate text-muted-foreground">
                @{post.author?.username}
              </span>
            </span>
          </div>
          {post.content ? (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
              <RichText text={post.content} />
            </p>
          ) : null}
          {post.mediaUrls && post.mediaUrls.length > 0 ? (
            <PostMediaGrid media={post.mediaUrls} />
          ) : null}
        </div>

        {open && <CommentPreview postId={post._id} />}

        <DialogFooter>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => navigate(`/post/${post._id}`)}
            disabled={submitting}
          >
            <MessageCircle className="size-4" />
            View all comments
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting || locked || !comment.trim()}
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Post comment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
