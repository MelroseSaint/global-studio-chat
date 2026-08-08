import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
import {
  cloudinaryVideoUrl,
  responsiveImageAttrs,
} from "@/lib/cloudinary-media";
import { timeAgo } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";

export function StoriesBar() {
  const { user } = useAuth();
  const stories = useQuery(api.stories.listStories);
  const createStory = useAction(api.stories.createStory);
  const scanMedia = useAction(api.aiContent.scanMediaForAi);
  const stripMedia = useAction(api.media.stripVideoMetadata);
  const recordView = useMutation(api.stories.recordStoryView);
  const [addOpen, setAddOpen] = useState(false);
  const [viewing, setViewing] = useState<number>(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);
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
      // Dual-mode: Cloudinary media passes its external URL, Convex media its id.
      const scan = await scanMedia({
        media: [
          { storageId: media[0].storageId, url: media[0].externalUrl, kind: media[0].kind },
        ],
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
            url: media[0].externalUrl,
            key: media[0].key,
            kind: media[0].kind,
            stripped: media[0].stripped,
          },
        ],
      });
      const res = await createStory({
        media: cleaned[0],
        caption: caption.trim() || undefined,
        aiMediaStatus: scan.status,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not add story.");
        return;
      }
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

  // Opening (or paging to) a story records the view — unless it's the
  // viewer's own story, which recordStoryView already ignores server-side.
  const openViewer = (index: number) => {
    setViewing(index);
    setViewerOpen(true);
    const story = stories[index];
    if (story !== undefined && story.authorId !== user?._id) {
      void recordView({ storyId: story._id as Id<"stories"> });
    }
  };

  // Computed outside the state updater — updaters must stay pure (React may
  // double-invoke them in Strict Mode). The view fires exactly once.
  const step = (dir: 1 | -1) => {
    const next = (viewing + dir + stories.length) % stories.length;
    setViewing(next);
    const story = stories[next];
    if (story !== undefined && story.authorId !== user?._id) {
      void recordView({ storyId: story._id as Id<"stories"> });
    }
  };

  const current = stories[viewing];
  const isOwn = current !== undefined && current.authorId === user?._id;

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
                onClick={() => step(1)}
                aria-label="Next story"
              >
                <ChevronRight className="size-5" />
              </button>
            </>
          )}
          <div className="max-h-full w-full max-w-md px-4">
            <div className="mb-3 flex items-center gap-3">
              {current.author?.username ? (
                <Link
                  to={`/u/${current.author.username}`}
                  onClick={() => setViewerOpen(false)}
                >
                  <UserAvatar user={current.author} className="size-10" />
                </Link>
              ) : (
                <UserAvatar user={current.author} className="size-10" />
              )}
              <div className="min-w-0">
                <p className="truncate font-semibold text-white">
                  {current.author?.name ?? current.author?.username}
                </p>
                <p className="text-xs text-white/60">24h story</p>
              </div>
              {isOwn ? (
                <button
                  type="button"
                  onClick={() => setViewersOpen(true)}
                  className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20"
                >
                  <Eye className="size-3.5" />
                  Viewers
                </button>
              ) : null}
            </div>
            <div className="relative overflow-hidden rounded-2xl bg-black">
              {current.media?.stripped === true ? (
                <MetadataStrippedChip className="z-10" />
              ) : null}
              {current.mediaKind === "image" && (
                <img
                  {...responsiveImageAttrs(current.mediaUrl ?? "")}
                  alt={current.caption ?? "Story"}
                  className="max-h-[70vh] w-full object-contain"
                />
              )}
              {current.mediaKind === "video" && (
                <video
                  src={cloudinaryVideoUrl(current.mediaUrl ?? "") ?? ""}
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

      {/* Who viewed your story — author-only, paginated. */}
      {viewersOpen && current !== undefined && isOwn && (
        <StoryViewersDialog
          storyId={current._id as Id<"stories">}
          open={viewersOpen}
          onOpenChange={setViewersOpen}
        />
      )}
    </>
  );
}

/**
 * The "who viewed this story" list. Only the story's author (or an admin)
 * may open it — the server returns an empty page to anyone else. Newest
 * views first, paginated so a viral story's full audience stays browsable.
 */
function StoryViewersDialog({
  storyId,
  open,
  onOpenChange,
}: {
  storyId: Id<"stories">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.stories.listStoryViewers,
    { storyId },
    { initialNumItems: 20 },
  );
  const viewers = results as unknown as {
    _id: string;
    name?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
    viewedAt: number;
  }[];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="size-4" />
            Who viewed your story
          </DialogTitle>
          <DialogDescription>
            {viewers.length === 0
              ? "No one has viewed it yet. Only people who open your story appear here — and only you can see this list."
              : "Only you can see this list. Re-views count once."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {status === "LoadingFirstPage" &&
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/50" />
            ))}
          {viewers.map((v) => (
            <div
              key={v._id}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50"
            >
              {v.username ? (
                <Link
                  to={`/u/${v.username}`}
                  onClick={() => onOpenChange(false)}
                  className="flex min-w-0 items-center gap-3"
                >
                  <UserAvatar user={v} className="size-9" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {v.name || v.username}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      @{v.username} · viewed {timeAgo(v.viewedAt)}
                    </span>
                  </span>
                </Link>
              ) : (
                <span className="flex min-w-0 items-center gap-3">
                  <UserAvatar user={v} className="size-9" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {v.name || "Unknown"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      viewed {timeAgo(v.viewedAt)}
                    </span>
                  </span>
                </span>
              )}
            </div>
          ))}
          {status === "CanLoadMore" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadMore(20)}
              className="mt-1"
            >
              Load more
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
