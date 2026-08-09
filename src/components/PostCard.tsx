import { useMutation } from "convex/react";
import {
  AtSign,
  BadgeCheck,
  Flag,
  Heart,
  Hourglass,
  Link2,
  Lock,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Repeat2,
  ScanSearch,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CommentDialog } from "@/components/CommentDialog";
import { LinkCard } from "@/components/LinkCard";
import { MessageDialog } from "@/components/MessageDialog";
import { ReportDialog } from "@/components/ReportDialog";
import { ShareDialog } from "@/components/ShareDialog";
import {
  PostMediaGrid,
  RichText,
  SharedPostEmbed,
} from "@/components/SharedPostEmbed";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { useVideoAutoplay } from "@/lib/video-autoplay";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { aiReportTicketArgs } from "@/lib/ai-report";
import { extractFirstUrl, formatCount, postUrl, timeAgo } from "@/lib/format";
import { phishingTicketArgs } from "@/lib/phishing-report";
import { cn } from "@/lib/utils";

export interface PostMedia {
  storageId: Id<"_storage">;
  kind: "image" | "video" | "audio";
  url: string | null;
  // True when GPS/device metadata was removed before upload (client
  // re-encode or server-side remux) — shows the "Metadata stripped" chip.
  stripped?: boolean | null;
}

interface PostAuthor {
  _id: Id<"users">;
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  image?: string | null;
  verified?: boolean | null;
  role?: string | null;
}

export interface PostItem {
  _id: Id<"posts">;
  _creationTime: number;
  authorId: Id<"users">;
  content: string;
  media?: {
    storageId: Id<"_storage">;
    kind: "image" | "video" | "audio";
    stripped?: boolean | null;
  }[] | null;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  // When set, this post is a SHARE: `sharedFrom` is the original post
  // (with its media) embedded beneath the caption. Null means the original
  // was deleted, or is hidden from this viewer (blocked/banned/silenced).
  sharedFromId?: Id<"posts"> | null;
  sharedFrom?: PostItem | null;
  // Users explicitly tagged in the content (resolved from @mentions at
  // creation), so the card can show a "with @alice" line beneath it.
  taggedUsers?:
    | {
        _id: Id<"users">;
        username: string | null;
        name: string | null;
        avatarUrl: string | null;
      }[]
    | null;
  commentsLocked?: boolean | null;
  // Effective thread state, computed server-side (see posts.ts): closed
  // when the author locked it OR the auto-close policy closed it, and
  // autoClosed when the policy (not the author) is what closed it.
  commentsClosed?: boolean | null;
  commentsAutoClosed?: boolean | null;
  // The auto-close policy's thresholds (server-owned constants).
  commentsAutoCloseCount?: number | null;
  commentsAutoCloseAgeMs?: number | null;
  // The author's per-post opt-out of the auto-close policy.
  autoCloseComments?: boolean | null;
  originalityVerified?: boolean | null;
  likedByMe: boolean;
  mediaUrls?: PostMedia[] | null;
  author: PostAuthor | null;
  // Coordinates never reach clients — only the public label ships.
  location?: { label?: string } | null;
  // Anti-AI review: "review" means a human is checking this post before it
  // goes public. Only the author (and admins) can see their own review
  // posts; the reason below is the signal list that tripped the scan.
  aiStatus?: string | null;
  aiStatusReason?: string | null;
  // Content Credentials (C2PA): true when the server verified that an
  // attached item's manifest declared a camera capture — the file's own
  // provenance, shown as a "Content Credentials verified" label.
  c2paVerifiedHuman?: boolean | null;
  // The creator's own declaration during upload: how the work was made.
  // "ai-assisted" gets a visible disclosure chip; "ai-generated" is
  // rejected at createPost and can never appear here.
  creatorDisclosure?: string | null;
}

