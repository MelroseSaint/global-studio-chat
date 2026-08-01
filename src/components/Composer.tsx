import { useAction, useMutation } from "convex/react";
import { Loader2, MapPin, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { LocationPicker, type PickedLocation } from "@/components/LocationPicker";
import { MediaUpload, type MediaItem } from "@/components/MediaUpload";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 1000;

export function Composer({ onPosted }: { onPosted?: () => void }) {
  const { user } = useAuth();
  const createPost = useMutation(api.posts.createPost);
  const scanMedia = useAction(api.aiContent.scanMediaForAi);
  const stripMedia = useAction(api.media.stripVideoMetadata);
  const [content, setContent] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [location, setLocation] = useState<PickedLocation | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close the location picker on outside click / touch.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [pickerOpen]);

  const canPost = content.trim().length > 0 || media.length > 0;
  const overLimit = content.length > MAX_LENGTH;

  const submit = async () => {
    if (!canPost || submitting || overLimit) return;
    setSubmitting(true);
    try {
      // Scan uploaded media bytes for AI-generator metadata before posting.
      let aiMediaStatus: "clean" | "review" | "blocked" = "clean";
      // The server-side strip may swap video storageIds, so the list passed
      // to createPost is the cleaned one, not the original uploads.
      let postMedia: Pick<MediaItem, "storageId" | "kind">[] | undefined;
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
        // Server-side remux: strip GPS/device metadata atoms from video
        // containers BEFORE the post exists, so the document never
        // references a clip that still carries them. Runs after the AI scan
        // above, which must read the original bytes first — stripping must
        // never remove the evidence that media was machine-made.
        postMedia = await stripMedia({
          media: media.map((m) => ({ storageId: m.storageId, kind: m.kind })),
        });
      }
      const result = await createPost({
        content: content.trim(),
        media: postMedia,
        // Perceptual hashes computed during upload — the server uses them
        // to catch flipped/cropped/re-encoded copies of existing media.
        mediaHashes:
          media.length > 0
            ? media.map((m) => m.hashes ?? []).filter((h) => h.length > 0)
            : undefined,
        aiMediaStatus,
        // A label-only tag (typed place without picked coordinates) can't
        // power the Local feed filter, so only coords-tagged posts attach a
        // location. The picker's search and "use my current location" both
        // supply coordinates.
        location:
          location !== undefined &&
          location.latitude !== undefined &&
          location.longitude !== undefined
            ? {
                label: location.label,
                latitude: location.latitude,
                longitude: location.longitude,
              }
            : undefined,
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
      setPickerOpen(false);
      toast.success("Posted!");
      onPosted?.();
      textareaRef.current?.focus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not post.");
    } finally {
      setSubmitting(false);
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
            <div className="relative" ref={pickerRef}>
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
                  onClick={() => setPickerOpen((o) => !o)}
                  className="flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                  title="Add your location"
                >
                  <MapPin className="size-3.5" />
                  Location
                </button>
              )}
              {pickerOpen && (
                <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-xl border bg-background p-2 shadow-lg">
                  <LocationPicker
                    value={location ?? null}
                    onChange={(loc) => {
                      setLocation(loc ?? undefined);
                      if (loc) setPickerOpen(false);
                    }}
                    placeholder="Search a place…"
                    // Post tags need coordinates for the Local feed, so
                    // free-typed labels are dropped at submit — only real
                    // picks should count here.
                    allowLabelOnly={false}
                  />
                </div>
              )}
            </div>
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
