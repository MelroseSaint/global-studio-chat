import { useAction, useMutation } from "convex/react";
import { Loader2, MapPin, Send, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { MediaUpload, type MediaItem } from "@/components/MediaUpload";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { getBrowserLocation } from "@/lib/geo";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 1000;

export function Composer({ onPosted }: { onPosted?: () => void }) {
  const { user } = useAuth();
  const createPost = useMutation(api.posts.createPost);
  const scanMedia = useAction(api.aiContent.scanMediaForAi);
  const [content, setContent] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [location, setLocation] = useState<
    | { latitude: number; longitude: number; label?: string }
    | undefined
  >(undefined);
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canPost = content.trim().length > 0 || media.length > 0;
  const overLimit = content.length > MAX_LENGTH;

  const submit = async () => {
    if (!canPost || submitting || overLimit) return;
    setSubmitting(true);
    try {
      // Scan uploaded media bytes for AI-generator metadata before posting.
      let aiMediaStatus: "clean" | "review" | "blocked" = "clean";
      if (media.length > 0) {
        const scan = await scanMedia({
          media: media.map((m) => ({ storageId: m.storageId, kind: m.kind })),
        });
        if (scan.status === "blocked") {
          toast.error(
            "This media looks AI-generated, which isn't allowed on PureWire. Upload your own original work.",
          );
          return;
        }
        aiMediaStatus = scan.status;
      }
      const result = await createPost({
        content: content.trim(),
        media:
          media.length > 0
            ? media.map((m) => ({
                storageId: m.storageId,
                kind: m.kind,
              }))
            : undefined,
        // Perceptual hashes computed during upload — the server uses them
        // to catch flipped/cropped/re-encoded copies of existing media.
        mediaHashes:
          media.length > 0
            ? media.map((m) => m.hashes ?? []).filter((h) => h.length > 0)
            : undefined,
        aiMediaStatus,
        location,
      });
      // createPost rejects duplicates and rate-limit breaches with a
      // structured result (not a thrown error) so the quiet flag on the
      // offending account is recorded — show the reason and stop.
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setContent("");
      setMedia([]);
      setLocation(undefined);
      toast.success("Posted!");
      onPosted?.();
      textareaRef.current?.focus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not post.");
    } finally {
      setSubmitting(false);
    }
  };

  const attachLocation = async () => {
    if (locating) return;
    // Home locations are label-only by design (coordinates are never
    // stored), so tagging a post always reads the live browser position —
    // an explicit, opt-in permission prompt that is never persisted.
    setLocating(true);
    const pos = await getBrowserLocation();
    setLocating(false);
    if (pos !== null) {
      // A label makes the attached location visible on the post card too.
      setLocation({ ...pos, label: "Nearby" });
    } else {
      toast.error(
        "Couldn't get your location. Allow location access to tag your posts.",
      );
    }
  };

  return (
    <div className="flex gap-3 border-b px-4 py-4 sm:px-5">
      <UserAvatar user={user} className="size-11" />
      <div className="min-w-0 flex-1">
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Say it anyway…"
          rows={2}
          maxLength={MAX_LENGTH + 10}
          className="resize-none border-none bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MediaUpload
              value={media}
              onChange={setMedia}
              max={4}
              compact
            />
            {location ? (
              <button
                type="button"
                onClick={() => setLocation(undefined)}
                className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                title="Remove location"
              >
                <MapPin className="size-3.5" />
                <span className="max-w-32 truncate">
                  {location.label ?? "Nearby"}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void attachLocation()}
                disabled={locating}
                className="flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary disabled:opacity-60"
                title="Add your location"
              >
                <MapPin className="size-3.5" />
                {locating ? "Locating…" : "Location"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "text-xs tabular-nums",
                overLimit
                  ? "font-semibold text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {content.length}/{MAX_LENGTH}
            </span>
            <Button
              size="sm"
              disabled={!canPost || submitting || overLimit}
              onClick={() => void submit()}
              className="rounded-full px-5"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Post
            </Button>
          </div>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Sparkles className="size-3" />
          Your own original work only — AI-generated content is not allowed on
          PureWire.
        </p>
      </div>
    </div>
  );
}
