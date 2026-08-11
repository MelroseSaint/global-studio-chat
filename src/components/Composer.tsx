import { useAction, useQuery } from "convex/react";
import { Loader2, MapPin, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { LocationPicker, type PickedLocation } from "@/components/LocationPicker";
import { MediaUpload, type MediaItem, type MediaKind } from "@/components/MediaUpload";
import { MentionPicker } from "@/components/MentionPicker";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { solvePow } from "@/lib/pow";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 1000;

export function Composer({ onPosted }: { onPosted?: () => void }) {
  const { user } = useAuth();
  const createPost = useAction(api.posts.createPost);
  // A fresh proof-of-work challenge, cached for the session (challenges are
  // valid for 5 minutes — a new one is fetched lazily when stale).
  const powChallenge = useQuery(api.pow.getChallenge);
  const scanMedia = useAction(api.aiContent.scanMediaForAi);
  const stripMedia = useAction(api.media.stripVideoMetadata);
  const [content, setContent] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  // Optional title for audio posts — shown prominently with the player.
  // Prefilled best-effort from the file's own tags only until the author
  // types: the author's title always wins and ships to the server.
  const [audioTitle, setAudioTitle] = useState("");
  const [audioTitleEdited, setAudioTitleEdited] = useState(false);
  const [location, setLocation] = useState<PickedLocation | undefined>(undefined);
  // Remember the metadata title we last seeded from, so the field only
  // prefills when a NEW audio file's tags arrive and the author hasn't
  // typed their own title yet.
  const [seededMetaTitle, setSeededMetaTitle] = useState<string | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [creatorDisclosure, setCreatorDisclosure] = useState<
    "human-made" | "ai-assisted" | "ai-generated"
  >("human-made");
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
  const hasAudio = media.some((m) => m.kind === "audio");
  // Seed the title field from the first audio file's own metadata (ID3 /
  // FLAC / WAV), but only while the author hasn't typed their own. Done as
  // a render-time adjustment (React's documented replacement for the
  // setState-in-effect pattern): React re-renders before committing, so no
  // flicker and no cascading effect.
  const metaTitle = media.find((m) => m.kind === "audio" && m.title !== undefined)?.title;
  if (metaTitle !== seededMetaTitle && !audioTitleEdited) {
    setSeededMetaTitle(metaTitle);
    if (metaTitle !== undefined) setAudioTitle(metaTitle);
  }
  const overLimit = content.length > MAX_LENGTH;

  // Insert an @mention (from the tag picker) at the textarea cursor so the
  // tagged user is linked in the post and notified on submit.
  const insertMention = (username: string) => {
    if (!username) return;
    const ta = textareaRef.current;
    setContent((c) => {
      const token = `@${username} `;
      if (ta) {
        const start = ta.selectionStart ?? c.length;
        const end = ta.selectionEnd ?? c.length;
        const next = c.slice(0, start) + token + c.slice(end);
        requestAnimationFrame(() => {
          ta.focus();
          const pos = start + token.length;
          ta.setSelectionRange(pos, pos);
        });
        return next;
      }
      return c + token;
    });
  };

  const submit = async () => {
    if (!canPost || submitting || overLimit) return;
    setSubmitting(true);
    try {
      // Scan uploaded media bytes for AI-generator metadata before posting.
      let aiMediaStatus: "clean" | "review" | "blocked" = "clean";
      // The server-side strip may swap video storage ids (or overwrite a
      // Cloudinary object), so the list passed to createPost is the cleaned one,
      // not the original uploads. The `stripped` flag rides along so the
      // post knows which media had GPS/device metadata removed before
      // upload. Dual-mode: each item carries either a Convex storageId or an
      // external Cloudinary url+key (stripMedia returns server-shape items).
      let postMedia:
        | {
            storageId?: Id<"_storage">;
            url?: string;
            key?: string;
            kind: MediaKind;
            stripped?: boolean;
            title?: string;
          }[]
        | undefined;
      if (media.length > 0) {
        const scan = await scanMedia({
          media: media.map((m) => ({
            storageId: m.storageId,
            url: m.externalUrl,
            kind: m.kind,
          })),
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
          media: media.map((m) => ({
            storageId: m.storageId,
            url: m.externalUrl,
            key: m.key,
            kind: m.kind,
            stripped: m.stripped,
            // The audio title rides through the strip unchanged.
            ...(m.kind === "audio" && audioTitle.trim() ? { title: audioTitle.trim() } : {}),
          })),
        });
      }
      // Proof-of-work: solve a ~50 ms local puzzle so the write carries a
      // verifiable "I burned compute" stamp. Bots flooding the API pay per
      // attempt on top of the server rate limits; a human never notices.
      if (!powChallenge) return;
      const proof = await solvePow(
        powChallenge.challenge,
        powChallenge.difficulty,
      );
      const result = await createPost({
        content: content.trim(),
        creatorDisclosure,
        media: postMedia,
        powChallenge: powChallenge.challenge,
        powNonce: proof.nonce,
        powIssuedAt: proof.issuedAt,
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
      setCreatorDisclosure("human-made");
      setPickerOpen(false);
      if (result.aiReviewReason) {
        // Honest "why": the post was flagged for a human check — tell the
        // author now, and the post carries an "under review" note on their
        // own views until an admin decides. Genuine creators should never
        // wonder why their post went quiet.
        toast("Your post is being checked by a human before it goes public.", {
          description: `Why: ${result.aiReviewReason}`,
        });
      } else {
        toast.success("Posted!");
      }
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
        {hasAudio && (
          <input
            value={audioTitle}
            onChange={(e) => {
              setAudioTitle(e.target.value);
              setAudioTitleEdited(true);
            }}
            placeholder="Audio title (optional)"
            maxLength={120}
            aria-label="Audio title"
            className="mt-2 flex h-10 w-full max-w-sm rounded-lg border bg-muted/40 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-2">
            <MediaUpload
              value={media}
              onChange={setMedia}
              max={4}
              compact
            />
            <MentionPicker disabled={submitting} onPick={insertMention} />
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
                <div className="absolute left-0 top-full z-30 mt-2 w-72 max-w-[min(18rem,calc(100vw-3rem))] rounded-xl border bg-background p-2 shadow-lg">
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
          <div className="ml-auto flex items-center gap-3">
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
              disabled={!canPost || submitting || overLimit || creatorDisclosure === "ai-generated"}
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
            This work is:
          </span>
          <div className="flex rounded-lg border p-0.5 text-[11px] sm:text-xs">
            {(
              [
                { value: "human-made", label: "Human", short: "Human" },
                { value: "ai-assisted", label: "AI-assisted", short: "AI help" },
                { value: "ai-generated", label: "AI-generated", short: "AI gen" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  setCreatorDisclosure(
                    opt.value as "human-made" | "ai-assisted" | "ai-generated",
                  )
                }
                className={cn(
                  "rounded-md px-2 py-1 font-medium transition-colors sm:px-3",
                  creatorDisclosure === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="hidden sm:inline">{opt.label}</span>
                <span className="sm:hidden">{opt.short}</span>
              </button>
            ))}
          </div>
          {creatorDisclosure === "ai-generated" ? (
            <span className="text-[11px] font-medium text-destructive">
              AI-generated content is not allowed on PureWire.
            </span>
          ) : creatorDisclosure === "ai-assisted" ? (
            <span className="text-[11px] text-muted-foreground">
              AI tools helped, but the work is yours. Will be reviewed.
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
