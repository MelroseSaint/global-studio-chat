import { useMutation, usePaginatedQuery } from "convex/react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  MoreHorizontal,
  Pencil,
  Repeat2,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AudioCommentButton, type CommentAudio } from "@/components/AudioCommentButton";
import { VoiceNote } from "@/components/VoiceNote";
import { CommentLikeButton } from "@/components/CommentLikeButton";
import { ProfileTypeBadge } from "@/components/ProfileTypeBadge";
import { CommentShareDialog } from "@/components/CommentShareDialog";
import { SharedCommentEmbed } from "@/components/SharedCommentEmbed";
import { SharedPostCard } from "@/components/SharedPostCard";
import { SharedPostComposer } from "@/components/SharedPostComposer";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { formatPluralLabel, timeAgo } from "@/lib/format";
import { solveChallenge, type PowChallenge } from "@/lib/pow";

interface ReplyComment {
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
  likeCount: number;
  // A post shared into the reply — rendered as a preview card below the
  // text (the id is public metadata; see schema.ts).
  sharedPostId?: string;
  // Another comment shared into this reply — the comment-share mirror of
  // sharedPostId, rendered as a preview card below the text.
  sharedCommentId?: string;
  // A voice note attached to the reply.
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
 * Inline composer for replying to a comment. Shared by the post page and
 * the popup preview: proof-of-work gated addComment with the parent id,
 * identical to the top-level composer but scoped to the parent comment.
 */
export function CommentReplyComposer({
  postId,
  parentId,
  replyToName,
  powChallenge,
  onCancel,
  onPosted,
  autoFocus,
}: {
  postId: Id<"posts">;
  parentId: Id<"comments">;
  replyToName?: string | null;
  powChallenge?: PowChallenge;
  onCancel?: () => void;
  onPosted?: () => void;
  autoFocus?: boolean;
}) {
  const addComment = useMutation(api.posts.addComment);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  // A post attached to the reply, mirroring the top-level comment flow.
  const [sharingPostId, setSharingPostId] = useState<string | null>(null);
  // A recorded/attached voice note on the reply.
  const [audio, setAudio] = useState<CommentAudio | null>(null);

  const submit = async () => {
    const content = text.trim();
    if ((!content && !sharingPostId && !audio) || posting) return;
    setPosting(true);
    try {
      const pow = await solveChallenge(powChallenge);
      const res = await addComment({
        postId,
        parentId,
        content,
        ...(sharingPostId !== null
          ? { sharedPostId: sharingPostId as Id<"posts"> }
          : {}),
        ...(audio !== null ? { media: audio } : {}),
        powChallenge: pow.powChallenge,
        powNonce: pow.powNonce,
        powIssuedAt: pow.powIssuedAt,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not reply.");
        return;
      }
      setText("");
      setSharingPostId(null);
      setAudio(null);
      onPosted?.();
      toast.success("Reply posted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reply.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="flex items-end gap-1.5">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          replyToName ? `Reply to ${replyToName}…` : "Write a reply…"
        }
        rows={1}
        maxLength={500}
        autoFocus={autoFocus}
        className="min-h-9 resize-none text-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <SharedPostComposer
        value={sharingPostId}
        onChange={setSharingPostId}
        text={text}
        onTextChange={setText}
      />
      <AudioCommentButton value={audio} onChange={setAudio} />
      {onCancel ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onCancel}
          disabled={posting}
          aria-label="Cancel reply"
          className="size-8 shrink-0 rounded-full"
        >
          <X className="size-4" />
        </Button>
      ) : null}
      <Button
        size="icon"
        className="shrink-0 rounded-full"
        disabled={(!text.trim() && !sharingPostId && !audio) || posting}
        onClick={() => void submit()}
        aria-label="Post reply"
      >
        {posting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Send className="size-4" />
        )}
      </Button>
    </div>
  );
}

/**
 * The threaded replies hanging under one top-level comment: a collapsible
 * \"View N replies\" toggle (powered by the denormalized replyCount), a
 * paginated newest-first list, and per-reply like/edit/delete plus a Reply
 * composer. Replies to a reply are re-rooted to this comment server-side,
 * so the tree stays one level deep. Mounted under every comment on the post
 * page and in the popup preview.
 */
