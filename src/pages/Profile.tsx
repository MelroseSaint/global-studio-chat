import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { Ban, CalendarDays, Link2, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { FollowButton } from "@/components/FollowButton";
import { PostCard, type PostItem } from "@/components/PostCard";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount, platformUrl } from "@/lib/format";

export function Profile() {
  const { username = "" } = useParams();
  const navigate = useNavigate();
  const profile = useQuery(api.users.getProfile, { username });
  const blockUser = useMutation(api.security.blockUser);
  const unblockUser = useMutation(api.security.unblockUser);
  const blocked = useQuery(api.security.isBlocked, { username });
  const [blocking, setBlocking] = useState(false);
  const { results, status, loadMore } = usePaginatedQuery(
    api.posts.listUserPosts,
    profile?._id ? { userId: profile._id } : "skip",
    { initialNumItems: 10 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(10);
    }
  }, [inView, status, loadMore]);

  useEffect(() => {
    if (profile === null) {
      toast.error("That profile doesn't exist.");
      navigate("/home", { replace: true });
    }
  }, [profile, navigate]);

  if (profile === undefined) {
    return (
      <div className="p-4 sm:p-6">
        <Skeleton className="h-40 rounded-2xl" />
        <div className="flex items-end gap-4 px-4">
          <Skeleton className="-mt-10 size-24 rounded-full" />
          <Skeleton className="h-8 w-28" />
        </div>
        <div className="mt-6 space-y-2 px-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
    );
  }

  if (profile === null) {
    return null;
  }

  const posts = results as unknown as PostItem[];

  const toggleBlock = async () => {
    if (blocking || profile.username === undefined) return;
    setBlocking(true);
    try {
      if (blocked) {
        await unblockUser({ username: profile.username });
        toast.success("Unblocked.");
      } else {
        await blockUser({ username: profile.username });
        toast.success("Blocked. Their posts and profile are now hidden from you.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    } finally {
      setBlocking(false);
    }
  };

  return (
    <div className="pb-20 lg:pb-0">
      {/* Banner */}
      <div className="h-40 w-full overflow-hidden bg-gradient-to-br from-primary/40 via-accent/40 to-primary/30 sm:h-52">
        {profile.bannerUrl ? (
          <img
            src={profile.bannerUrl}
            alt=""
            className="size-full object-cover"
          />
        ) : null}
      </div>

      <div className="px-4 sm:px-6">
        <div className="flex items-end justify-between gap-3">
          <div className="-mt-12 rounded-full ring-4 ring-background">
            <UserAvatar
              user={profile}
              className="size-24 rounded-full"
              ring
            />
          </div>
          <div className="flex items-center gap-2 pb-1">
            {profile.isSelf ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/settings">
                  <Settings2 className="size-4" />
                  Edit profile
                </Link>
              </Button>
            ) : (
              <>
                <FollowButton
                  username={profile.username ?? ""}
                  initialFollowing={profile.isFollowing}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={blocking || blocked === undefined}
                  onClick={() => void toggleBlock()}
                  className="text-destructive hover:text-destructive"
                >
                  <Ban className="size-4" />
                  {blocked ? "Unblock" : "Block"}
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="mt-3">
          <h1 className="flex items-center gap-1.5 text-xl font-bold tracking-tight">
            {profile.name || profile.username}
            {profile.verified ? <VerifiedBadge className="shrink-0" /> : null}
          </h1>
          <p className="text-sm text-muted-foreground">@{profile.username}</p>
          {profile.role === "creator" && (
            <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
              ✦ Creator
            </p>
          )}
        </div>

        {profile.bio ? (
          <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed">
            {profile.bio}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CalendarDays className="size-4" />
            Joined{" "}
            {new Date(profile._creationTime).toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
          </span>
          {profile.links && profile.links.length > 0 ? (
            <span className="flex items-center gap-1.5">
              <Link2 className="size-4" />
              {profile.links.slice(0, 3).map((link, i) => (
                <a
                  key={i}
                  href={platformUrl(link.platform, link.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {link.platform}
                  {i < profile.links!.slice(0, 3).length - 1 ? ", " : ""}
                </a>
              ))}
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex items-center gap-5 text-sm">
          <span>
            <span className="font-bold">
              {formatCount(profile.postsCount ?? 0)}
            </span>{" "}
            <span className="text-muted-foreground">Posts</span>
          </span>
          <span>
            <span className="font-bold">
              {formatCount(profile.followersCount ?? 0)}
            </span>{" "}
            <span className="text-muted-foreground">Followers</span>
          </span>
          <span>
            <span className="font-bold">
              {formatCount(profile.followingCount ?? 0)}
            </span>{" "}
            <span className="text-muted-foreground">Following</span>
          </span>
        </div>
      </div>

      <div className="mt-5 border-t">
        {status === "LoadingFirstPage" && (
          <div className="flex flex-col gap-4 p-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        )}
        {posts.length === 0 && status !== "LoadingFirstPage" ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {profile.isSelf
              ? "This is your space — say it anyway."
              : "Nothing here yet. An open space."}
          </p>
        ) : (
          posts.map((post, i) => (
            <motion.div
              key={post._id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3) }}
            >
              <PostCard post={post} />
            </motion.div>
          ))
        )}
        <div ref={ref} className="flex justify-center py-6">
          {status === "LoadingMore" && (
            <div className="text-sm text-muted-foreground">Loading more…</div>
          )}
        </div>
      </div>
    </div>
  );
}
