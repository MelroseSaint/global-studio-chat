import {
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import {
  Heart,
  Loader2,
  Lock,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Repeat2,
  Send,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AudioCommentButton, type CommentAudio } from "@/components/AudioCommentButton";
import { VoiceNote } from "@/components/VoiceNote";
import { AutoCloseHint } from "@/components/AutoCloseHint";
import { CommentLikeButton } from "@/components/CommentLikeButton";
import { ProfileTypeBadge } from "@/components/ProfileTypeBadge";
import { autoClosePolicyPhrase } from "@/lib/comment-policy";
import { CommentReplies, CommentReplyComposer } from "@/components/CommentReplies";
import { CommentShareDialog } from "@/components/CommentShareDialog";
import type { PostItem } from "@/components/PostCard";
import { SharedCommentEmbed } from "@/components/SharedCommentEmbed";
import { SharedPostCard } from "@/components/SharedPostCard";
import { SharedPostComposer } from "@/components/SharedPostComposer";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { formatLikeLabel, formatPluralLabel, timeAgo } from "@/lib/format";
import { solveChallenge, type PowChallenge } from "@/lib/pow";
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
    profileType?: string | null;
  } | null;
  content: string;
  _creationTime: number;
  editedAt?: number;
  likeCount?: number;
  parentId?: string;
  replyCount?: number;
  // A post shared into the comment — rendered as a preview card below
  // the text (the id is public metadata; see schema.ts).
  sharedPostId?: string;
  // Another comment shared into this one — rendered as a preview card
  // below the text (the comment-share mirror of sharedPostId).
  sharedCommentId?: string;
  // A voice note attached to the comment — rendered with the native
  // player, same as post audio (Cloudinary reference; see schema.ts).
  media?: {
    storageId?: string;
    url?: string;
    key?: string;
    kind?: string;
    title?: string;
  } | null;
  likedByMe: boolean;
}

/**
 * A compact peek at the most recent comments on the post, so the popup
 * shows the conversation before you reply. Your own comments carry a
 * small menu to edit or delete them in place. Mounted only while the
 * dialog is open — post cards in the feed never query comments.
 */
