import {
  AlertCircle,
  Loader2,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * mm:ss duration label — plain and compact, matching the muted
 * tabular-nums time stamps used across the feed.
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/**
 * The PureWire audio player — a custom control bar that speaks the same
 * visual language as the rest of the platform instead of the browser's
 * default `<audio controls>` widget: Wire Black / Paper text, an Oxide
 * primary play button, the platform's muted surfaces, lucide icons and
 * the standard rounded border treatment.
 *
 * Variants adapt the player to the surface it sits on:
 *   default — a self-contained control card (DM bubbles, standalone use)
 *   bare    — no card chrome, for media already inside a card (posts)
 *   story   — translucent white on the black story viewer
 *   primary — translucent Paper on the author's red DM bubble
 *
 * The scrubber is a styled `<input type="range">` (see .pw-audio-range in
 * index.css): the filled portion is painted Oxide red as a gradient on
 * the input's own background, and the thumb is a Paper dot ringed in
 * Oxide — the same palette the feed's media cards use.
 */
export function AudioPlayer({
  src,
  variant = "default",
  className,
}: {
  src: string;
  variant?: "default" | "bare" | "story" | "primary";
  className?: string;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  // Buffering between play and actually producing sound (network stall,
  // slow decode) — shows a spinner in the play button.
  const [waiting, setWaiting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onTime = () => setCurrent(el.currentTime);
    const onDuration = () => {
      if (Number.isFinite(el.duration)) setDuration(el.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrent(0);
    };
    const onWaiting = () => setWaiting(true);
    const onCanPlay = () => setWaiting(false);
    const onPlaying = () => setWaiting(false);
    const onVolume = () => setMuted(el.muted || el.volume === 0);
    const onLoadStart = () => {
      setErrored(false);
      setWaiting(false);
    };
    const onError = () => setErrored(true);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("durationchange", onDuration);
    el.addEventListener("loadedmetadata", onDuration);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("volumechange", onVolume);
    el.addEventListener("loadstart", onLoadStart);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("durationchange", onDuration);
      el.removeEventListener("loadedmetadata", onDuration);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("volumechange", onVolume);
      el.removeEventListener("loadstart", onLoadStart);
      el.removeEventListener("error", onError);
    };
  }, []);

  const togglePlay = () => {
    const el = ref.current;
    if (el === null) return;
    if (el.paused) {
      void el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  };

  const toggleMute = () => {
    const el = ref.current;
    if (el === null) return;
    el.muted = !el.muted;
  };

  const seek = (value: number) => {
    const el = ref.current;
    if (el === null || !Number.isFinite(el.duration)) return;
    el.currentTime = value;
    setCurrent(value);
  };

  const v = VARIANTS[variant];
  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const playIcon = waiting ? (
    <Loader2 className="size-4 animate-spin" />
  ) : playing ? (
    <Pause className="size-4" />
  ) : (
    <Play className="size-4 translate-x-px" />
  );

  if (errored) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl border px-2.5 py-2",
          v.chrome,
          className,
        )}
      >
        <AlertCircle className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">Audio unavailable</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl px-2.5 py-1.5",
        v.chrome,
        className,
      )}
    >
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? "Pause audio" : "Play audio"}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
          v.play,
        )}
      >
        {playIcon}
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <input
          type="range"
          min={0}
          max={duration > 0 ? duration : 0}
          step="any"
          value={duration > 0 ? Math.min(current, duration) : 0}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={duration <= 0}
          aria-label="Seek audio"
          className="pw-audio-range min-w-0 flex-1 disabled:opacity-40"
          style={
            {
              background: `linear-gradient(to right, ${v.fill} ${pct}%, ${v.track} ${pct}%)`,
              "--pw-thumb": v.thumb,
              "--pw-thumb-border": v.thumbBorder,
            } as React.CSSProperties
          }
        />
        <span
          className={cn(
            "shrink-0 text-[11px] font-medium tabular-nums",
            v.time,
          )}
        >
          {formatTime(current)}
          {duration > 0 ? ` / ${formatTime(duration)}` : ""}
        </span>
      </div>

      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? "Unmute audio" : "Mute audio"}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
          v.ghost,
        )}
      >
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>

      <audio ref={ref} src={src} preload="metadata" className="hidden" />
    </div>
  );
}

const VARIANTS = {
  default: {
    chrome: "border bg-muted/40 text-foreground",
    play: "bg-primary text-primary-foreground hover:bg-primary/90",
    ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
    time: "text-muted-foreground",
    fill: "var(--primary)",
    track: "var(--border)",
    thumb: "#fcfaf4",
    thumbBorder: "var(--primary)",
  },
  bare: {
    chrome: "text-foreground",
    play: "bg-primary text-primary-foreground hover:bg-primary/90",
    ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
    time: "text-muted-foreground",
    fill: "var(--primary)",
    track: "var(--border)",
    thumb: "#fcfaf4",
    thumbBorder: "var(--primary)",
  },
  story: {
    chrome: "text-white",
    play: "bg-primary text-primary-foreground hover:bg-primary/90",
    ghost: "text-white/70 hover:bg-white/10 hover:text-white",
    time: "text-white/60",
    fill: "var(--primary)",
    track: "rgba(255, 255, 255, 0.25)",
    thumb: "#ffffff",
    thumbBorder: "var(--primary)",
  },
  primary: {
    chrome: "border border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground",
    play: "bg-primary-foreground text-primary hover:bg-primary-foreground/90",
    ghost:
      "text-primary-foreground/80 hover:bg-primary-foreground/15 hover:text-primary-foreground",
    time: "text-primary-foreground/75",
    fill: "var(--primary-foreground)",
    track: "rgba(244, 240, 232, 0.35)",
    thumb: "#fcfaf4",
    thumbBorder: "var(--primary-foreground)",
  },
} as const;
