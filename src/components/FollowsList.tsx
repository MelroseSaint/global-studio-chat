import { usePaginatedQuery } from "convex/react";
import { Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { Link } from "react-router";

import { api } from "@/convex/_generated/api";
import { FollowButton } from "@/components/FollowButton";
import { ProfileTypeBadge } from "@/components/ProfileTypeBadge";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type FollowsTab = "followers" | "following";

const TAB_LABEL: Record<FollowsTab, string> = {
  followers: "Followers",
  following: "Following",
};

/**
 * A profile's followers / following, in a dialog. Each count on the profile
 * opens the matching tab, the list is searchable by name or @username, and
 * every row links through to that person's profile — so you can click any
 * follower and land on their space.
 */
export function FollowsList({
  username,
  initialTab,
  open,
  onOpenChange,
}: {
  username: string;
  initialTab: FollowsTab;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<FollowsTab>(initialTab);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // Fresh state on every open: the profile remounts this dialog (via a
  // changing `key`) whenever a count is clicked, so the tab and search box
  // start clean each time.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const list = tab === "followers" ? api.users.listFollowers : api.users.listFollowing;
  // Paginated: browse mode scrolls the whole circle in pages, search mode
  // (a non-empty query) returns one bounded page that is immediately done.
  const { results, status, loadMore } = usePaginatedQuery(
    list,
    { username, query: debounced },
    { initialNumItems: 30 },
  );
  const { ref, inView } = useInView();

  // Keep loading while scrolling — the dialog body is the scroll container,
  // so the sentinel below it enters view as the list runs out.
  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(30);
    }
  }, [inView, status, loadMore]);

  const people = results as unknown as {
    _id: string;
    username?: string | null;
    name?: string | null;
    verified?: boolean;
    profileType?: string | null;
    avatarUrl?: string | null;
    isFollowing: boolean;
    isViewer: boolean;
  }[];
  const loading = status === "LoadingFirstPage";
  // The empty state only speaks when the whole list is actually exhausted —
  // a page that returns nothing while more pages remain is just a gap of
  // hidden accounts, and the sentinel below keeps loading them.
  const empty = status === "Exhausted" && people.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 p-0 sm:max-w-lg">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>{TAB_LABEL[tab]}</DialogTitle>
        </DialogHeader>

        {/* Tab switch */}
        <div className="grid shrink-0 grid-cols-1 gap-1 px-5 sm:grid-cols-2">
          {(["followers", "following"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                tab === value
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {TAB_LABEL[value]}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative shrink-0 px-5">
          <Search className="absolute left-8 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${TAB_LABEL[tab].toLowerCase()} by name or @username`}
            className="rounded-full pl-9"
            autoCapitalize="none"
            autoComplete="off"
          />
        </div>

        {/* Rows */}
        <div className="min-h-32 flex-1 overflow-y-auto px-2 pb-4">
          {loading ? (
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg p-2">
                  <Skeleton className="size-10 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
              ))}
            </div>
          ) : empty ? (
            <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
              <Users className="size-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">
                {debounced.length > 0
                  ? "No one matches your search."
                  : tab === "followers"
                    ? "No followers yet."
                    : "Not following anyone yet."}
              </p>
              <p className="text-xs text-muted-foreground">
                {debounced.length > 0
                  ? "Try a different name or @username."
                  : "When people join the circle, they'll show up here."}
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {people.map((person) => (
                <li
                  key={person._id}
                  className="flex items-center gap-2 rounded-lg p-1.5 transition-colors hover:bg-accent/50"
                >
                  <Link
                    to={`/u/${person.username}`}
                    onClick={() => onOpenChange(false)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-1.5"
                  >
                    <UserAvatar user={person} className="size-10 shrink-0" />
                    <div className="min-w-0">
                      <p className="flex items-center gap-1 truncate font-semibold">
                        {person.name || person.username}
                        <ProfileTypeBadge
                          profileType={person.profileType}
                          className="shrink-0"
                        />
                        {person.verified ? <VerifiedBadge className="shrink-0" /> : null}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        @{person.username}
                      </p>
                    </div>
                  </Link>
                  {person.isViewer ? (
                    <span className="shrink-0 pr-2 text-xs font-medium text-muted-foreground">
                      You
                    </span>
                  ) : (
                    <FollowButton
                      username={person.username ?? ""}
                      initialFollowing={person.isFollowing}
                      className="shrink-0"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {status === "LoadingMore" && (
            <div className="flex justify-center py-3 text-xs text-muted-foreground">
              Loading more…
            </div>
          )}
          <div ref={ref} aria-hidden="true" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
