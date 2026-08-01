import { useMutation, usePaginatedQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  AtSign,
  Bell,
  CheckCheck,
  Flag,
  Heart,
  MessageCircle,
  Repeat2,
  UserPlus,
} from "lucide-react";
import { useEffect } from "react";
import { useInView } from "react-intersection-observer";
import { Link } from "react-router";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";

const ICONS = {
  follow: UserPlus,
  like: Heart,
  comment: MessageCircle,
  share: Repeat2,
  mention: AtSign,
  system: Bell,
  ticket: Flag,
} as const;

export function Notifications() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.notifications.listNotifications,
    {},
    { initialNumItems: 20 },
  );
  const markAllRead = useMutation(api.notifications.markAllRead);
  const markRead = useMutation(api.notifications.markRead);

  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(20);
    }
  }, [inView, status, loadMore]);

  const notifications = results as unknown as {
    _id: string;
    _creationTime: number;
    type: keyof typeof ICONS;
    read: boolean;
    message?: string | null;
    actor: {
      _id: string;
      name?: string | null;
      username?: string | null;
      avatarUrl?: string | null;
    } | null;
    post: { _id: string; content?: string } | null;
  }[];

  const label = (n: (typeof notifications)[number]) => {
    const who = n.actor?.name ?? n.actor?.username ?? "Someone";
    switch (n.type) {
      case "follow":
        return (
          <>
            <b>{who}</b> started following you
          </>
        );
      case "like":
        return (
          <>
            <b>{who}</b> liked your post
          </>
        );
      case "comment":
        return (
          <>
            <b>{who}</b> commented on your post
          </>
        );
      case "share":
        return (
          <>
            <b>{who}</b> shared your post
          </>
        );
      case "mention":
        return (
          <>
            <b>{who}</b> mentioned you in a post
          </>
        );
      case "ticket":
        return (
          <>
            Your support request:{" "}
            <b>{n.message ?? "update"}</b>
          </>
        );
      case "system":
        return <>{n.message ?? "Update from PureWire"}</>;
    }
  };

  return (
    <div className="pb-20 lg:pb-0">
      <div className="flex items-center justify-between border-b px-4 py-4 sm:px-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            When someone responds to your words, it lands here.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void markAllRead()}
          className="gap-1.5"
        >
          <CheckCheck className="size-4" />
          Mark all read
        </Button>
      </div>

      {status === "LoadingFirstPage" && (
        <div className="space-y-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      )}

      {notifications.length === 0 && status !== "LoadingFirstPage" && (
        <div className="p-8">
          <Empty
            icon={Bell}
            title="You're all caught up"
            description="When someone reacts to your words, it shows up here."
          />
        </div>
      )}

      {notifications.map((n, i) => {
        const Icon = ICONS[n.type];
        return (
          <motion.div
            key={n._id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.3) }}
            onClick={() =>
              void markRead({ notificationId: n._id as Id<"notifications"> })
            }
            className="flex w-full cursor-pointer items-center gap-3 border-b px-4 py-3.5 text-left transition-colors hover:bg-muted/40 sm:px-5"
          >
            <span className="relative shrink-0">
              <UserAvatar user={n.actor} className="size-11" />
              <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background">
                <Icon className="size-3" />
              </span>
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={`text-sm leading-snug ${n.read ? "text-muted-foreground" : "text-foreground"}`}
              >
                {label(n)}
              </p>
              {n.post && n.post.content ? (
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  “{n.post.content.slice(0, 100)}”
                </p>
              ) : null}
              <p className="mt-0.5 text-xs text-muted-foreground">
                {timeAgo(n._creationTime)}
              </p>
            </div>
            {!n.read && (
              <span className="size-2.5 shrink-0 rounded-full bg-primary" />
            )}
            {n.post && (
              <Link
                to={`/post/${n.post._id}`}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
              >
                View
              </Link>
            )}
          </motion.div>
        );
      })}

      <div ref={ref} className="flex justify-center py-4">
        {status === "LoadingMore" && (
          <span className="text-sm text-muted-foreground">Loading more…</span>
        )}
      </div>
    </div>
  );
}
