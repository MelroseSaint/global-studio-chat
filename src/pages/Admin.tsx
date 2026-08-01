import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  Ban,
  CheckCheck,
  Flag,
  Heart,
  Image as ImageIcon,
  MessageCircle,
  MessagesSquare,
  ScanSearch,
  Shield,
  ShieldAlert,
  Trash2,
  UserCheck,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { UserAvatar } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { timeAgo } from "@/lib/format";

export function Admin() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (user && user.role !== "admin") {
    return (
      <div className="p-8 text-center">
        <Shield className="mx-auto size-10 text-muted-foreground" />
        <h1 className="mt-3 text-xl font-bold">Admins only</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You don&apos;t have permission to view this page.
        </p>
        <Button className="mt-4" onClick={() => navigate("/home")}>
          Back to home
        </Button>
      </div>
    );
  }

  if (!user) return null;

  return <AdminDashboard />;
}

const STAT_CARDS = [
  { key: "users", label: "Users", icon: Users },
  { key: "posts", label: "Posts", icon: MessagesSquare },
  { key: "follows", label: "Follows", icon: UserCheck },
  { key: "likes", label: "Likes", icon: Heart },
  { key: "comments", label: "Comments", icon: MessageCircle },
  { key: "stories", label: "Stories", icon: ImageIcon },
  { key: "openTickets", label: "Open tickets", icon: Flag },
  { key: "aiReview", label: "AI review", icon: ScanSearch },
  { key: "security", label: "Security", icon: ShieldAlert },
] as const;

function AdminDashboard() {
  const stats = useQuery(api.admin.dashboardStats);
  const [tab, setTab] = useState("users");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 pb-24 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Shield className="size-5 text-primary" />
          Admin dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Platform controls — users, verification, reports and content.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STAT_CARDS.map(({ key, label, icon: Icon }) => (
          <Card key={key}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon className="size-4" />
                <span className="text-xs font-medium">{label}</span>
              </div>
              <p className="mt-1 text-2xl font-bold">
                {stats === undefined ? "…" : String(stats[key])}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5">
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="posts">Content</TabsTrigger>
          <TabsTrigger value="aiReview">AI review</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "users" && <UsersPanel />}
      {tab === "tickets" && <TicketsPanel />}
      {tab === "posts" && <PostsPanel />}
      {tab === "aiReview" && <AiReviewPanel />}
      {tab === "security" && <SecurityPanel />}
    </div>
  );
}

