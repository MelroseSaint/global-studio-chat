import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import { Compass, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { api } from "@/convex/_generated/api";
import { FollowButton } from "@/components/FollowButton";
import { ProfileTypeBadge } from "@/components/ProfileTypeBadge";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export function Explore() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const results = useQuery(
    api.users.searchUsers,
    debounced ? { query: debounced } : "skip",
  );
  const suggested = useQuery(api.users.suggestedUsers);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="flex flex-col gap-6 p-4 pb-24 sm:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Discover</h1>
        <p className="text-sm text-muted-foreground">
          Find your people — search by name or @username.
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or @username"
          className="rounded-full pl-10"
          autoCapitalize="none"
        />
      </div>

      {debounced ? (
        <div className="flex flex-col gap-1">
          <p className="px-1 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Search results
          </p>
          {results === undefined ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <Empty
              icon={Search}
              title="No matches"
              description={`Nothing found for “${debounced}”. Try a different name or @username.`}
            />
          ) : (
            results.map((u, i) => (
              <motion.div
                key={u._id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="flex items-center justify-between gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/50"
              >
                <Link
                  to={`/u/${u.username}`}
                  className="flex min-w-0 items-center gap-3"
                >
                  <UserAvatar user={u} className="size-11" />
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 truncate font-semibold">
                      {u.name || u.username}
                      <ProfileTypeBadge
                        profileType={u.profileType}
                        className="shrink-0"
                      />
                      {u.verified ? <VerifiedBadge className="shrink-0" /> : null}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      @{u.username}
                    </p>
                    {u.bio ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {u.bio}
                      </p>
                    ) : null}
                  </div>
                </Link>
                <FollowButton
                  username={u.username ?? ""}
                  initialFollowing={false}
                  className="shrink-0"
                />
              </motion.div>
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Compass className="size-3.5" />
            Discover
          </p>
          {suggested === undefined ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : suggested.length === 0 ? (
            <Empty
              icon={Compass}
              title="All caught up"
              description="You're following everyone we'd suggest. Keep creating!"
            />
          ) : (
            suggested.map((u, i) => (
              <motion.div
                key={u._id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="flex items-center justify-between gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/50"
              >
                <Link
                  to={`/u/${u.username}`}
                  className="flex min-w-0 items-center gap-3"
                >
                  <UserAvatar user={u} className="size-11" />
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 truncate font-semibold">
                      {u.name || u.username}
                      <ProfileTypeBadge
                        profileType={u.profileType}
                        className="shrink-0"
                      />
                      {u.verified ? <VerifiedBadge className="shrink-0" /> : null}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      @{u.username}
                    </p>
                    {u.bio ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {u.bio}
                      </p>
                    ) : null}
                  </div>
                </Link>
                <FollowButton
                  username={u.username ?? ""}
                  initialFollowing={false}
                  className="shrink-0"
                />
              </motion.div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
