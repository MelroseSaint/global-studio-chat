import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAudioPlayer } from "@/hooks/use-audio-player";
import { playerStore, PlayerStore, type AudioTrack } from "@/lib/audio-player";
import { cn } from "@/lib/utils";

/** mm:ss duration label — plain and compact, matching the muted
 * tabular-nums time stamps used across the feed. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/** Build the scrubber's CSS gradient: played portion Oxide red, buffered
 * segments a softer tint, the rest the track color. */
function trackGradient(
  pct: number,
  buffered: Array<[number, number]>,
  duration: number,
  current: number,
  fill: string,
  track: string,
  buffer: string,
): string {
  if (duration <= 0) return `linear-gradient(to right, ${track} 0%, ${track} 100%)`;
  const points: Array<{ at: number; color: string }> = [
    { at: 0, color: fill },
    { at: pct, color: track },
  ];
  for (const [start, end] of buffered) {
    if (end <= current || start >= duration) continue;
    const a = (Math.max(start, current) / duration) * 100;
    const b = (Math.min(end, duration) / duration) * 100;
    points.push({ at: a, color: buffer }, { at: b, color: track });
  }
  points.sort((x, y) => x.at - y.at);
  const stops: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const next = points[i + 1];
    if (next === undefined) {
      stops.push(`${cur.color} ${cur.at}%, ${cur.color} 100%`);
    } else {
      stops.push(`${cur.color} ${cur.at}%, ${cur.color} ${next.at}%`);
    }
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

const SPEEDS = [1, 1.5, 2] as const;

/**
 * The PureWire audio player — a control bar that speaks the platform's
 * visual language (Oxide-red primary, Paper accents, muted surfaces,
 * lucide icons) instead of the browser's default widget.
 *
 * By default every instance binds to the centralized PlayerStore: only one
 * audio plays at a time, all instances of the same track id share state,
 * and a mini now-playing bar can keep playing across navigation. With
 * `standalone` (upload previews) the player owns a private store so a
 * scratch listen never hijacks the global player.
 *
 * `expandedUI` adds the second row — volume, playback speed, queue
 * navigation and download — used by the full now-playing dialog.
 */
export function AudioPlayer({
  track,
  variant = "default",
  waveform = false,
  standalone = false,
  expandedUI = false,
  onEnded,
  className,
}: {
  track: AudioTrack;
  variant?: "default" | "bare" | "story" | "primary";
  /** Draw the track's real envelope behind the scrubber. */
  waveform?: boolean;
  /** Use a private local store (upload previews) instead of the global one. */
  standalone?: boolean;
  /** Show the extended control row (volume, speed, queue, download). */
  expandedUI?: boolean;
  /** Called when playback of this track reaches the end. */
  onEnded?: () => void;
  className?: string;
}) {
  const localStore = useMemo(
    () => (standalone ? new PlayerStore({ persist: false }) : null),
    [standalone],
  );
  const store = localStore ?? playerStore;
  const snap = useAudioPlayer(store);

  // A standalone (upload-preview) store must stop playback when its player
  // unmounts — the preview can be removed mid-play and must not keep
  // playing from a detached element.
  useEffect(() => {
    if (localStore === null) return;
    return () => localStore.close();
  }, [localStore]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [resizeTick, setResizeTick] = useState(0);
  // Track identity guard so a re-mounted player for a different track
  // never paints a stale envelope.
  const [peaksFor, setPeaksFor] = useState<string | null>(null);

  // Register the onEnded callback with the store (stories auto-advance).
  useEffect(() => {
    if (standalone || onEnded === undefined) return;
    store.setOnEnded(track.id, onEnded);
    return () => store.setOnEnded(track.id, undefined);
  }, [standalone, store, track.id, onEnded]);

  // Decode the waveform lazily — only once the player scrolls near the
  // viewport, and once per track id (the store caches the envelope).
  useEffect(() => {
    // The render guard (`waveform && peaksFor === track.id`) hides any
    // stale envelope when the prop is off or the track changed, so no
    // synchronous reset is needed here.
    if (!waveform) return;
    let cancelled = false;
    const el = canvasRef.current;
    const decode = () => {
      void store.getWaveform(track).then((p) => {
        if (!cancelled) {
          setPeaks(p);
          setPeaksFor(track.id);
        }
      });
    };
    if (el !== null && typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            decode();
            io.disconnect();
          }
        },
        { rootMargin: "300px 0px" },
      );
      io.observe(el);
      return () => {
        cancelled = true;
        io.disconnect();
      };
    }
    decode();
    return () => {
      cancelled = true;
    };
  }, [store, track, waveform]);

  // Redraw the waveform when the player resizes (bars must track width).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Paint the waveform: muted bars for unplayed time, Oxide-red bars
  // behind the played portion. Runs on every position tick while playing,
  // so the red region animates smoothly with playback.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || peaks === null || peaksFor !== track.id) return;
    const vv = VARIANTS[variant];
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pct = snap.duration > 0 ? Math.min(1, snap.position / snap.duration) : 0;
    const bars = peaks.length;
    const gap = 1.5;
    const barW = (w - gap * (bars - 1)) / bars;
    const mid = h / 2;
    const maxBarH = Math.max(8, h - 6);
    const roundRectSupported =
      typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown }).roundRect ===
      "function";
    // Canvas fillStyle cannot resolve CSS custom properties.
    const resolveColor = (c: string): string =>
      c.startsWith("var(")
        ? getComputedStyle(document.documentElement)
            .getPropertyValue(c.slice(4, -1).trim())
            .trim() || c
        : c;

    const drawBars = (color: string) => {
      ctx.fillStyle = color;
      for (let i = 0; i < bars; i++) {
        const x = i * (barW + gap);
        const barH = Math.max(2, peaks[i] * maxBarH);
        const y = mid - barH / 2;
        if (roundRectSupported) {
          ctx.beginPath();
          ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, barH / 2));
          ctx.fill();
        } else {
          ctx.fillRect(x, y, barW, barH);
        }
      }
    };

    drawBars(vv.wave);
    if (pct > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w * pct, h);
      ctx.clip();
      drawBars(resolveColor(vv.fill));
      ctx.restore();
    }
  }, [peaks, peaksFor, track.id, variant, snap.position, snap.duration, resizeTick]);

  const isCurrent = store.isCurrent(track.id);
  const playing = isCurrent && snap.status === "playing";
  const waiting = isCurrent && snap.status === "loading";
  const failed = isCurrent && snap.hasError;
  const position = isCurrent ? snap.position : 0;
  const duration = isCurrent ? snap.duration : 0;
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  const v = VARIANTS[variant];
  const showWave = waveform && peaks !== null && peaksFor === track.id;
  const playIcon = waiting ? (
    <Loader2 className="size-4 animate-spin" />
  ) : playing ? (
    <Pause className="size-4" />
  ) : (
    <Play className="size-4 translate-x-px" />
  );

  const togglePlay = () => {
    if (isCurrent) {
      store.toggle();
    } else {
      store.play(track);
    }
  };

  const downloadName =
    track.title && track.title.trim().length > 0
      ? `${track.title.trim()}.mp3`
      : "purewire-audio.mp3";

  if (failed) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl border px-2.5 py-2 text-sm",
          v.chrome,
          className,
        )}
      >
        <AlertCircle className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Audio unavailable</span>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl px-2.5 py-1.5",
          v.chrome,
          isCurrent && "ring-2 ring-primary/40",
        )}
      >
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "Pause audio" : "Play audio"}
          aria-pressed={playing}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
            v.play,
          )}
        >
          {playIcon}
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="relative flex h-7 min-w-0 flex-1 items-center">
            {showWave && (
              <canvas
                ref={canvasRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-full"
              />
            )}
            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 0}
              step="any"
              value={duration > 0 ? Math.min(position, duration) : 0}
              onChange={(e) => store.seek(Number(e.target.value))}
              disabled={duration <= 0}
              aria-label="Seek audio"
              className={cn(
                "pw-audio-range relative z-10 min-w-0 flex-1 disabled:opacity-40",
                showWave && "bg-transparent",
              )}
              style={
                {
                  background: showWave
                    ? "transparent"
                    : trackGradient(
                        pct,
                        isCurrent ? snap.buffered : [],
                        duration,
                        position,
                        v.fill,
                        v.track,
                        v.buffer,
                      ),
                  "--pw-thumb": v.thumb,
                  "--pw-thumb-border": v.thumbBorder,
                } as React.CSSProperties
              }
            />
          </div>
          <span
            className={cn(
              "shrink-0 text-[11px] font-medium tabular-nums",
              v.time,
            )}
          >
            {formatTime(position)}
            {duration > 0 ? ` / ${formatTime(duration)}` : ""}
          </span>
        </div>

        <button
          type="button"
          onClick={() => store.toggleMute()}
          aria-label={snap.muted ? "Unmute audio" : "Mute audio"}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
            v.ghost,
          )}
        >
          {snap.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
      </div>

      {expandedUI && (
        <div className={cn("flex items-center gap-3 px-1 pt-2.5", v.time)}>
          {snap.queue.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => store.playPrev()}
                aria-label="Previous track"
                className={cn(
                  "flex size-8 items-center justify-center rounded-full transition-colors",
                  v.ghost,
                )}
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => store.playNext()}
                aria-label="Next track"
                className={cn(
                  "flex size-8 items-center justify-center rounded-full transition-colors",
                  v.ghost,
                )}
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          )}

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Volume2 className="size-4 shrink-0" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={snap.muted ? 0 : snap.volume}
              onChange={(e) => store.setVolume(Number(e.target.value))}
              aria-label="Volume"
              className="pw-audio-range min-w-0 flex-1"
              style={
                {
                  background: `linear-gradient(to right, ${v.fill} ${(snap.muted ? 0 : snap.volume) * 100}%, ${v.track} ${(snap.muted ? 0 : snap.volume) * 100}%)`,
                  "--pw-thumb": v.thumb,
                  "--pw-thumb-border": v.thumbBorder,
                } as React.CSSProperties
              }
            />
          </div>

          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Playback speed"
          >
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => store.setRate(s)}
                aria-pressed={snap.rate === s}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                  snap.rate === s
                    ? "border-primary bg-primary text-primary-foreground"
                    : v.ghost,
                )}
              >
                {s}×
              </button>
            ))}
          </div>

          {track.downloadable === true && (
            <a
              href={track.src}
              download={downloadName}
              aria-label="Download audio"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                v.ghost,
              )}
            >
              <Download className="size-4" />
            </a>
          )}
        </div>
      )}

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
    buffer: "color-mix(in oklch, var(--primary) 30%, var(--border))",
    wave: "color-mix(in oklch, var(--primary) 28%, var(--border))",
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
    buffer: "color-mix(in oklch, var(--primary) 30%, var(--border))",
    wave: "color-mix(in oklch, var(--primary) 28%, var(--border))",
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
    buffer: "rgba(255, 255, 255, 0.45)",
    wave: "rgba(255, 255, 255, 0.3)",
    thumb: "#ffffff",
    thumbBorder: "var(--primary)",
  },
  primary: {
    chrome:
      "border border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground",
    play: "bg-primary-foreground text-primary hover:bg-primary-foreground/90",
    ghost:
      "text-primary-foreground/80 hover:bg-primary-foreground/15 hover:text-primary-foreground",
    time: "text-primary-foreground/75",
    fill: "var(--primary-foreground)",
    track: "rgba(244, 240, 232, 0.35)",
    buffer: "rgba(244, 240, 232, 0.6)",
    wave: "rgba(244, 240, 232, 0.38)",
    thumb: "#fcfaf4",
    thumbBorder: "var(--primary-foreground)",
  },
} as const;