export function CommentReplies({
  postId,
  parentId,
  replyCount,
  viewerId,
  // The post's author — they can delete replies on their post too.
  postAuthorId,
  powChallenge,
}: {
  postId: Id<"posts">;
  parentId: Id<"comments">;
  replyCount: number;
  viewerId?: string;
  postAuthorId?: string;
  powChallenge?: PowChallenge;
}) {
  const [open, setOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  // Which reply is being shared (opens CommentShareDialog, preselected).
  const [shareTarget, setShareTarget] = useState<string | null>(null);
  const editComment = useMutation(api.posts.editComment);
  const deleteComment = useMutation(api.posts.deleteComment);
  // Only run the replies query while the section is expanded.
  const { results, status, loadMore } = usePaginatedQuery(
    api.posts.listReplies,
    open ? { postId, parentId, sort: "newest" } : "skip",
    { initialNumItems: 5 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(5);
    }
  }, [inView, status, loadMore]);

  if (replyCount <= 0) return null;
  const replies = results as unknown as ReplyComment[];

  const handleDelete = async (c: ReplyComment) => {
    if (busy) return;
    if (!window.confirm("Delete this reply? This cannot be undone.")) return;
    setBusy(true);
    try {
      await deleteComment({ commentId: c._id as Id<"comments"> });
      if (editingId === c._id) setEditingId(null);
      if (replyingTo?.id === c._id) setReplyingTo(null);
      toast.success("Reply deleted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete reply.");
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
        toast.error(res.error ?? "Could not edit reply.");
        return;
      }
      setEditingId(null);
      toast.success("Reply updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not edit reply.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
      >
        {open ? (
          <ChevronUp className="size-3.5" />
        ) : (
          <ChevronDown className="size-3.5" />
        )}
        {open
          ? "Hide replies"
          : `View ${formatPluralLabel(replyCount, "reply")}`}
      </button>
      {open ? (
        <div className="mt-2 space-y-2.5 border-l-2 border-muted pl-3">
          {replies.map((r) => {
            const isMine = r.author?._id === viewerId;
            // Post author moderating their own thread: delete only, no edit.
            const canModerate =
              !isMine && postAuthorId !== undefined && postAuthorId === viewerId;
            return (
              <div key={r._id} className="flex gap-2">
                <UserAvatar user={r.author} className="size-7" />
                <div className="min-w-0 flex-1">
                  {editingId === r._id ? (
                    <div className="rounded-2xl rounded-tl-sm bg-muted/40 px-3 py-2">
                      <Textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={2}
                        maxLength={500}
                        className="min-h-9 resize-none bg-background text-sm"
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
                          ) : (
                            <Pencil className="size-3.5" />
                          )}
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="group rounded-2xl rounded-tl-sm bg-muted/40 px-3 py-2">
                      <div className="flex items-start justify-between gap-1">
                        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
                          <span className="font-semibold">
                            {r.author?.name ||
                              r.author?.username ||
                              "Unknown"}
                          </span>
                          <ProfileTypeBadge
                            profileType={r.author?.profileType}
                            className="shrink-0"
                          />
                          <span className="text-[11px] text-muted-foreground">
                            {timeAgo(r._creationTime)}
                            {r.editedAt ? " · edited" : ""}
                          </span>
                        </p>
                        {isMine || canModerate ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Reply actions"
                                className="size-6 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 max-sm:opacity-100"
                              >
                                <MoreHorizontal className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {isMine && (
                                <DropdownMenuItem
                                  onClick={() => {
                                    setEditingId(r._id);
                                    setEditText(r.content);
                                  }}
                                >
                                  <Pencil className="size-4" />
                                  Edit
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => void handleDelete(r)}
                              >
                                <Trash2 className="size-4 text-destructive" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
                        {r.content}
                      </p>
                      {r.media?.url ? (
                        <VoiceNote
                          media={r.media}
                          trackId={`comment:${r.media.key ?? r._id}`}
                        />
                      ) : null}
                      {r.sharedPostId ? (
                        <SharedPostCard postId={r.sharedPostId} />
                      ) : null}
                      {r.sharedCommentId ? (
                        <SharedCommentEmbed commentId={r.sharedCommentId} />
                      ) : null}
                      <div className="mt-1 flex items-center gap-3">
                        <CommentLikeButton
                          commentId={r._id as Id<"comments">}
                          likedByMe={r.likedByMe}
                          likeCount={r.likeCount}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setReplyingTo({
                              id: r._id,
                              name:
                                r.author?.name ||
                                r.author?.username ||
                                "them",
                            })
                          }
                          className="text-xs font-semibold text-muted-foreground transition-colors hover:text-primary"
                        >
                          Reply
                        </button>
                        <button
                          type="button"
                          onClick={() => setShareTarget(r._id)}
                          className="flex items-center gap-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-primary"
                        >
                          <Repeat2 className="size-3" />
                          Share
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {replyingTo ? (
            <div className="flex gap-2 pl-1">
              <CommentReplyComposer
                postId={postId}
                parentId={parentId}
                replyToName={replyingTo.name}
                powChallenge={powChallenge}
                onCancel={() => setReplyingTo(null)}
                onPosted={() => setReplyingTo(null)}
                autoFocus
              />
            </div>
          ) : null}
          <div ref={ref} className="flex justify-center py-1">
            {status === "LoadingMore" ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        </div>
      ) : null}
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
