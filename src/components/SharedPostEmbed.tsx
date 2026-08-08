import {
  AudioLines,
  Heart,
  MessageCircle,
  Repeat2,
  Share2,
  VideoOff,
} from "lucide-react";
import { Link, useNavigate } from "react-router";

import { MetadataStrippedChip } from "@/components/MetadataStrippedChip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { formatCount, timeAgo } from "@/lib/format";

import type { PostItem, PostMedia } from "./PostCard";

/**
 * Render @mentions and URLs inside post text. Clicking a mention (or a
 * link) stops propagation so an embedded shared-post card doesn't double-
 * navigate when the whole card is clickable.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9_]{3,24}|\bhttps?:\/\/[^\s]+)/gi);
  return (
    <>
      {parts.map((part, i) => {
        if (/^@[a-z0-9_]{3,24}$/i.test(part)) {
          return (
            <Link
              key={i}
              to={`/u/${part.slice(1).toLowerCase()}`}
              onClick={(e) => e.stopPropagation()}
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
              onClick={(e) => e.stopPropagation()}
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

/**
 * The tiny "Autoplay off" note shown over video media when the
 * device-aware policy disabled autoplay (off by default on iOS/cellular
 * — see src/lib/video-autoplay.ts). Tells the viewer the video isn't
 * broken, it just waits for a tap. Same overlay discipline as
 * MetadataStrippedChip: pointer-events-none so it never swallows clicks
 * on the player controls; the tooltip explains the policy on hover.
 */
function AutoplayOffChip() {
  return (
    <div className="pointer-events-none absolute right-2 top-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm"
            aria-label="Autoplay is off — tap the video to play it"
          >
            <VideoOff className="size-3" />
            Autoplay off
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          Videos don&apos;t play automatically on this device or connection.
          Tap the video to play it.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The media grid of a post, shown inside the post and inside shares. */
export function PostMediaGrid({
  media,
  autoPlay = false,
}: {
  media: PostMedia[];
  /** Autoplay muted video (used inside DM shared-post previews). */
  autoPlay?: boolean;
}) {
  if (media.length === 0) return null;
  // Any attached photo/video had GPS/device metadata removed before
  // upload — a tiny chip on the media tells viewers it was scrubbed.
  const anyStripped = media.some((m) => m.stripped === true);

  const strippedChip = anyStripped ? <MetadataStrippedChip /> : null;
  // When the policy disabled autoplay, tell the viewer the video waits for
  // a tap instead of looking broken. Shown on shared-post previews AND
  // feed cards (the policy is platform-wide).
  const autoplayOffChip =
    !autoPlay && media.some((m) => m.kind === "video") ? (
      <AutoplayOffChip />
    ) : null;

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
          // Stop propagation so the player's own controls never trigger the
          // parent card's click-to-open navigation.
          <div onClick={(e) => e.stopPropagation()}>
            <video
              src={m.url}
              controls
              autoPlay={autoPlay}
              muted={autoPlay}
              playsInline={autoPlay}
              className="max-h-[480px] w-full"
            />
          </div>
        )}
        {m.kind === "audio" && m.url && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-2 p-4"
          >
            <AudioLines className="size-5 shrink-0 text-primary" />
            <audio src={m.url} controls className="w-full" />
          </div>
        )}
        {autoplayOffChip}
        {strippedChip}
      </div>
    );
  }
  return (
    <div className="relative mt-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {media.map((m, i) => (
          <div
            key={i}
            className="aspect-square overflow-hidden rounded-xl border bg-muted/40"
          >
            {m.kind === "image" && m.url ? (
              <img src={m.url} alt="" className="size-full object-cover" loading="lazy" />
            ) : m.kind === "video" && m.url ? (
              <div onClick={(e) => e.stopPropagation()} className="size-full">
                <video
                  src={m.url}
                  controls
                  autoPlay={autoPlay}
                  muted={autoPlay}
                  playsInline={autoPlay}
                  className="size-full object-cover"
                />
              </div>
            ) : (
              <div className="flex size-full items-center justify-center">
                <AudioLines className="size-6 text-primary" />
              </div>
            )}
          </div>
        ))}
      </div>
      {autoplayOffChip}
      {strippedChip}
    </div>
  );
}

/**
 * The compact Facebook-style card of an original post embedded inside a
 * share: author header, text, the full media, and engagement counts.
 * Clicking the card opens the original post.
 */
export function SharedPostEmbed({
  post,
  autoPlayMedia = false,
}: {
  post: PostItem;
  /** Autoplay muted video in the embedded media (DM previews). */
  autoPlayMedia?: boolean;
}) {
  const navigate = useNavigate();
  const author = post.author;
  const authorUsername = author?.username;
  return (
    <div
      onClick={() => navigate(`/post/${post._id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/post/${post._id}`);
        }
      }}
      role="link"
      tabIndex={0}
      className="cursor-pointer overflow-hidden rounded-xl border bg-muted/30 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        {authorUsername ? (
          <Link
            to={`/u/${authorUsername}`}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0"
          >
            <UserAvatar user={author} className="size-6" />
          </Link>
        ) : (
          <span className="shrink-0">
            <UserAvatar user={author} className="size-6" />
          </span>
        )}
        <div className="min-w-0 text-xs">
          <span className="flex min-w-0 items-center gap-1">
            {authorUsername ? (
              <Link
                to={`/u/${authorUsername}`}
                onClick={(e) => e.stopPropagation()}
                className="truncate font-semibold hover:underline"
              >
                {author?.name ?? author?.username ?? "Unknown"}
              </Link>
            ) : (
              <span className="truncate font-semibold">
                {author?.name ?? "Unknown"}
              </span>
            )}
            {author?.verified ? <VerifiedBadge className="shrink-0" /> : null}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
            <span className="truncate">@{author?.username}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{timeAgo(post._creationTime)}</span>
          </span>
        </div>
      </div>

      {post.content ? (
        <p className="mt-1.5 whitespace-pre-wrap break-words px-3 text-sm leading-relaxed">
          <RichText text={post.content} />
        </p>
      ) : null}

      {post.mediaUrls && post.mediaUrls.length > 0 ? (
        <PostMediaGrid media={post.mediaUrls} autoPlay={autoPlayMedia} />
      ) : null}

      <div className="mt-2 flex items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Heart className="size-3.5" />
          {formatCount(post.likeCount)}
        </span>
        <span className="flex items-center gap-1">
          <MessageCircle className="size-3.5" />
          {formatCount(post.commentCount)}
        </span>
        <span className="flex items-center gap-1">
          <Share2 className="size-3.5" />
          {formatCount(post.shareCount)}
        </span>
        <span className="ml-auto flex items-center gap-1 font-medium text-primary">
          <Repeat2 className="size-3.5" />
          View post
        </span>
      </div>
    </div>
  );
}
