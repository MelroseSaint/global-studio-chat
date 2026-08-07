import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ScanSearch,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useParams } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CommentLikeButton } from "@/components/CommentLikeButton";
import { PostCard, type PostItem } from "@/components/PostCard";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { aiReportTicketArgs } from "@/lib/ai-report";
import { solveChallenge } from "@/lib/pow";
import { phishingTicketArgs } from "@/lib/phishing-report";

/**
 * The actions on a single comment. Comments had no menu before; the one
 * action that matters for the platform's integrity is the one-tap phishing
 * report — a ticket pre-attached to the post, the commenter, and the
 * "No scams or phishing" Standard principle.
 */
function CommentMenu({
  postId,
  comment,
  isMine,
  onEdit,
  onDelete,
}: {
  postId: Id<"posts">;
  comment: {
    author: { _id: string } | null;
    content: string;
  };
  isMine?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const createTicket = useMutation(api.support.createTicket);
  const [reporting, setReporting] = useState(false);
  const [reportingAi, setReportingAi] = useState(false);

  // One-tap AI-content report on a comment, mirroring the phishing quick
  // action: files a ticket pre-attached to the post, the commenter, and the
  // "No AI-generated content" principle.
  const reportAi = async () => {
    if (reportingAi) return;
    setReportingAi(true);
    try {
      await createTicket(
        aiReportTicketArgs({
          postId,
          offenderId: comment.author?._id as Id<"users"> | undefined,
          content: comment.content,
          kind: "comment",
        }),
      );
      toast.success("AI-content report sent — our team will review it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send report.");
    } finally {
      setReportingAi(false);
    }
  };

  const reportPhishing = async () => {
    if (reporting) return;
    setReporting(true);
    try {
      await createTicket(
        phishingTicketArgs({
          postId,
          offenderId: comment.author?._id as Id<"users"> | undefined,
          content: comment.content,
          kind: "comment",
        }),
      );
      toast.success("Phishing report sent — our team will review it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send report.");
    } finally {
      setReporting(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 max-sm:opacity-100"
          aria-label="Comment actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isMine && (
          <>
            <DropdownMenuItem onClick={() => onEdit?.()}>
              <Pencil className="size-4" />
              Edit comment
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void onDelete?.()}>
              <Trash2 className="size-4 text-destructive" />
              Delete comment
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => void reportAi()}>
          <ScanSearch className="size-4 text-oxide" />
          Report AI content
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void reportPhishing()}>
          <ShieldAlert className="size-4 text-destructive" />
          Report phishing
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PostDetail() {
  const { postId = "" } = useParams();
  const { user } = useAuth();
  const postIdTyped = postId as Id<"posts">;
  const post = useQuery(api.posts.getPost, { postId: postIdTyped });
  const addComment = useMutation(api.posts.addComment);
  const editComment = useMutation(api.posts.editComment);
  const deleteComment = useMutation(api.posts.deleteComment);
  const powChallenge = useQuery(api.pow.getChallenge);
  const [commentSort, setCommentSort] = useState<"newest" | "top">("top");
  const { results, status, loadMore } = usePaginatedQuery(
    api.posts.listComments,
    { postId: postIdTyped, sort: commentSort },
    { initialNumItems: 15 },
  );
  const { ref, inView } = useInView();
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Per-comment expand state for the Show more/less clamp so a single
  // long comment never inflates the list on a tablet.
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());
  // Inline edit state: which comment is being edited, its draft text, and
  // whether the save is in flight.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(10);
    }
  }, [inView, status, loadMore]);

  if (post === undefined) {
    return (
      <div className="p-4">
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (post === null) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        This post doesn&apos;t exist.
      </p>
    );
  }

  const comments = results as unknown as {
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
    editedAt?: number;
    likeCount?: number;
    likedByMe: boolean;
  }[];

  const submit = async () => {
    const text = comment.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      // Proof-of-work before the write — same scheme as posting.
      const pow = await solveChallenge(powChallenge);
      const res = await addComment({
        postId: postIdTyped,
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
      // In "Top" sort a brand-new (0-like) comment sinks to the bottom, so
      // flip to "Newest" so the author sees their comment appear at the
      // top instead of thinking it failed.
      setCommentSort("newest");
      toast.success("Comment posted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not comment.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!window.confirm("Delete this comment? This cannot be undone.")) return;
    try {
      await deleteComment({ commentId: commentId as Id<"comments"> });
      if (editingId === commentId) setEditingId(null);
      toast.success("Comment deleted.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not delete comment.",
      );
    }
  };

  const saveEdit = async () => {
    if (!editingId || savingEdit) return;
    const text = editText.trim();
    if (!text) return;
    setSavingEdit(true);
    try {
      // Proof-of-work before the write — same scheme as commenting.
      const pow = await solveChallenge(powChallenge);
      const res = await editComment({
        commentId: editingId as Id<"comments">,
        content: text,
        powChallenge: pow.powChallenge,
        powNonce: pow.powNonce,
        powIssuedAt: pow.powIssuedAt,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not edit comment.");
        return;
      }
      setEditingId(null);
      toast.success("Comment updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not edit comment.");
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="pb-20 lg:pb-0">
      <PostCard post={post as unknown as PostItem} />

      {/* Comment composer */}
      <div className="flex gap-3 border-b px-4 py-3 sm:px-5">
        <UserAvatar user={user} className="size-9" />
        <div className="flex flex-1 items-end gap-2">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Write a comment…"
            rows={1}
            maxLength={500}
            className="min-h-10 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <Button
            size="icon"
            className="shrink-0 rounded-full"
            disabled={!comment.trim() || submitting}
            onClick={() => void submit()}
            aria-label="Send comment"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <MessageCircle className="size-4 text-muted-foreground" />
          Comments
        </div>
        <div
          aria-label="Sort comments"
          className="flex items-center gap-0.5 rounded-full border bg-muted/40 p-0.5 text-xs"
        >
          <button
            type="button"
            aria-pressed={commentSort === "top"}
            onClick={() => setCommentSort("top")}
            className={cn(
              "rounded-full px-2.5 py-1 font-medium transition-colors",
              commentSort === "top"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Top
          </button>
          <button
            type="button"
            aria-pressed={commentSort === "newest"}
            onClick={() => setCommentSort("newest")}
            className={cn(
              "rounded-full px-2.5 py-1 font-medium transition-colors",
              commentSort === "newest"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Newest
          </button>
        </div>
      </div>

      {status === "LoadingFirstPage" && (
        <div className="space-y-3 p-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      )}

      {comments.length === 0 && status !== "LoadingFirstPage" && (
        <p className="px-5 pb-8 text-sm text-muted-foreground">
          No comments yet. Be the first to reply.
        </p>
      )}

      {comments.map((c) => {
        const isExpanded = expandedComments.has(c._id);
        const isLong = (c.content ?? "").length > 200;
        const isEditing = editingId === c._id;
        return (
          <div key={c._id} className="group flex gap-3 px-4 py-3 sm:px-5">
            <UserAvatar user={c.author} className="size-9" />
            <div className="min-w-0 flex-1">
              {isEditing ? (
                <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2.5">
                  <Textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={2}
                    maxLength={500}
                    className="min-h-10 resize-none bg-background"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingId(null)}
                      disabled={savingEdit}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void saveEdit()}
                      disabled={savingEdit || !editText.trim()}
                    >
                      {savingEdit ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Pencil className="size-3.5" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-2.5">
                  <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm font-semibold">
                    {c.author?.name || c.author?.username || "Unknown"}
                    {c.editedAt ? (
                      <span className="text-[11px] font-normal text-muted-foreground">
                        · edited
                      </span>
                    ) : null}
                  </p>
                  <p
                    className={cn(
                      "whitespace-pre-wrap break-words text-sm leading-relaxed",
                      !isExpanded && "line-clamp-3",
                    )}
                  >
                    {c.content}
                  </p>                      {isLong ? (
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedComments((prev) => {
                              const next = new Set(prev);
                              if (next.has(c._id)) next.delete(c._id);
                              else next.add(c._id);
                              return next;
                            });
                          }}
                          className="mt-0.5 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {isExpanded ? (
                            <>
                              <ChevronUp className="size-3.5" />
                              Show less
                            </>
                          ) : (
                            <>
                              <ChevronDown className="size-3.5" />
                              Show more
                            </>
                          )}
                        </button>
                      ) : null}
                      <div className="mt-1.5">
                        <CommentLikeButton
                          commentId={c._id as Id<"comments">}
                          likedByMe={c.likedByMe}
                          likeCount={c.likeCount ?? 0}
                        />
                      </div>
                    </div>
                  )}
                </div>
            <CommentMenu
              postId={postIdTyped}
              comment={c}
              isMine={c.author?._id === user?._id}
              onEdit={() => {
                setEditingId(c._id);
                setEditText(c.content);
              }}
              onDelete={() => void handleDeleteComment(c._id)}
            />
          </div>
        );
      })}

      <div ref={ref} className="flex justify-center py-4">
        {status === "LoadingMore" && (
          <span className="text-sm text-muted-foreground">Loading more…</span>
        )}
      </div>
    </div>
  );
}