export function PostCard({
  post,
  showComments = false,
}: {
  post: PostItem;
  showComments?: boolean;
}) {
  const { user: me } = useAuth();
  const navigate = useNavigate();
  // Inline feed videos follow the platform-wide device-aware autoplay
  // policy (same as shared-post previews): muted autoplay on desktop/Wi-Fi,
  // off by default on iOS/cellular, user-overridable in Settings.
  const { autoplay } = useVideoAutoplay();
  const likePost = useMutation(api.posts.likePost);
  const unlikePost = useMutation(api.posts.unlikePost);
  const deletePost = useMutation(api.posts.deletePost);
  const setCommentsLocked = useMutation(api.posts.setCommentsLocked);
  const setAutoCloseComments = useMutation(api.posts.setAutoCloseComments);
  const createTicket = useMutation(api.support.createTicket);

  const [liked, setLiked] = useState(post.likedByMe);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [commentCount, setCommentCount] = useState(post.commentCount);
  const [shareCount, setShareCount] = useState(post.shareCount);
  const [commentOpen, setCommentOpen] = useState(false);

  // Remember the last (post, server-count) pair we adopted so we can tell
  // when the query catches up — or the card moves to a different post. On
  // either, adopt the server value: it already includes anything this
  // card's popup posted/deleted optimistically, so the badge never
  // double-counts and never carries a stale optimistic bump into the next
  // post. Derived-state-during-render, the React-endorsed way to sync
  // state from a changing prop.
  const serverKey = `${post._id}:${post.commentCount}`;
  const [lastServerKey, setLastServerKey] = useState(serverKey);
  if (serverKey !== lastServerKey) {
    setLastServerKey(serverKey);
    setCommentCount(post.commentCount);
  }
  const [reportOpen, setReportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // The popup DM composer: opened by ShareDialog's "Send via message" so
  // sharing a post privately never redirects to /messages.
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageShareId, setMessageShareId] = useState<string | null>(null);
  const [reportingPhish, setReportingPhish] = useState(false);
  const [reportingAi, setReportingAi] = useState(false);
  const [busy, setBusy] = useState(false);

  const isMine = me?._id === post.authorId;
  const isAdmin = me?.role === "admin";

  const toggleLike = async () => {
    if (busy) return;
    setBusy(true);
    const next = !liked;
    setLiked(next);
    setLikeCount((c) => Math.max(0, c + (next ? 1 : -1)));
    try {
      if (next) await likePost({ postId: post._id });
      else await unlikePost({ postId: post._id });
    } catch {
      setLiked(!next);
      setLikeCount((c) => Math.max(0, c + (!next ? 1 : -1)));
      toast.error("Could not update like.");
    } finally {
      setBusy(false);
    }
  };

  // Copy the direct link to the post — the lightweight alternative to a
  // full share (no new post is created, so the share count is untouched).
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(postUrl(post._id));
      toast.success("Link copied to clipboard.");
    } catch {
      toast.error("Could not copy link.");
    }
  };

  // Author control: lock (or reopen) the comment thread on this post.
  // When the AUTO-CLOSE policy closed the thread (nobody locked it),
  // "reopen" means opting the post out of auto-close — the only lever that
  // opens it back up.
  const handleLockComments = async () => {
    try {
      if (post.commentsAutoClosed) {
        await setAutoCloseComments({ postId: post._id, keepOpen: true });
        toast.success("Comments reopened — this post stays open.");
        return;
      }
      await setCommentsLocked({
        postId: post._id,
        locked: !post.commentsLocked,
      });
      toast.success(
        post.commentsLocked
          ? "Comments reopened."
          : "Comments closed — no new replies.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    }
  };

  // Author control: the per-post opt-out of the auto-close policy.
  const handleAutoCloseComments = async () => {
    try {
      const keepOpen = !post.autoCloseComments;
      await setAutoCloseComments({ postId: post._id, keepOpen });
      toast.success(
        keepOpen
          ? "Comments stay open on this post."
          : "Auto-close comments enabled again.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this post? This cannot be undone.")) return;
    try {
      await deletePost({ postId: post._id });
      toast.success("Post deleted.");
      navigate("/home", { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete post.");
    }
  };

  // One-tap AI report: files a ticket pre-attached to this post, the
  // author, and the "No AI-generated content" Standard principle. Members
  // are the human net on top of the automated scanner — this is how they
  // flag what the scanner missed, with one click and no form.
  const reportAi = async () => {
    if (reportingAi) return;
    setReportingAi(true);
    try {
      await createTicket(
        aiReportTicketArgs({
          postId: post._id,
          offenderId: post.authorId,
          content: post.content,
          kind: "post",
        }),
      );
      toast.success("AI-content report sent — our team will review it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send report.");
    } finally {
      setReportingAi(false);
    }
  };

  // One-tap phishing report: files a ticket pre-attached to this post, the
  // author, and the "No scams or phishing" Standard principle — no form, no
  // explaining the situation. The subject/message come from the shared
  // helper so the post and comment menus file identical tickets.
  const reportPhishing = async () => {
    if (reportingPhish) return;
    setReportingPhish(true);
    try {
      await createTicket(
        phishingTicketArgs({
          postId: post._id,
          offenderId: post.authorId,
          content: post.content,
          kind: "post",
        }),
      );
      toast.success("Phishing report sent — our team will review it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send report.");
    } finally {
      setReportingPhish(false);
    }
  };

  const linkUrl = extractFirstUrl(post.content);

  const authorUsername = post.author?.username;

  return (
    <article className="group flex gap-3 border-b px-4 py-4 transition-colors hover:bg-muted/25 sm:px-5">
      {authorUsername ? (
        <Link to={`/u/${authorUsername}`} className="shrink-0">
          <UserAvatar user={post.author} className="size-11" />
        </Link>
      ) : (
        <span className="shrink-0">
          <UserAvatar user={post.author} className="size-11" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-sm">
            {authorUsername ? (
              <Link
                to={`/u/${authorUsername}`}
                className="truncate font-semibold hover:underline"
              >
                {post.author?.name ?? post.author?.username ?? "Unknown"}
              </Link>
            ) : (
              <span className="truncate font-semibold">
                {post.author?.name ?? "Unknown"}
              </span>
            )}
            {post.author?.verified ? (
              <VerifiedBadge className="shrink-0" />
            ) : null}
            <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
              <span className="truncate">@{post.author?.username}</span>
              <span className="shrink-0">·</span>
              <span className="shrink-0">{timeAgo(post._creationTime)}</span>
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 max-sm:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(isMine || isAdmin) && (
                <>
                  <DropdownMenuItem onClick={() => void handleLockComments()}>
                    <Lock className="size-4" />
                    {post.commentsClosed
                      ? "Reopen comments"
                      : "Close comments"}
                  </DropdownMenuItem>
                  {/* The auto-close opt-out — hidden while the author has
                      manually locked the thread (that's the Lock item's
                      domain). On an auto-closed thread this is how the
                      author reopens it for good. */}
                  {!post.commentsLocked && (
                    <DropdownMenuItem
                      onClick={() => void handleAutoCloseComments()}
                    >
                      <Hourglass className="size-4" />
                      {post.autoCloseComments
                        ? "Auto-close comments"
                        : "Keep comments open"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => void handleDelete()}>
                    <Trash2 className="size-4 text-destructive" />
                    Delete post
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
              <DropdownMenuItem onClick={() => setReportOpen(true)}>
                <Flag className="size-4" />
                Report post
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-1 flex items-start gap-2">
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[15px] leading-relaxed">
            <RichText text={post.content} />
          </p>
          {post.originalityVerified ? (
            <span
              className="mt-0.5 flex shrink-0 items-center gap-1 rounded-full border border-moss/40 bg-moss/15 px-2 py-0.5 text-[11px] font-semibold text-moss dark:text-moss-light"
              title="Verified original content — this post passed PureWire's originality check."
            >
              <BadgeCheck className="size-3" />
              Original
            </span>
          ) : null}
          {post.c2paVerifiedHuman ? (
            <span
              className="mt-0.5 flex shrink-0 items-center gap-1 rounded-full border border-copper/40 bg-copper/15 px-2 py-0.5 text-[11px] font-semibold text-copper"
              title="Content Credentials verified — the attached media's C2PA manifest declares it was captured by a camera, not generated."
            >
              <ShieldCheck className="size-3" />
              Content Credentials verified
            </span>
          ) : null}
          {post.creatorDisclosure === "ai-assisted" ? (
            <span
              className="mt-0.5 flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400"
              title="The creator disclosed AI tools were used — this work is primarily human-made with AI assistance."
            >
              <Pencil className="size-3" />
              AI-assisted
            </span>
          ) : null}
        </div>

        {isMine && post.aiStatus === "review" ? (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-oxide/30 bg-oxide/5 px-3 py-2 text-xs text-oxide dark:text-oxide-light">
            <ScanSearch className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <b>Under human review.</b> A real person is checking this post
              before it goes public.
              {post.aiStatusReason ? (
                <span className="mt-0.5 block text-[11px] opacity-80">
                  Flagged because:{" "}
                  {post.aiStatusReason.replace(
                    /[—–]\s*flagged for a human check\.?\s*$/i,
                    "",
                  )}
                </span>
              ) : null}
            </span>
          </p>
        ) : null}

        {post.mediaUrls && post.mediaUrls.length > 0 ? (
          <PostMediaGrid media={post.mediaUrls} autoPlay={autoplay} />
        ) : linkUrl ? (
          <LinkCard url={linkUrl} />
        ) : null}

        {post.location?.label ? (
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="size-3.5" />
            {post.location.label}
          </p>
        ) : null}

        {post.taggedUsers && post.taggedUsers.length > 0 ? (
          <p className="mt-2 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <AtSign className="size-3.5 shrink-0" />
            <span>
              with{" "}
              {post.taggedUsers.map((t, i) => (
                <span key={t._id}>
                  {i > 0 ? ", " : null}
                  {t.username ? (
                    <Link
                      to={`/u/${t.username}`}
                      className="font-medium text-primary hover:underline"
                    >
                      @{t.username}
                    </Link>
                  ) : (
                    <span className="font-medium text-primary">
                      @{t.name ?? "unknown"}
                    </span>
                  )}
                </span>
              ))}
            </span>
          </p>
        ) : null}

        {post.sharedFromId ? (
          <div className="mt-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Repeat2 className="size-3.5 shrink-0" />
              <span>
                {post.sharedFrom
                  ? `Shared ${post.sharedFrom.author?.name ?? (post.sharedFrom.author?.username ? `@${post.sharedFrom.author.username}` : "a post")}'s post`
                  : "Shared a post that is no longer available"}
              </span>
            </p>
            {post.sharedFrom ? (
              <SharedPostEmbed post={post.sharedFrom} />
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 flex max-w-sm items-center justify-between text-muted-foreground">
          <button
            onClick={() => void toggleLike()}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary",
              liked && "text-primary",
            )}
          >
            <Heart
              className={cn("size-[18px]", liked && "fill-current")}
            />
            <span>{formatCount(likeCount)}</span>
          </button>

          <button
            onClick={() => setCommentOpen(true)}
            aria-label="Comment on this post"
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <MessageCircle className="size-[18px]" />
            <span>{formatCount(commentCount)}</span>
          </button>

          <Link
            to={`/post/${post._id}`}
            className="rounded-full px-2 py-1 text-xs font-medium text-muted-foreground/80 transition-colors hover:bg-primary/10 hover:text-primary hover:underline"
          >
            View comments
          </Link>

          <button
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <Share2 className="size-[18px]" />
            <span>{formatCount(shareCount)}</span>
          </button>

          {showComments && (
            <button
              onClick={() => setCommentOpen(true)}
              className="flex items-center gap-1.5 rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <Pencil className="size-[18px]" />
              <span>Reply</span>
            </button>
          )}

          <button
            onClick={() => void copyLink()}
            className="hidden rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary sm:flex"
            aria-label="Copy link"
          >
            <Link2 className="size-[18px]" />
          </button>
        </div>
      </div>

      <CommentDialog
        post={post}
        open={commentOpen}
        onOpenChange={setCommentOpen}
        onCommented={() => setCommentCount((c) => c + 1)}
        onCommentDeleted={() => setCommentCount((c) => Math.max(0, c - 1))}
      />

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        postId={post._id}
        offenderId={post.authorId}
        offenderUsername={post.author?.username ?? null}
      />

      <ShareDialog
        post={post}
        open={shareOpen}
        onOpenChange={setShareOpen}
        onShared={() => setShareCount((c) => c + 1)}
        onSendViaMessage={(postId) => {
          setMessageShareId(postId);
          setMessageOpen(true);
        }}
      />

      <MessageDialog
        open={messageOpen}
        onOpenChange={setMessageOpen}
        sharePostId={messageShareId}
        onSent={() => setMessageShareId(null)}
      />
    </article>
  );
}