function UsersPanel() {
  const setVerified = useMutation(api.admin.setVerified);
  const setRole = useMutation(api.admin.setRole);
  const { results, status, loadMore } = usePaginatedQuery(
    api.admin.listUsers,
    {},
    { initialNumItems: 15 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(15);
    }
  }, [inView, status, loadMore]);

  const users = results as unknown as {
    _id: string;
    name?: string | null;
    username?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
    verified?: boolean | null;
    role?: string | null;
    _creationTime: number;
  }[];

  return (
    <div className="flex flex-col gap-2">
      {status === "LoadingFirstPage" &&
        Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      {users.map((u, i) => (
        <motion.div
          key={u._id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.02, 0.3) }}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
        >
          <div className="flex min-w-0 items-center gap-3">
            <UserAvatar user={u} className="size-10" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {u.name || u.username || "Unknown"}
                {u.verified ? " ✓" : ""}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                @{u.username} · {u.email} · joined {timeAgo(u._creationTime)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{u.role ?? "user"}</Badge>
            <Button
              variant={u.verified ? "outline" : "default"}
              size="sm"
              onClick={() =>
                void setVerified({
                  userId: u._id as Id<"users">,
                  verified: !u.verified,
                })
              }
            >
              {u.verified ? "Unverify" : "Verify"}
            </Button>
            <select
              value={u.role ?? "user"}
              onChange={(e) =>
                void setRole({
                  userId: u._id as Id<"users">,
                  role: e.target.value as "user" | "creator" | "admin",
                })
              }
              className="h-8 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="user">User</option>
              <option value="creator">Creator</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
    </div>
  );
}

function TicketsPanel() {
  const respond = useMutation(api.support.respondToTicket);
  const { results, status, loadMore } = usePaginatedQuery(
    api.support.listTickets,
    {},
    { initialNumItems: 10 },
  );
  const { ref, inView } = useInView();
  const [reply, setReply] = useState<Record<string, string>>({});
  const [draftStatus, setDraftStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(10);
    }
  }, [inView, status, loadMore]);

  const tickets = results as unknown as {
    _id: string;
    _creationTime: number;
    subject: string;
    message: string;
    status: "open" | "in_review" | "resolved";
    violation?: string | null;
    user: { username?: string | null; name?: string | null } | null;
    post: { _id: string; content?: string } | null;
    offender: { username?: string | null; name?: string | null } | null;
  }[];

  const submit = async (ticketId: string, status: string) => {
    try {
      await respond({
        ticketId: ticketId as Id<"supportTickets">,
        reply: reply[ticketId]?.trim() || "Reviewed.",
        status: status as "open" | "in_review" | "resolved",
      });
      toast.success("Ticket updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {status === "LoadingFirstPage" &&
        Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      {tickets.length === 0 && status !== "LoadingFirstPage" && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No support tickets.
        </p>
      )}
      {tickets.map((t, i) => (
        <motion.div
          key={t._id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.03, 0.3) }}
          className="rounded-xl border p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold">{t.subject}</p>
            <Badge variant="outline">{t.status.replace("_", " ")}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            From <b>@{t.user?.username ?? "unknown"}</b> ·{" "}
            {timeAgo(t._creationTime)}
          </p>
          {t.violation ? (
            <p className="mt-2 text-sm">
              <span className="font-semibold">Violation:</span> {t.violation}
            </p>
          ) : null}
          {t.offender ? (
            <p className="text-sm">
              <span className="font-semibold">Reported user:</span>{" "}
              <Link
                to={`/u/${t.offender.username}`}
                className="text-primary hover:underline"
              >
                @{t.offender.username}
              </Link>
            </p>
          ) : null}
          {t.post ? (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">Post:</span>{" "}
              {t.post.content?.slice(0, 140)}
            </p>
          ) : null}
          <p className="mt-2 rounded-lg bg-muted/50 p-3 text-sm">{t.message}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Textarea
              value={reply[t._id] ?? ""}
              onChange={(e) =>
                setReply((r) => ({ ...r, [t._id]: e.target.value }))
              }
              placeholder="Write a response to the user…"
              rows={2}
            />
            <div className="flex shrink-0 items-center gap-2">
              <select
                value={draftStatus[t._id] ?? t.status}
                onChange={(e) =>
                  setDraftStatus((s) => ({ ...s, [t._id]: e.target.value }))
                }
                className="h-9 rounded-md border bg-transparent px-2 text-xs outline-none"
              >
                <option value="open">Open</option>
                <option value="in_review">In review</option>
                <option value="resolved">Resolved</option>
              </select>
              <Button
                size="sm"
                onClick={() =>
                  void submit(t._id, draftStatus[t._id] ?? t.status)
                }
              >
                Respond
              </Button>
            </div>
          </div>
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
    </div>
  );
}

function PostsPanel() {
  const moderatePost = useMutation(api.admin.moderatePost);
  const { results, status, loadMore } = usePaginatedQuery(
    api.admin.listRecentPosts,
    {},
    { initialNumItems: 15 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(15);
    }
  }, [inView, status, loadMore]);

  const posts = results as unknown as {
    _id: string;
    _creationTime: number;
    content: string;
    author: { username?: string | null; name?: string | null } | null;
  }[];

  const remove = async (postId: string) => {
    if (!window.confirm("Remove this post from the platform?")) return;
    try {
      await moderatePost({ postId: postId as Id<"posts"> });
      toast.success("Post removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove.");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {status === "LoadingFirstPage" &&
        Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      {posts.length === 0 && status !== "LoadingFirstPage" && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No posts yet.
        </p>
      )}
      {posts.map((p, i) => (
        <motion.div
          key={p._id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.02, 0.3) }}
          className="flex items-center justify-between gap-3 rounded-xl border p-3"
        >
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              <b className="text-foreground">@{p.author?.username}</b> ·{" "}
              {timeAgo(p._creationTime)}
            </p>
            <p className="mt-1 line-clamp-2 text-sm">{p.content}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to={`/post/${p._id}`}
              className="rounded-full border px-3 py-1 text-xs font-medium hover:bg-muted"
            >
              View
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive"
              onClick={() => void remove(p._id)}
              aria-label="Remove post"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
    </div>
  );
}

const STATUS_VARIANTS: Record<string, string> = {
  active: "secondary",
  suspicious: "outline",
  restricted: "default",
  banned: "destructive",
};

function SecurityPanel() {
  const setAccountStatus = useMutation(api.security.setAccountStatus);
  const { results, status, loadMore } = usePaginatedQuery(
    api.security.listFlaggedAccounts,
    {},
    { initialNumItems: 15 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(15);
    }
  }, [inView, status, loadMore]);

  const accounts = results as unknown as {
    _id: string;
    _creationTime: number;
    name?: string | null;
    username?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
    riskScore?: number | null;
    accountStatus?: string | null;
    riskReasons?: string[] | null;
  }[];

  const setStatus = async (userId: string, accountStatus: string) => {
    try {
      await setAccountStatus({
        userId: userId as Id<"users">,
        status: accountStatus as "active" | "suspicious" | "restricted" | "banned",
      });
      toast.success(`Account ${accountStatus}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {status === "LoadingFirstPage" &&
        Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      {accounts.length === 0 && status !== "LoadingFirstPage" && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No flagged accounts. Every new signup is screened for bot and farm
          signals; suspicious accounts land here for review.
        </p>
      )}
      {accounts.map((u, i) => (
        <motion.div
          key={u._id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.02, 0.3) }}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
        >
          <div className="flex min-w-0 items-center gap-3">
            <UserAvatar user={u} className="size-10" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {u.name || u.username || "Unknown"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                @{u.username} · {u.email} · risk {u.riskScore ?? 0}/100
              </p>
              {u.riskReasons && u.riskReasons.length > 0 ? (
                <p className="mt-0.5 flex flex-wrap gap-1">
                  {u.riskReasons.map((r) => (
                    <span
                      key={r}
                      className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive"
                    >
                      {r}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANTS[u.accountStatus ?? "active"] as "default"}>
              {u.accountStatus ?? "active"}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void setStatus(u._id, "active")}
            >
              <UserCheck className="size-4" />
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void setStatus(u._id, "restricted")}
            >
              <ShieldAlert className="size-4" />
              Restrict
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => void setStatus(u._id, "banned")}
            >
              <Ban className="size-4" />
              Ban
            </Button>
          </div>
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
    </div>
  );
}

function AiReviewPanel() {
  const moderatePost = useMutation(api.admin.moderatePost);
  const resolveAiReview = useMutation(api.admin.resolveAiReview);
  const { results, status, loadMore } = usePaginatedQuery(
    api.admin.listAiReview,
    {},
    { initialNumItems: 15 },
  );
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(15);
    }
  }, [inView, status, loadMore]);

  const posts = results as unknown as {
    _id: string;
    _creationTime: number;
    content: string;
    author: { username?: string | null; name?: string | null } | null;
  }[];

  const approve = async (postId: string) => {
    try {
      await resolveAiReview({ postId: postId as Id<"posts"> });
      toast.success("Marked as original — kept live.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    }
  };

  const remove = async (postId: string) => {
    if (!window.confirm("Remove this post from the platform?")) return;
    try {
      await moderatePost({ postId: postId as Id<"posts"> });
      toast.success("Post removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove.");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {status === "LoadingFirstPage" &&
        Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      {posts.length === 0 && status !== "LoadingFirstPage" && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No posts waiting on review. Every post is scanned for AI-generated
          text and image metadata before it goes live.
        </p>
      )}
      {posts.map((p, i) => (
        <motion.div
          key={p._id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.02, 0.3) }}
          className="flex items-center justify-between gap-3 rounded-xl border p-3"
        >
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              <b className="text-foreground">@{p.author?.username}</b> ·{" "}
              {timeAgo(p._creationTime)}
            </p>
            <p className="mt-1 line-clamp-2 text-sm">{p.content}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to={`/post/${p._id}`}
              className="rounded-full border px-3 py-1 text-xs font-medium hover:bg-muted"
            >
              View
            </Link>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void approve(p._id)}
              aria-label="Mark as original"
              title="Looks human — keep it live"
            >
              <CheckCheck className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive"
              onClick={() => void remove(p._id)}
              aria-label="Remove post"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
    </div>
  );
}
