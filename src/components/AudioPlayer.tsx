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
 * Build the scrubber's CSS gradient: the played portion is painted Oxide
 * red, buffered segments get a softer tint, and everything else stays the
 * track color. Adjacent same-position stops are legal CSS — the sort
 * guarantees the bands stay contiguous no matter how many buffered
 * ranges the browser reports.
 */
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

/**
 * Downsample the decoded audio into BARS peak values (0..1) for the
 * waveform visualization. Peak per bucket keeps quiet passages visible
 * and loud ones capped — a real envelope, not a synthetic pattern.
 */
function computeWaveformPeaks(buffer: AudioBuffer, bars: number): number[] {
  const data = buffer.getChannelData(0);
  const peaks: number[] = [];
  const step = Math.max(1, Math.floor(data.length / bars));
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    const end = Math.min((i + 1) * step, data.length);
    for (let j = i * step; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    // Gentle gain so quiet recordings still show a visible envelope.
    peaks.push(Math.min(1, peak * 2.2));
  }
  return peaks;
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
 * index.css): the played portion is painted Oxide red, buffered segments
 * a softer tint, and the thumb is a Paper dot ringed in Oxide. With the
 * `waveform` prop the scrubber instead draws the file's real envelope
 * (decoded client-side via WebAudio, peak-per-bucket) — played time is
 * tinted Oxide over the muted bars. Decode failures fall back to the
 * plain track so the player never looks broken.
 */
export function AudioPlayer({
  src,
  variant = "default",
  waveform = false,
  onEnded,
  className,
}: {
  src: string;
  variant?: "default" | "bare" | "story" | "primary";
  /** Draw the file's real waveform behind the scrubber (story viewer). */
  waveform?: boolean;
  /** Called once playback reaches the end of the track. */
  onEnded?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  // Buffering between play and actually producing sound (network stall,
  // slow decode) — shows a spinner in the play button.
  const [waiting, setWaiting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [errored, setErrored] = useState(false);
  const [buffered, setBuffered] = useState<Array<[number, number]>>([]);
  // Real waveform peaks (0..1 per bar) keyed by the src they were decoded
  // from — the render guard (wave.src === src) means a stale envelope from
  // a previous track never shows while the next one decodes.
  const [wave, setWave] = useState<{ src: string; peaks: number[] } | null>(null);
  const [resizeTick, setResizeTick] = useState(0);

  // Keep the newest onEnded callback without re-attaching listeners.
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onTime = () => setCurrent(el.currentTime);
    const onDuration = () => {
      if (Number.isFinite(el.duration)) setDuration(el.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEndedEvent = () => {
      setPlaying(false);
      setCurrent(0);
      onEndedRef.current?.();
    };
    const onWaiting = () => setWaiting(true);
    const onCanPlay = () => setWaiting(false);
    const onPlaying = () => setWaiting(false);
    const onVolume = () => setMuted(el.muted || el.volume === 0);
    const onLoadStart = () => {
      setErrored(false);
      setWaiting(false);
      setBuffered([]);
    };
    const onError = () => setErrored(true);
    const onProgress = () => {
      const ranges: Array<[number, number]> = [];
      for (let i = 0; i < el.buffered.length; i++) {
        ranges.push([el.buffered.start(i), el.buffered.end(i)]);
      }
      setBuffered(ranges);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("durationchange", onDuration);
    el.addEventListener("loadedmetadata", onDuration);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEndedEvent);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("volumechange", onVolume);
    el.addEventListener("loadstart", onLoadStart);
    el.addEventListener("progress", onProgress);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("durationchange", onDuration);
      el.removeEventListener("loadedmetadata", onDuration);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEndedEvent);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("volumechange", onVolume);
      el.removeEventListener("loadstart", onLoadStart);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("error", onError);
    };
  }, []);

  // Decode the file into waveform peaks when requested. Only the story
  // viewer enables this — one track at a time, user-initiated — so the
  // full-file fetch never happens for feed cards (which stay on
  // preload="metadata"). Failures (CORS, huge files) quietly fall back to
  // the plain track; a stale envelope from a previous src is never shown
  // because the render guard requires wave.src === src.
  useEffect(() => {
    if (!waveform) return;
    let cancelled = false;
    fetch(src)
      .then((r) => r.arrayBuffer())
      .then((bytes) => {
        const w = window as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (Ctor === undefined) throw new Error("WebAudio unavailable");
        const ctx = new Ctor();
        return ctx.decodeAudioData(bytes);
      })
      .then((audioBuf) => {
        if (!cancelled) setWave({ src, peaks: computeWaveformPeaks(audioBuf, 48) });
      })
      .catch(() => {
        // Leave any previous envelope untouched — the src guard hides it.
      });
    return () => {
      cancelled = true;
    };
  }, [src, waveform]);

  // Redraw the waveform when the player resizes (bars must track width).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Paint the waveform: muted bars for the unplayed portion, Oxide-red
  // bars behind the played portion (clipped to the current position).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || wave === null || wave.src !== src) return;
    const vv = VARIANTS[variant];
    const peaks = wave.peaks;
    // Canvas fillStyle does not resolve CSS custom properties — resolve
    // var(--primary) against the document root before painting.
    const resolveColor = (c: string): string => {
      if (!c.startsWith("var(")) return c;
      const name = c.slice(4, -1).trim();
      return (
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || c
      );
    };
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

    const pct = duration > 0 ? Math.min(1, current / duration) : 0;
    const bars = peaks.length;
    const gap = 1.5;
    const barW = (w - gap * (bars - 1)) / bars;
    const mid = h / 2;
    const maxBarH = Math.max(8, h - 6);
    const roundRectSupported =
      typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown }).roundRect ===
      "function";

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
  }, [wave, src, current, duration, variant, resizeTick]);

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
        <div className="relative flex h-7 min-w-0 flex-1 items-center">
          {waveform && wave !== null && wave.src === src && (
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
            value={duration > 0 ? Math.min(current, duration) : 0}
            onChange={(e) => seek(Number(e.target.value))}
            disabled={duration <= 0}
            aria-label="Seek audio"
            className={cn(
              "pw-audio-range relative z-10 min-w-0 flex-1 disabled:opacity-40",
              waveform && wave !== null && wave.src === src && "bg-transparent",
            )}
            style={
              {
                background:
                  waveform && wave !== null && wave.src === src
                    ? "transparent"
                    : trackGradient(pct, buffered, duration, current, v.fill, v.track, v.buffer),
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