function CommentPreview({
  postId,
  viewerId,
  postAuthorId,
  powChallenge,
  onDeleted,
}: {
  postId: Id<"posts">;
  viewerId?: string;
  // The post's author — they can delete any comment on their post.
  postAuthorId?: string;
  powChallenge?: PowChallenge;
  onDeleted?: () => void;
}) {
  // The preview surfaces the best replies, so it always uses the "top"
  // sort (highest like count first).
  const { results, status } = usePaginatedQuery(
    api.posts.listComments,
    { postId, sort: "top" },
    { initialNumItems: 3 },
  );
  const editComment = useMutation(api.posts.editComment);
  const deleteComment = useMutation(api.posts.deleteComment);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  // Which preview comment's inline reply composer is open.
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(
    null,
  );
  // Which comment is being shared (opens CommentShareDialog, preselected).
  const [shareTarget, setShareTarget] = useState<string | null>(null);
  const comments = results as unknown as PreviewComment[];

  if (status === "LoadingFirstPage" || comments.length === 0) return null;

  const handleDelete = async (c: PreviewComment) => {
    if (busy) return;
    if (!window.confirm("Delete this comment? This cannot be undone.")) return;
    setBusy(true);
    try {
      await deleteComment({ commentId: c._id as Id<"comments"> });
      if (editingId === c._id) setEditingId(null);
      onDeleted?.();
      toast.success("Comment deleted.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not delete comment.",
      );
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editingId || busy) return;
    const text = editText.trim();
    if (!text) return;
    setBusy(true);
    try {
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
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <MessageCircle className="size-3.5" />
        Comments
      </p>
      <div className="mt-2 space-y-2.5">
        {comments.map((c) => {
          const isMine = c.author?._id === viewerId;
          // Post author moderating their own thread: delete only, no edit.
          const canModerate =
            !isMine && postAuthorId !== undefined && postAuthorId === viewerId;
          const isEditing = editingId === c._id;
          return (
            <div key={c._id} className="flex gap-2">
              <UserAvatar user={c.author} className="size-7" />
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <div className="rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2">
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      maxLength={500}
                      className="min-h-9 resize-none bg-background"
                    />
                    <div className="mt-1.5 flex justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void saveEdit()}
                        disabled={busy || !editText.trim()}
                      >
                        {busy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="group flex items-start gap-1 rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-1.5 text-xs">
                        <span className="font-semibold">
                          {c.author?.name || c.author?.username || "Unknown"}
                        </span>
                        <ProfileTypeBadge
                          profileType={c.author?.profileType}
                          className="shrink-0"
                        />
                        <span className="text-[11px] text-muted-foreground">
                          {timeAgo(c._creationTime)}
                          {c.editedAt ? " · edited" : ""}
                        </span>
                      </p>
                      <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
                        {c.content}
                      </p>
                      {c.media?.url ? (
                        <VoiceNote
                          media={c.media}
                          trackId={`comment:${c.media.key ?? c._id}`}
                        />
                      ) : null}
                      {c.sharedPostId ? (
                        <SharedPostCard postId={c.sharedPostId} />
                      ) : null}
                      {c.sharedCommentId ? (
                        <SharedCommentEmbed commentId={c.sharedCommentId} />
                      ) : null}
                      <div className="mt-1 flex items-center gap-3">
                        <CommentLikeButton
                          commentId={c._id as Id<"comments">}
                          likedByMe={c.likedByMe}
                          likeCount={c.likeCount ?? 0}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setReplyTo({
                              id: c._id,
                              name:
                                c.author?.name ||
                                c.author?.username ||
                                "them",
                            })
                          }
                          className="text-xs font-semibold text-muted-foreground transition-colors hover:text-primary"
                        >
                          Reply
                        </button>
                        <button
                          type="button"
                          onClick={() => setShareTarget(c._id)}
                          className="flex items-center gap-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-primary"
                        >
                          <Repeat2 className="size-3" />
                          Share
                        </button>
                      </div>
                    </div>
                    {(isMine || canModerate) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Comment actions"
                            className="size-6 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 max-sm:opacity-100"
                          >
                            <MoreHorizontal className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {isMine && (
                            <DropdownMenuItem
                              onClick={() => {
                                setEditingId(c._id);
                                setEditText(c.content);
                              }}
                            >
                              <Pencil className="size-4" />
                              Edit
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => void handleDelete(c)}>
                            <Trash2 className="size-4 text-destructive" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                )}
                {replyTo?.id === c._id ? (
                  <div className="mt-2">
                    <CommentReplyComposer
                      postId={postId}
                      parentId={c._id as Id<"comments">}
                      replyToName={replyTo.name}
                      powChallenge={powChallenge}
                      onCancel={() => setReplyTo(null)}
                      onPosted={() => setReplyTo(null)}
                      autoFocus
                    />
                  </div>
                ) : null}
                <CommentReplies
                  postId={postId}
                  parentId={c._id as Id<"comments">}
                  replyCount={c.replyCount ?? 0}
                  viewerId={viewerId}
                  postAuthorId={postAuthorId}
                  powChallenge={powChallenge}
                />
              </div>
            </div>
          );
        })}
      </div>
      <CommentShareDialog
        open={shareTarget !== null}
        onOpenChange={(o) => {
          if (!o) setShareTarget(null);
        }}
        presetCommentId={shareTarget}
      />
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
  onCommentDeleted,
}: {
  post: PostItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommented?: () => void;
  onCommentDeleted?: () => void;
}) {
  const { user } = useAuth();
  const addComment = useMutation(api.posts.addComment);
  const powChallenge = useQuery(api.pow.getChallenge);
  const navigate = useNavigate();
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // A post attached to the comment, mirroring the DM share flow: the
  // composer shows a live preview and the comment carries the reference.
  const [sharingPostId, setSharingPostId] = useState<string | null>(null);
  // A recorded/attached voice note — uploaded to Cloudinary before the
  // comment is created, and the reference ships with addComment.
  const [audio, setAudio] = useState<CommentAudio | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Effective state: author lock or the auto-close policy (age/count).
  const locked = !!post.commentsClosed;
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
    if ((!text && !sharingPostId && !audio) || submitting || locked) return;
    setSubmitting(true);
    try {
      // Proof-of-work before the write — same scheme as posting/commenting.
      const pow = await solveChallenge(powChallenge);
      const res = await addComment({
        postId: post._id,
        content: text,
        ...(sharingPostId !== null
          ? { sharedPostId: sharingPostId as Id<"posts"> }
          : {}),
        ...(audio !== null ? { media: audio } : {}),
        powChallenge: pow.powChallenge,
        powNonce: pow.powNonce,
        powIssuedAt: pow.powIssuedAt,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not comment.");
        return;
      }
      setComment("");
      setSharingPostId(null);
      setAudio(null);
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
            {post.commentsAutoClosed
              ? `Comments are closed on this post — threads auto-close ${autoClosePolicyPhrase(
                  post.commentsAutoCloseAgeMs,
                  post.commentsAutoCloseCount,
                )}.`
              : "Comments are closed on this post."}
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
              {/* Record a voice note or attach an audio file — uploaded to
                  Cloudinary now, reference ships with the comment. */}
              <AudioCommentButton value={audio} onChange={setAudio} />
              {/* Attach a post to the comment — same live preview + send
                  flow as the DM composer, without leaving the popup. */}
              <SharedPostComposer
                value={sharingPostId}
                onChange={setSharingPostId}
                text={comment}
                onTextChange={setComment}
              />
              {/* The author (or an admin) is the one who can act on the
                  auto-close policy, so only they see the nearing hint. */}
              {post.author?._id === user?._id || user?.role === "admin" ? (
                <AutoCloseHint
                  commentCount={post.commentCount}
                  threshold={post.commentsAutoCloseCount}
                  ageMs={post.commentsAutoCloseAgeMs}
                  createdAt={post._creationTime}
                />
              ) : null}
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
          {/* The post's own engagement counts, shown in plain language like
              the comment hearts — this surface previously omitted them.
              Static (non-interactive): the post card behind is where you
              like and reply. */}
          <p className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Heart
                className={cn(
                  "size-3.5",
                  post.likedByMe && "fill-current text-primary",
                )}
              />
              {formatLikeLabel(post.likeCount)}
            </span>
            <span className="flex items-center gap-1">
              <MessageCircle className="size-3.5" />
              {formatPluralLabel(post.commentCount, "comment")}
            </span>
          </p>
          {post.content ? (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
              <RichText text={post.content} />
            </p>
          ) : null}
          {post.mediaUrls && post.mediaUrls.length > 0 ? (
            <PostMediaGrid
              media={post.mediaUrls}
              artwork={post.author?.avatarUrl ?? null}
            />
          ) : null}
        </div>

        {open && (
          <CommentPreview
            postId={post._id}
            viewerId={user?._id}
            postAuthorId={post.author?._id}
            powChallenge={powChallenge}
            onDeleted={onCommentDeleted}
          />
        )}

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
            disabled={
              submitting || locked || (!comment.trim() && !sharingPostId && !audio)
            }
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
