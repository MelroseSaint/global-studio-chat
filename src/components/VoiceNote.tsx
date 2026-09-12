import { AudioPlayer } from "@/components/AudioPlayer";

/**
 * A voice note on a comment: the native PureWire player plus a duration
 * chip (from the measured clip length) and the author's optional
 * description underneath. Shared by every comment surface (popup dialog,
 * post page, inline replies) so the rendering is identical everywhere.
 */
export function VoiceNote({
  media,
  trackId,
  className = "max-w-xs",
}: {
  media: {
    url?: string;
    key?: string;
    duration?: number;
    description?: string;
  };
  trackId: string;
  className?: string;
}) {
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <AudioPlayer
          track={{ id: trackId, src: media.url ?? "" }}
          variant="bare"
          className={className}
        />
        {typeof media.duration === "number" && media.duration > 0 ? (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {formatVoiceNoteDuration(media.duration)}
          </span>
        ) : null}
      </div>
      {media.description ? (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {media.description}
        </p>
      ) : null}
    </div>
  );
}

/** 65 → "1:05", 12.4 → "0:12" — voice-note length at a glance. */
function formatVoiceNoteDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
