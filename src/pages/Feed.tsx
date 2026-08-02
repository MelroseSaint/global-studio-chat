import { usePaginatedQuery } from "convex/react";
import { motion } from "framer-motion";
import { Inbox, LocateFixed, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";

import { api } from "@/convex/_generated/api";
import { Composer } from "@/components/Composer";
import { PostCard, type PostItem } from "@/components/PostCard";
import { StoriesBar } from "@/components/StoriesBar";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getBrowserLocation } from "@/lib/geo";
import { cn } from "@/lib/utils";

type Filter = "global" | "following" | "latest" | "local" | "media";

// No algorithms on PureWire — you choose what you see. On phones the
// "Photos & videos" tab shortens to "Media" so all five tabs fit without
// truncating (a full label would cram the strip on a narrow screen).
const FILTERS: { value: Filter; label: string; short?: string }[] = [
  { value: "global", label: "Global" },
  { value: "following", label: "Following" },
  { value: "latest", label: "Latest" },
  { value: "local", label: "Local" },
  { value: "media", label: "Photos & videos", short: "Media" },
];

const RADII_KM = [10, 25, 50, 150] as const;

export function Feed() {
  const [filter, setFilter] = useTabsState<Filter>("global");
  // The viewer's anchor for the Local tab: the live browser position.
  const [viewerPoint, setViewerPoint] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [locating, setLocating] = useState(false);
  const [radiusKm, setRadiusKm] = useState(50);

  // The Local tab is a "near me, only while browsing" mode: the anchor is
  // the live browser position, held in memory for this request and never
  // persisted. Home locations are label-only, so there is no stored fallback.
  const locate = async () => {
    if (locating || viewerPoint !== null) return;
    setLocating(true);
    const pos = await getBrowserLocation();
    if (pos !== null) setViewerPoint(pos);
    setLocating(false);
  };

  const { results, status, loadMore } = usePaginatedQuery(
    api.posts.feed,
    filter === "local"
      ? viewerPoint !== null
        ? {
            filter,
            location: viewerPoint,
            radiusKm,
          }
        : { filter, radiusKm }
      : { filter },
    { initialNumItems: 10 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(10);
    }
  }, [inView, status, loadMore]);

  // results is undefined only before the first page loads — default to an
  // empty array so the map below is safe.
  const posts = (results ?? []) as unknown as PostItem[];

  // When the viewer hasn't granted live location, the Local tab still runs
  // (the server falls back to their stored home anchor — a coarsened
  // ~1 km cell, never exact). The prompt is only a hint, not a blocker, and
  // only shows when the fallback produced nothing (no anchor, or an empty
  // area) — not while home-anchor posts are actually rendering.
  const localEmpty =
    filter === "local" &&
    !locating &&
    viewerPoint === null &&
    posts.length === 0 &&
    status !== "LoadingFirstPage";

  return (
    <div className="pb-20 lg:pb-0">
      <div className="sticky top-14 z-20 border-b bg-background/80 backdrop-blur lg:top-0">
        <Tabs
          value={filter}
          onValueChange={(v) => {
            const next = v as Filter;
            setFilter(next);
            if (next === "local") void locate();
          }}
        >
          <TabsList className="h-auto w-full justify-start rounded-none bg-transparent p-0">
            {FILTERS.map((f) => (
              <TabsTrigger
                key={f.value}
                value={f.value}
                className={cn(
                  "min-w-0 flex-1 rounded-none border-b-2 border-transparent px-1.5 py-3 sm:px-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
                )}
              >
                <span className="truncate sm:hidden">{f.short ?? f.label}</span>
                <span className="hidden truncate sm:inline">{f.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {filter === "local" ? (
          <div className="flex items-center justify-between gap-2 border-t px-4 py-2 sm:px-5">
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {locating ? (
                <>
                  <LocateFixed className="size-3.5 shrink-0 animate-pulse" />
                  Locating you…
                </>
              ) : viewerPoint !== null ? (
                <>
                  <MapPin className="size-3.5 shrink-0 text-primary" />
                  Showing posts near you — never saved
                </>
              ) : (
                <>
                  <MapPin className="size-3.5 shrink-0" />
                  Showing posts near your home area — coarsened, never exact
                </>
              )}
            </p>
            <select
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              aria-label="Search radius"
              className="h-7 shrink-0 rounded-md border bg-transparent px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {RADII_KM.map((r) => (
                <option key={r} value={r}>
                  {r} km
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <StoriesBar />
      <Composer />

      {status === "LoadingFirstPage" && (
        <div className="flex flex-col gap-4 p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex gap-3 p-3">
              <Skeleton className="size-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      )}

      {localEmpty && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-8"
        >
          <Empty
            icon={MapPin}
            title="Nothing nearby yet"
            description="The Local tab centers on your home location — a coarsened ~1 km area, never your exact point — when you're not granting live access. Allow location access for a truer 'near me', or add a home location in Settings."
            action={
              <button
                onClick={() => void locate()}
                className="inline-flex items-center rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                Allow location access
              </button>
            }
          />
        </motion.div>
      )}

      {posts.length === 0 && status !== "LoadingFirstPage" && !localEmpty && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-8"
        >
          <Empty
            icon={Inbox}
            title={
              filter === "following"
                ? "Nothing from people you follow yet"
                : filter === "local"
                  ? "Nothing nearby yet"
                  : "No posts yet"
            }
            description={
              filter === "following"
                ? "Follow some creators and their posts will show up here."
                : filter === "local"
                  ? "Posts shared near your home area will show up here. Share something from your own corner of the world."
                  : "Be the first to share something with the community."
            }
          />
        </motion.div>
      )}

      {posts.map((post) => (
        <PostCard key={post._id} post={post} />
      ))}

      <div ref={ref} className="flex justify-center py-6">
        {status === "LoadingMore" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-primary" />
            Loading more…
          </div>
        )}
      </div>
    </div>
  );
}

/** Small hook to keep the active filter as local state. */
function useTabsState<T extends string>(initial: T) {
  const [value, setValue] = useState<T>(initial);
  return [value, setValue] as const;
}
