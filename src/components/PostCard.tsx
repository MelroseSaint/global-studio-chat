import { useMutation } from "convex/react";
import {
  AudioLines,
  BadgeCheck,
  Flag,
  Heart,
  Link2,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  ScanSearch,
  Share2,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LinkCard } from "@/components/LinkCard";
import { MetadataStrippedChip } from "@/components/MetadataStrippedChip";
import { ReportDialog } from "@/components/ReportDialog";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { extractFirstUrl, formatCount, postUrl, timeAgo } from "@/lib/format";
import { phishingTicketArgs } from "@/lib/phishing-report";
import { cn } from "@/lib/utils";

interface PostMedia {
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
}

/** Render @mentions and URLs inside post text. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9_]{3,24}|\bhttps?:\/\/[^\s]+)/gi);
  return (
    <>
      {parts.map((part, i) => {
        if (/^@[a-z0-9_]{3,24}$/i.test(part)) {
          return (
            <Link
              key={i}
              to={`/u/${part.slice(1).toLowerCase()}`}
              className="font-medium text-primary hover:underline"
            >
              {part}
            </Link>
          );
        }
        if (/^https?:\/\//i.test(part)) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {part}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function PostMediaGrid({
  media,
}: {
  media: PostMedia[];
}) {
  if (media.length === 0) return null;
  // Any attached photo/video had GPS/device metadata removed before
  // upload — a tiny chip on the media tells viewers it was scrubbed.
  const anyStripped = media.some((m) => m.stripped === true);

  const strippedChip = anyStripped ? <MetadataStrippedChip /> : null;

  if (media.length === 1) {
    const m = media[0];
    return (
      <div className="relative mt-3 overflow-hidden rounded-xl border bg-muted/40">
        {m.kind === "image" && m.url && (
          <img
            src={m.url}
            alt=""
            className="max-h-[480px] w-full object-cover"
            loading="lazy"
          />
        )}
        {m.kind === "video" && m.url && (
          <video src={m.url} controls className="max-h-[480px] w-full" />
        )}
        {m.kind === "audio" && m.url && (
          <div className="flex items-center gap-2 p-4">
            <AudioLines className="size-5 shrink-0 text-primary" />
            <audio src={m.url} controls className="w-full" />
          </div>
        )}
        {strippedChip}
      </div>
    );
  }
  return (
    <div className="relative mt-3">
      <div className="grid grid-cols-2 gap-2">
        {media.map((m, i) => (
          <div
            key={i}
            className="aspect-square overflow-hidden rounded-xl border bg-muted/40"
          >
            {m.kind === "image" && m.url ? (
              <img src={m.url} alt="" className="size-full object-cover" loading="lazy" />
            ) : m.kind === "video" && m.url ? (
              <video src={m.url} controls className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center">
                <AudioLines className="size-6 text-primary" />
              </div>
            )}
          </div>
        ))}
      </div>
      {strippedChip}
    </div>
  );
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
  const likePost = useMutation(api.posts.likePost);
  const unlikePost = useMutation(api.posts.unlikePost);
  const sharePost = useMutation(api.posts.sharePost);
  const deletePost = useMutation(api.posts.deletePost);
  const createTicket = useMutation(api.support.createTicket);

  const [liked, setLiked] = useState(post.likedByMe);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [shareCount, setShareCount] = useState(post.shareCount);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportingPhish, setReportingPhish] = useState(false);
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

  const handleShare = async () => {
    const url = postUrl(post._id);
    try {
      await sharePost({ postId: post._id });
      setShareCount((c) => c + 1);
    } catch {
      // silent — share tracking is best-effort
    }
    const shareData = {
      title: `${post.author?.name ?? post.author?.username ?? "PureWire"} on PureWire`,
      text: post.content.slice(0, 120),
      url,
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        // fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard.");
    } catch {
      toast.error("Could not copy link.");
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
        <div className="flex items-center justify-between gap-2">
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
                  <DropdownMenuItem onClick={() => void handleDelete()}>
                    <Trash2 className="size-4 text-destructive" />
                    Delete post
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
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
          <PostMediaGrid media={post.mediaUrls} />
        ) : linkUrl ? (
          <LinkCard url={linkUrl} />
        ) : null}

        {post.location?.label ? (
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="size-3.5" />
            {post.location.label}
          </p>
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
            onClick={() => navigate(`/post/${post._id}`)}
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <MessageCircle className="size-[18px]" />
            <span>{formatCount(post.commentCount)}</span>
          </button>

          <button
            onClick={() => void handleShare()}
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <Share2 className="size-[18px]" />
            <span>{formatCount(shareCount)}</span>
          </button>

          {showComments && (
            <Link
              to={`/post/${post._id}`}
              className="flex items-center gap-1.5 rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <Pencil className="size-[18px]" />
              <span>Reply</span>
            </Link>
          )}

          <button
            onClick={() => void handleShare()}
            className="hidden rounded-full px-2 py-1 text-sm transition-colors hover:bg-primary/10 hover:text-primary sm:flex"
            aria-label="Copy link"
          >
            <Link2 className="size-[18px]" />
          </button>
        </div>
      </div>

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        postId={post._id}
        offenderId={post.authorId}
        offenderUsername={post.author?.username ?? null}
      />
    </article>
  );
}
