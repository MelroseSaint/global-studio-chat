import { useAction, useMutation, useQuery } from "convex/react";
import { AudioLines, ChevronLeft, ChevronRight, Loader2, Plus, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { MediaUpload, type MediaItem } from "@/components/MediaUpload";
import { MetadataStrippedChip } from "@/components/MetadataStrippedChip";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";

export function StoriesBar() {
  const { user } = useAuth();
  const stories = useQuery(api.stories.listStories);
  const createStory = useMutation(api.stories.createStory);
  const scanMedia = useAction(api.aiContent.scanMediaForAi);
  const stripMedia = useAction(api.media.stripVideoMetadata);
  const [addOpen, setAddOpen] = useState(false);
  const [viewing, setViewing] = useState<number>(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [caption, setCaption] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (stories === undefined) {
    return <div className="h-[92px] animate-pulse border-b bg-muted/40" />;
  }

  const addStory = async () => {
    if (media.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      // Scan the uploaded media bytes for AI-generator metadata first.
      const scan = await scanMedia({
        media: [{ storageId: media[0].storageId, kind: media[0].kind }],
      });
      if (scan.status === "blocked") {
        toast.error(
          "This media looks AI-generated, which isn't allowed on PureWire. Upload your own original work.",
        );
        return;
      }
      // Server-side remux: strip GPS/device metadata from a video story
      // before it exists, so it never references a dirty clip. Runs after
      // the AI scan, which must read the original bytes first.
      const cleaned = await stripMedia({
        media: [
          {
            storageId: media[0].storageId,
            kind: media[0].kind,
            stripped: media[0].stripped,
          },
        ],
      });
      await createStory({
        media: cleaned[0],
        caption: caption.trim() || undefined,
        aiMediaStatus: scan.status,
      });
      toast.success("Story added!");
      setAddOpen(false);
      setMedia([]);
      setCaption("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add story.");
    } finally {
      setSubmitting(false);
    }
  };

  const openViewer = (index: number) => {
    setViewing(index);
    setViewerOpen(true);
  };

  const current = stories[viewing];

  return (
    <>
      <div className="flex items-center gap-4 overflow-x-auto border-b px-4 py-3 sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Add your own story */}
        <button
          onClick={() => setAddOpen(true)}
          className="group flex shrink-0 flex-col items-center gap-1.5"
        >
          <span className="relative">
            <UserAvatar
              user={user}
              className="size-16 rounded-full border-2 border-border"
            />
            <span className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background transition-transform group-hover:scale-110">
              <Plus className="size-4" />
            </span>
          </span>
          <span className="text-xs text-muted-foreground">Your story</span>
        </button>

        {stories.map((story, i) => (
          <button
            key={story._id}
            onClick={() => openViewer(i)}
            className="group flex shrink-0 flex-col items-center gap-1.5"
          >
            <span className="story-ring rounded-full p-[2.5px]">
              <span className="block rounded-full bg-background p-[2.5px]">
                <UserAvatar
                  user={story.author}
                  className="size-14 rounded-full"
                />
              </span>
            </span>
            <span className="max-w-16 truncate text-xs text-muted-foreground">
              {story.author?.name ?? story.author?.username}
            </span>
          </button>
        ))}
      </div>

      {/* Add story dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add to your story</DialogTitle>
            <DialogDescription>
              Stories disappear after 24 hours. You can add a photo, video or
              audio clip.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <MediaUpload
              value={media}
              onChange={setMedia}
              max={1}
              compact={false}
            />
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Add a caption…"
              maxLength={120}
              className="flex h-10 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              disabled={media.length === 0 || submitting}
              onClick={() => void addStory()}
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Add story
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Story viewer */}
      {viewerOpen && current && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm">
          <button
            className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
            onClick={() => setViewerOpen(false)}
            aria-label="Close story"
          >
            <X className="size-5" />
          </button>
          {stories.length > 1 && (
            <>
              <button
                className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
                onClick={() =>
                  setViewing((v) => (v - 1 + stories.length) % stories.length)
                }
                aria-label="Previous story"
              >
                <ChevronLeft className="size-5" />
              </button>
              <button
                className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
                onClick={() => setViewing((v) => (v + 1) % stories.length)}
                aria-label="Next story"
              >
                <ChevronRight className="size-5" />
              </button>
            </>
          )}
          <div className="max-h-full w-full max-w-md px-4">
            <div className="mb-3 flex items-center gap-3">
              <Link
                to={`/u/${current.author?.username ?? ""}`}
                onClick={() => setViewerOpen(false)}
              >
                <UserAvatar user={current.author} className="size-10" />
              </Link>
              <div className="min-w-0">
                <p className="truncate font-semibold text-white">
                  {current.author?.name ?? current.author?.username}
                </p>
                <p className="text-xs text-white/60">24h story</p>
              </div>
            </div>
            <div className="relative overflow-hidden rounded-2xl bg-black">
              {current.media?.stripped === true ? (
                <MetadataStrippedChip className="z-10" />
              ) : null}
              {current.mediaKind === "image" && (
                <img
                  src={current.mediaUrl ?? ""}
                  alt={current.caption ?? "Story"}
                  className="max-h-[70vh] w-full object-contain"
                />
              )}
              {current.mediaKind === "video" && (
                <video
                  src={current.mediaUrl ?? ""}
                  controls
                  autoPlay
                  className="max-h-[70vh] w-full"
                />
              )}
              {current.mediaKind === "audio" && (
                <div className="flex flex-col items-center gap-4 p-10 text-white">
                  <AudioLines className="size-12" />
                  <audio src={current.mediaUrl ?? ""} controls className="w-full" />
                </div>
              )}
              {current.caption ? (
                <p className="border-t border-white/10 p-3 text-center text-sm text-white">
                  {current.caption}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
