import { usePaginatedQuery } from "convex/react";
import { motion } from "framer-motion";
import { Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";

import { api } from "@/convex/_generated/api";
import { Composer } from "@/components/Composer";
import { PostCard, type PostItem } from "@/components/PostCard";
import { StoriesBar } from "@/components/StoriesBar";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type Filter = "global" | "following" | "latest" | "media";

// No algorithms on PureWire — you choose what you see.
const FILTERS: { value: Filter; label: string }[] = [
  { value: "global", label: "Global" },
  { value: "following", label: "Following" },
  { value: "latest", label: "Latest" },
  { value: "media", label: "Photos & videos" },
];

export function Feed() {
  const [filter, setFilter] = useTabsState<Filter>("global");
  const { results, status, loadMore } = usePaginatedQuery(
    api.posts.feed,
    { filter },
    { initialNumItems: 10 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(10);
    }
  }, [inView, status, loadMore]);

  const posts = results as unknown as PostItem[];

  return (
    <div className="pb-20 lg:pb-0">
      <div className="sticky top-14 z-20 border-b bg-background/80 backdrop-blur lg:top-0">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList className="h-auto w-full justify-start rounded-none bg-transparent p-0">
            {FILTERS.map((f) => (
              <TabsTrigger
                key={f.value}
                value={f.value}
                className={cn(
                  "flex-1 rounded-none border-b-2 border-transparent py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
                )}
              >
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
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

      {posts.length === 0 && status !== "LoadingFirstPage" && (
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
                : "No posts yet"
            }
            description={
              filter === "following"
                ? "Follow some creators and their posts will show up here."
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
