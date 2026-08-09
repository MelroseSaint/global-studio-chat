import {
  AudioLines,
  Heart,
  MessageCircle,
  Play,
  Repeat2,
  Share2,
  VideoOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { MetadataStrippedChip } from "@/components/MetadataStrippedChip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import {
  cloudinaryVideoUrl,
  responsiveImageAttrs,
} from "@/lib/cloudinary-media";
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

/**
 * A <video> that stops decoding when it scrolls out of view (or the tab
 * hides) and resumes where it left off when it comes back — an autoplaying
 * feed card must not keep chewing CPU/battery on frames a user can't see.
 * Playback state is preserved: a video the user manually paused stays
 * paused; one that was playing resumes on return. Resumes only while
 * autoplay is permitted (muted inline playback; a user-gesture-started
 * video on iOS resumes via the same gesture permission it already holds,
 * and a rejected play() just stays paused).
 *
 * When autoplay is disabled (iOS/cellular — see src/lib/video-autoplay.ts)
 * the card must not be a dark box: the component captures the video's
 * first frame client-side (hidden CORS element → canvas) and shows it as
 * the poster, plus a tap-to-play overlay. Tapping anywhere on the video
 * starts playback and hands over to the native controls.
 */
function AutoPauseVideo({
  src,
  className,
  autoPlay,
}: {
  src: string;
  className?: string;
  autoPlay?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  // A real poster frame for the no-autoplay case. Captured from a hidden
  // CORS element — Convex storage and Cloudinary both send
  // access-control-allow-origin — so no server-side thumbnail is needed.
  // If the capture is blocked (CORS/codec), the play overlay's gradient
  // still keeps the card from being a flat black box.
  const [poster, setPoster] = useState<string>();
  // True once the user tapped play (or autoplay started): the tap-to-play
  // overlay gives way to the native controls from then on.
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let wasPlaying = false;

    const pauseForViewer = () => {
      wasPlaying = !el.paused && !el.ended;
      el.pause();
    };
    const resumeIfWasPlaying = () => {
      if (wasPlaying && !el.ended) {
        void el.play().catch(() => {
          // Resume can be blocked (autoplay policy) — the video simply
          // stays paused; the user can tap play.
        });
      }
      wasPlaying = false;
    };

    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) resumeIfWasPlaying();
      else pauseForViewer();
    });
    io.observe(el);

    // A hidden tab is fully off-screen too.
    const onVisibility = () => {
      if (document.hidden) pauseForViewer();
      else resumeIfWasPlaying();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Capture the first frame for the poster when autoplay is disabled.
  useEffect(() => {
    if (autoPlay) return;
    let cancelled = false;
    const cap = document.createElement("video");
    cap.crossOrigin = "anonymous";
    cap.preload = "metadata";
    cap.muted = true;
    cap.playsInline = true;
    cap.src = src;

    const draw = () => {
      if (cancelled) return;
      try {
        const w = cap.videoWidth;
        const h = cap.videoHeight;
        if (w === 0 || h === 0) return;
        const scale = Math.min(1, 640 / w);
        const cw = Math.round(w * scale);
        const ch = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        if (ctx === null) return;
        ctx.drawImage(cap, 0, 0, cw, ch);
        setPoster(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        // Capture blocked (CORS or codec) — the play overlay's gradient
        // still gives the card something to look at.
      }
    };
    const seek = () => {
      if (cancelled) return;
      const t = Math.min(0.1, (cap.duration || 0) * 0.5);
      try {
        cap.currentTime = t;
      } catch {
        draw();
        return;
      }
      // If the seek never lands, capture the current frame anyway.
      window.setTimeout(draw, 1200);
    };
    cap.addEventListener("loadeddata", seek);
    cap.addEventListener("seeked", draw);
    return () => {
      cancelled = true;
      cap.removeEventListener("loadeddata", seek);
      cap.removeEventListener("seeked", draw);
      cap.removeAttribute("src");
      cap.load();
    };
  }, [autoPlay, src]);

  // The overlay anchors to the nearest positioned ancestor (the media
  // container), which is exactly the video's box — see the call sites.
  const showPlayOverlay = !autoPlay && !started;
  return (
    <>
      <video
        ref={ref}
        src={src}
        poster={poster}
        controls={autoPlay || started}
        autoPlay={autoPlay}
        muted={autoPlay}
        playsInline
        className={className}
        onPlay={() => setStarted(true)}
      />
      {showPlayOverlay ? (
        <button
          type="button"
          aria-label="Play video"
          onClick={() => {
            const v = ref.current;
            if (v !== null) {
              const p = v.play();
              if (p) p.catch(() => {});
            }
          }}
          className="absolute inset-0 flex cursor-pointer items-center justify-center border-0 bg-gradient-to-b from-black/5 to-black/30 p-0"
        >
          <span className="flex size-14 items-center justify-center rounded-full bg-white/90 text-black shadow-lg transition-transform hover:scale-105">
            <Play className="size-7 translate-x-0.5 fill-current" />
          </span>
        </button>
      ) : null}
    </>
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
          // Cloudinary images render responsively (srcSet of widths, auto
          // format/quality) — the CDN serves the right size per screen
          // instead of the original file; Convex-storage URLs pass through.
          <img
            {...responsiveImageAttrs(m.url, "(min-width: 640px) 640px, 100vw")}
            alt=""
            className="max-h-[480px] w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        )}
        {m.kind === "video" && m.url && (
          // Stop propagation so the player's own controls never trigger the
          // parent card's click-to-open navigation.
          <div onClick={(e) => e.stopPropagation()}>
            <AutoPauseVideo
              src={cloudinaryVideoUrl(m.url) ?? m.url}
              autoPlay={autoPlay}
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
            className="relative aspect-square overflow-hidden rounded-xl border bg-muted/40"
          >
            {m.kind === "image" && m.url ? (
              <img
                {...responsiveImageAttrs(m.url, "(min-width: 640px) 320px, 50vw")}
                alt=""
                className="size-full object-cover"
                loading="lazy"
                decoding="async"
              />
            ) : m.kind === "video" && m.url ? (
              <div onClick={(e) => e.stopPropagation()} className="size-full">
                <AutoPauseVideo
                  src={cloudinaryVideoUrl(m.url) ?? m.url}
                  autoPlay={autoPlay}
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
