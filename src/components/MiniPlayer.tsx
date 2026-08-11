import { AudioLines, Pause, Play, X } from "lucide-react";
import { useEffect } from "react";

import { AudioPlayer } from "@/components/AudioPlayer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { playerStore } from "@/lib/audio-player";
import { cn } from "@/lib/utils";

/**
 * The persistent mini now-playing bar. Appears when audio is playing (or
 * was left paused across navigation) and the full player is closed, so
 * listeners can keep their track while browsing the platform. Sits above
 * the phone bottom nav on mobile, floats at the bottom on larger screens,
 * and never covers the sidebar or nav. Tapping the artwork/title opens the
 * full now-playing dialog; the thin line along the bottom is the progress.
 */
export function MiniPlayer() {
  const snap = useAudioPlayer();
  const track = snap.track;

  const hasTrack = track !== null;
  // Reserve layout space under the bar so it never covers content.
  useEffect(() => {
    if (hasTrack) {
      document.body.classList.add("pw-now-playing");
    } else {
      document.body.classList.remove("pw-now-playing");
    }
    return () => document.body.classList.remove("pw-now-playing");
  }, [hasTrack]);

  if (track === null) return null;

  const pct = snap.duration > 0 ? Math.min(100, (snap.position / snap.duration) * 100) : 0;
  const playing = snap.status === "playing";

  return (
    <>
      <div
        className={cn(
          "fixed inset-x-0 z-40 px-3",
          "bottom-[calc(3.9rem+env(safe-area-inset-bottom))]",
          "sm:bottom-4 sm:px-0 sm:pb-0",
        )}
      >
        <div
          className={cn(
            "relative mx-auto flex w-full max-w-md items-center gap-1.5 overflow-hidden rounded-xl border bg-card/95 px-2.5 py-2 shadow-lg backdrop-blur",
            "animate-in slide-in-from-bottom-2 fade-in sm:max-w-lg",
          )}
        >
          <button
            type="button"
            onClick={() => playerStore.setExpanded(true)}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-muted/60"
            aria-label="Open the full player"
          >
            {track.artwork ? (
              <img
                src={track.artwork}
                alt=""
                className="size-9 shrink-0 rounded-md object-cover"
              />
            ) : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <AudioLines className="size-4" />
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight">
                {track.title ?? "Audio"}
              </span>
              <span className="block text-xs text-muted-foreground">
                {playing ? "Playing now" : "Paused"} · {formatTime(snap.position)}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => playerStore.toggle()}
            aria-label={playing ? "Pause audio" : "Play audio"}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
          </button>

          <button
            type="button"
            onClick={() => playerStore.close()}
            aria-label="Close player"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>

          {/* Thin progress line along the bottom edge. */}
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-0.5 bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width] duration-150 ease-linear"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <NowPlayingDialog />
    </>
  );
}

/** The full now-playing dialog — artwork, title, and the extended player
 * (volume, speed, queue navigation, download). */
function NowPlayingDialog() {
  const snap = useAudioPlayer();
  const track = snap.track;
  if (track === null) return null;
  return (
    <Dialog
      open={snap.expanded}
      onOpenChange={(open) => playerStore.setExpanded(open)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="sr-only">Now playing</DialogTitle>
        <DialogDescription className="sr-only">
          Full audio player for {track.title ?? "the current track"}.
        </DialogDescription>
        <div className="flex flex-col gap-4 pt-2">
          {track.artwork ? (
            <img
              src={track.artwork}
              alt=""
              className="mx-auto max-h-64 w-full max-w-64 rounded-xl object-cover"
            />
          ) : (
            <div className="mx-auto flex size-24 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <AudioLines className="size-10" />
            </div>
          )}
          <div className="text-center">
            <p className="truncate text-base font-semibold">
              {track.title ?? "Audio"}
            </p>
            <p className="text-xs text-muted-foreground">PureWire audio</p>
          </div>
          <AudioPlayer
            track={track}
            variant="default"
            waveform
            expandedUI
            className="w-full"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Global keyboard controls while audio is active:
 *   Space  play / pause     ← / →  seek ±10s
 *   ↑ / ↓  volume ±0.1      M      mute / unmute
 *   F      expand / collapse the full player
 * Shortcuts never fire while typing in an input, textarea, select, or
 * contenteditable editor.
 */
export function AudioPlayerShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t !== null) {
        const tag = t.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          t.isContentEditable
        ) {
          return;
        }
      }
      if (playerStore.getTrack() === null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          playerStore.toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          playerStore.seekBy(-10);
          break;
        case "ArrowRight":
          e.preventDefault();
          playerStore.seekBy(10);
          break;
        case "ArrowUp":
          e.preventDefault();
          playerStore.setVolume(playerStore.getVolume() + 0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          playerStore.setVolume(playerStore.getVolume() - 0.1);
          break;
        case "m":
        case "M":
          playerStore.toggleMute();
          break;
        case "f":
        case "F":
          playerStore.setExpanded(!playerStore.getExpanded());
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}
