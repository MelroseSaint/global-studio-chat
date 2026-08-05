import { usePaginatedQuery, useQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  Ban,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ChevronsRight,
  Ellipsis,
  EyeOff,
  Flag,
  History,
  Image as ImageIcon,
  Loader2,
  Lock,
  MessagesSquare,
  ScanSearch,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  Unlock,
  UserCheck,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AdminOfflineBanner } from "@/components/AdminOfflineBanner";
import { AiEvidencePanel } from "@/components/AiEvidencePanel";
import { BlocklistPanel } from "@/components/BlocklistPanel";
import { StandardViolationDialog } from "@/components/StandardViolationDialog";
import { UserAvatar } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { useOfflineMutation } from "@/hooks/use-offline-mutation";
import { timeAgo } from "@/lib/format";
import { STANDARD_PRINCIPLES, standardById } from "@/lib/standard";

/** A small badge naming the Standard principle an account was cited under. */
function StandardChip({ standardId }: { standardId?: string | null }) {
  const principle = standardById(standardId);
  if (principle === undefined) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-moss/15 px-2 py-0.5 text-[11px] font-medium text-moss">
      <ShieldCheck className="size-3" />
      {principle.title}
    </span>
  );
}

/**
 * Confirm-and-remove dialog for permanently erasing an account. Removal is
 * irreversible — the full erasure sweep (profile, posts, comments, likes,
 * stories, follows, files) — so two gates protect it: the admin must type
 * the account's username, AND cite the PureWire Standard principle the
 * removal is taken under. The citation is recorded in the audit trail
 * before the erasure starts, so even a permanent removal leaves a reason.
 */
function RemoveAccountDialog({
  open,
  onOpenChange,
  user,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { _id: string; username?: string | null; name?: string | null } | null;
  onConfirm: (userId: string, standardId: string, note: string) => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [standardId, setStandardId] = useState("");
  const [note, setNote] = useState("");
  const expected = (user?.username ?? user?.name ?? "").trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset the form each time the dialog is opened.
        if (next) {
          setTyped("");
          setStandardId("");
          setNote("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="size-4" />
            Remove account permanently
          </DialogTitle>
          <DialogDescription>
            This erases <b>@{user?.username ?? "this user"}</b> and every
            trace of them — profile, posts, comments, likes, stories,
            follows, notifications, and uploaded files. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="remove-confirm">
              Type <b>@{expected}</b> to confirm
            </Label>
            <Input
              id="remove-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`@${expected}`}
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>PureWire Standard principle violated</Label>
            <Select value={standardId} onValueChange={setStandardId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a principle" />
              </SelectTrigger>
              <SelectContent>
                {STANDARD_PRINCIPLES.map((p, i) => (
                  <SelectItem key={p.id} value={p.id}>
                    {i + 1}. {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The citation is recorded in the audit trail before the erasure
              starts, so this removal always leaves a reason.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Note (optional)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the team should know about this removal…"
              rows={3}
              maxLength={500}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={
              typed.trim() !== expected || standardId.length === 0 || busy
            }
            onClick={() => {
              if (user) onConfirm(user._id, standardId, note.trim());
            }}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Remove account"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirm-and-reinstate dialog for restoring a moderated account. The
 * reason is REQUIRED and recorded on the account's audit trail, so every
 * restore — like every restriction — leaves a "who, when, why". The
 * optional Standard principle the action is taken under rides along.
 * Removed accounts can't appear here: the erasure sweep destroys the
 * account and its data by design, so there is nothing to restore.
 */
function ReinstateAccountDialog({
  open,
  onOpenChange,
  user,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { _id: string; username?: string | null; name?: string | null } | null;
  busy?: boolean;
  onConfirm: (userId: string, standardId: string, note: string) => void;
}) {
  const [standardId, setStandardId] = useState("");
  const [note, setNote] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset the form each time the dialog is opened.
        if (next) {
          setStandardId("");
          setNote("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-moss">
            <UserCheck className="size-4" />
            Reinstate account
          </DialogTitle>
          <DialogDescription>
            Restores <b>@{user?.username ?? "this user"}</b> to full active
            status — their profile, posts, and engagement become public
            again, and any quiet silence is lifted. Removed accounts can&apos;t
            be reinstated: the erasure sweep destroys the account and its
            data by design, so there is nothing left to restore.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why is this reinstatement called for? (false positive, appeal granted, …)"
              rows={3}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">
              Recorded on the account&apos;s audit trail, so every restore
              leaves a reason like every restriction does.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>PureWire Standard principle (optional)</Label>
            <Select value={standardId} onValueChange={setStandardId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a principle (if one applies)" />
              </SelectTrigger>
              <SelectContent>
                {STANDARD_PRINCIPLES.map((p, i) => (
                  <SelectItem key={p.id} value={p.id}>
                    {i + 1}. {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={note.trim().length === 0 || busy}
            onClick={() => {
              if (user) onConfirm(user._id, standardId, note.trim());
            }}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Reinstate account"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

  return <AdminDashboard meId={user._id} />;
}

const STAT_CARDS = [
  { key: "users", label: "Users", icon: Users },
  { key: "posts", label: "Posts", icon: MessagesSquare },
  { key: "aiReview", label: "AI review", icon: ScanSearch },
  { key: "openTickets", label: "Open tickets", icon: Flag },
  { key: "stories", label: "Stories", icon: ImageIcon },
] as const;

function AdminDashboard({ meId }: { meId: string }) {
  const raw = useQuery(api.admin.dashboardStats);
  // Map backend key names to frontend tab keys where they differ.
  const stats = raw === undefined ? undefined : { ...raw };
  const [tab, setTab] = useState("users");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 overflow-x-clip p-4 pb-24 sm:p-6">
      <AdminOfflineBanner />
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Shield className="size-5 text-primary" />
          Admin dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Guardians of the Standard — users, verification, reports and content.
        </p>
      </div>

      {/* Stats strip: key metrics in a responsive grid that never overflows. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {STAT_CARDS.map(({ key, label, icon: Icon }) => (
          <Card key={key}>
            <CardContent className="p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Icon className="size-4 shrink-0" />
                <span className="text-xs font-medium">{label}</span>
              </div>
              <p className="mt-1 text-xl font-bold sm:text-2xl">
                {stats === undefined ? "\u2026" : String(stats[key])}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tab bar: single scrollable row — never wraps, never overlaps. */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex w-full gap-1 overflow-x-auto">
          <TabsTrigger value="users" className="shrink-0">Users</TabsTrigger>
          <TabsTrigger value="tickets" className="shrink-0">Tickets</TabsTrigger>
          <TabsTrigger value="posts" className="shrink-0">Content</TabsTrigger>
          <TabsTrigger value="aiReview" className="shrink-0">AI review</TabsTrigger>
          <TabsTrigger value="racismReview" className="shrink-0">Racism</TabsTrigger>
          <TabsTrigger value="storyReview" className="shrink-0">Stories</TabsTrigger>
          <TabsTrigger value="security" className="shrink-0">Security</TabsTrigger>
          <TabsTrigger value="silenced" className="shrink-0">Silenced</TabsTrigger>
          <TabsTrigger value="blocklist" className="shrink-0">Blocklist</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "users" && <UsersPanel meId={meId} />}
      {tab === "tickets" && <TicketsPanel />}
      {tab === "posts" && <PostsPanel />}
      {tab === "aiReview" && <AiReviewPanel />}
      {tab === "racismReview" && <RacismReviewPanel />}
      {tab === "storyReview" && <StoryReviewPanel />}
      {tab === "security" && <SecurityPanel />}
      {tab === "silenced" && <SilencedPanel />}
      {tab === "blocklist" && <BlocklistPanel />}
    </div>
  );
}

function UsersPanel({ meId }: { meId: string }) {
  const setVerified = useOfflineMutation(api.admin.setVerified, "admin.setVerified");
  const setRole = useOfflineMutation(api.admin.setRole, "admin.setRole");
  const removeAccount = useOfflineMutation(api.admin.removeAccount, "admin.removeAccount");
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

  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const confirmRemove = async (userId: string, standardId: string, note: string) => {
    setRemoving(true);
    try {
      const res = await removeAccount({
        userId: userId as Id<"users">,
        standardId,
        note,
      });
      setPendingRemove(null);
      if (res) return;
      toast.success("Account removed — every trace of them is gone.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove.");
    } finally {
      setRemoving(false);
    }
  };

  const users = results as unknown as {
    _id: string;
    name?: string | null;
    username?: string | null;
    maskedEmail?: string | null;
    avatarUrl?: string | null;
    verified?: boolean | null;
    role?: string | null;
    isOwner?: boolean;
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
                @{u.username} · {u.maskedEmail} · joined {timeAgo(u._creationTime)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            <Badge variant="outline">{u.role ?? "user"}</Badge>
            {u.isOwner ? (
              <Badge
                variant="outline"
                className="gap-1 border-oxide/40 bg-oxide/5 text-oxide"
                title="The owner account is fixed — it can never be changed, demoted, or removed."
              >
                <Lock className="size-3" />
                Owner
              </Badge>
            ) : null}
            <Button
              variant={u.verified ? "outline" : "default"}
              size="sm"
              disabled={u.isOwner}
              title={
                u.isOwner
                  ? "The owner account is fixed — its badge cannot be changed."
                  : undefined
              }
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
              disabled={u.isOwner}
              title={
                u.isOwner
                  ? "The owner account is fixed — its role cannot be changed."
                  : undefined
              }
              onChange={(e) =>
                void setRole({
                  userId: u._id as Id<"users">,
                  role: e.target.value as "user" | "creator" | "admin",
                })
              }
              className="h-8 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="user">User</option>
              <option value="creator">Creator</option>
              <option value="admin">Admin</option>
            </select>
            {u._id !== meId && !u.isOwner ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    aria-label={`Actions for ${u.username ?? u.name ?? "user"}`}
                  >
                    <Ellipsis className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setPendingRemove(u._id)}
                  >
                    <Trash2 className="size-4" />
                    Remove account
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
      <RecentRemovals />
      <RemoveAccountDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        user={users.find((u) => u._id === pendingRemove) ?? null}
        busy={removing}
        onConfirm={(userId, standardId, note) =>
          void confirmRemove(userId, standardId, note)
        }
      />
    </div>
  );
}

/**
 * The private removal log — a permanent, one-way record of every admin
 * removal. Written before the erasure sweep into a dedicated table the
 * sweep never touches, so it is complete even for accounts whose data is
 * long gone: each row names who was removed (handle, display name, and
 * the salted email hash — never the address), who acted, the cited
 * Standard principle, and when. Nothing here can restore the account.
 */
function RecentRemovals() {
  const { results, status } = usePaginatedQuery(
    api.admin.listRemovals,
    {},
    { initialNumItems: 10 },
  );
  // Collapsed by default: the log is a one-way audit record, not a working
  // surface, and on tablets (where every vertical line costs a scroll) a
  // wall of old removals buried the actual user list. One tap reveals the
  // entries; the count stays visible so the workload is never hidden.
  const [open, setOpen] = useState(false);
  const removals = results as unknown as {
    username: string | null;
    name: string | null;
    emailHash: string | null;
    actorUsername: string | null;
    standardId: string | null;
    note: string | null;
    createdAt: number;
  }[];
  if (status === "LoadingFirstPage") {
    return <Skeleton className="h-16" />;
  }
  if (removals.length === 0) {
    return null;
  }
  return (
    <div className="rounded-xl border border-dashed">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Who was removed, when, and by whom. One-way: it can never restore the account."
        className="flex w-full items-center justify-between gap-2 rounded-xl p-3 text-left text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Lock className="size-3.5 shrink-0" />
          <span className="truncate">
            Removal log — {status === "CanLoadMore" ? `${removals.length}+` : removals.length}{" "}
            removed {removals.length === 1 ? "account" : "accounts"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="hidden font-normal text-muted-foreground/70 sm:inline">
            one-way, never restores
          </span>
          {open ? (
            <ChevronUp className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-dashed p-3">
          {removals.map((r, i) => (
            <div
              key={`${r.username}-${r.createdAt}-${i}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-1.5 text-xs"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
                  @{r.username ?? "removed account"}
                </span>
                {r.name ? (
                  <span className="truncate font-medium">{r.name}</span>
                ) : null}
                {r.emailHash ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                    title="Salted one-way hash of their email — stored instead of the address, never reversible"
                  >
                    <Lock className="size-2.5" />
                    {r.emailHash.slice(0, 10)}…
                  </span>
                ) : null}
                <span className="truncate text-muted-foreground">
                  {r.actorUsername
                    ? `removed by @${r.actorUsername}`
                    : "removed by an admin"}
                  {r.note ? ` — ${r.note}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {r.standardId ? <StandardChip standardId={r.standardId} /> : null}
                <span className="shrink-0 text-muted-foreground">
                  {timeAgo(r.createdAt)}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TicketsPanel() {
  const respond = useOfflineMutation(api.support.respondToTicket, "support.respondToTicket");
  const { results, status, loadMore } = usePaginatedQuery(
    api.support.listTickets,
    {},
    { initialNumItems: 10 },
  );
  const { ref, inView } = useInView();
  const [reply, setReply] = useState<Record<string, string>>({});
  const [draftStatus, setDraftStatus] = useState<Record<string, string>>({});
  // Long ticket messages are clamped by default so one verbose report can't
  // tower over the queue (the tablet declutter); per-ticket expand reveals
  // the full text on demand.
  const [expandedMsg, setExpandedMsg] = useState<Record<string, boolean>>({});

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
    standardId?: string | null;
    user: { username?: string | null; name?: string | null } | null;
    post: { _id: string; content?: string; aiStatus?: string | null; aiStatusReason?: string | null; c2paVerifiedHuman?: boolean | null } | null;
    offender: { username?: string | null; name?: string | null } | null;
  }[];

  const submit = async (ticketId: string, status: string) => {
    try {
      const res = await respond({
        ticketId: ticketId as Id<"supportTickets">,
        reply: reply[ticketId]?.trim() || "Reviewed.",
        status: status as "open" | "in_review" | "resolved",
      });
      if (res) return;
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
          {t.standardId || t.violation ? (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">
                {t.standardId ? "Cited principle:" : "Violation:"}
              </span>
              <StandardChip standardId={t.standardId} />
              {!t.standardId && t.violation ? (
                <span className="text-muted-foreground">{t.violation}</span>
              ) : null}
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
            <>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Post:</span>{" "}
                {t.post.content?.slice(0, 140)}
              </p>
              <Link
                to={`/post/${t.post._id}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <ChevronsRight className="size-3" />
                View full post
              </Link>
              {t.standardId === "no-ai-content" && t.post ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-muted-foreground">
                    AI scan evidence:
                  </span>
                  {t.post.aiStatus === "review" ? (
                    <span className="rounded-full bg-oxide/10 px-2 py-0.5 font-medium text-oxide">
                      AI review
                      {t.post.aiStatusReason
                        ? ` — ${t.post.aiStatusReason}`
                        : ""}
                    </span>
                  ) : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                      No automated flag
                    </span>
                  )}
                  {t.post.c2paVerifiedHuman ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-copper/10 px-2 py-0.5 font-medium text-copper">
                      <ShieldCheck className="size-3" />
                      Content Credentials verified
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          <div className="mt-2 rounded-lg bg-muted/50 p-3 text-sm">
            <p
              className={`whitespace-pre-wrap ${
                expandedMsg[t._id] ? "" : "line-clamp-3"
              }`}
            >
              {t.message}
            </p>
            {t.message.length > 220 ? (
              <button
                type="button"
                onClick={() =>
                  setExpandedMsg((m) => ({ ...m, [t._id]: !m[t._id] }))
                }
                aria-expanded={!!expandedMsg[t._id]}
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                {expandedMsg[t._id] ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
                {expandedMsg[t._id] ? "Show less" : "Show more"}
              </button>
            ) : null}
          </div>
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
                <option value="dismissed">Dismissed (false report)</option>
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
  const moderatePost = useOfflineMutation(api.admin.moderatePost, "admin.moderatePost");
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
    aiStatusReason?: string | null;
    c2paVerifiedHuman?: boolean | null;
    c2paClaimGenerator?: string | null;
    creatorDisclosure?: string | null;
    reportCount?: number | null;
    author: { username?: string | null; name?: string | null } | null;
  }[];

  const [pendingRemove, setPendingRemove] = useState<{
    postId: string;
    author: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState<Set<string>>(new Set());

  const confirmRemove = async (standardId: string, note: string) => {
    if (pendingRemove === null) return;
    setBusy(true);
    try {
      const res = await moderatePost({
        postId: pendingRemove.postId as Id<"posts">,
        standardId,
        note,
      });
      setPendingRemove(null);
      if (res) return;
      toast.success("Post removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove.");
    } finally {
      setBusy(false);
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
            {(p.reportCount ?? 0) > 0 ? (
              <p
                className="mt-1 text-xs text-muted-foreground"
                title="Member-reported evidence — shown to admins for context, never triggers automatic action."
              >
                <Flag className="mr-1 inline-block size-3" />
                {p.reportCount} open report{(p.reportCount ?? 0) !== 1 ? "s" : ""}
              </p>
            ) : null}
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
              onClick={() =>
                setPendingRemove({ postId: p._id, author: p.author?.username ?? null })
              }
              aria-label="Remove post"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <button
            type="button"
            onClick={() =>
              setEvidenceIds((prev) => {
                const next = new Set(prev);
                if (next.has(p._id)) next.delete(p._id);
                else next.add(p._id);
                return next;
              })
            }
            className="mt-2 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {evidenceIds.has(p._id) ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            Evidence
          </button>
          {evidenceIds.has(p._id) ? (
            <div className="mt-2 rounded-lg border bg-muted/30 p-3 text-xs">
              <div className="grid grid-cols-1 gap-y-1.5 sm:grid-cols-2 sm:gap-x-4">
                <span className="font-medium text-muted-foreground">
                  AI detector
                </span>
                <span>
                  {p.aiStatusReason ? (
                    <span className="text-oxide">{p.aiStatusReason}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      Statistical scan — no specific signal
                    </span>
                  )}
                </span>
                <span className="font-medium text-muted-foreground">
                  C2PA provenance
                </span>
                <span>
                  {p.c2paVerifiedHuman ? (
                    <span className="text-copper">
                      Present — camera capture
                      {p.c2paClaimGenerator
                        ? ` · Signed by ${p.c2paClaimGenerator}`
                        : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Not present
                    </span>
                  )}
                </span>
                <span className="font-medium text-muted-foreground">
                  Creator disclosure
                </span>
                <span>
                  {p.creatorDisclosure === "ai-assisted" ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      AI-assisted
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Human-made
                    </span>
                  )}
                </span>
                <span className="font-medium text-muted-foreground">
                  User reports
                </span>
                <span>
                  {(p.reportCount ?? 0) > 0 ? (
                    <span className="font-medium">
                      {p.reportCount} open
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      None
                    </span>
                  )}
                </span>
              </div>
            </div>
          ) : null}
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
      <StandardViolationDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title="Remove this post"
        description={
          pendingRemove
            ? `Removing @${pendingRemove.author ?? "unknown"}'s post — cite the PureWire Standard principle it violates.`
            : ""
        }
        confirmLabel="Remove post"
        busy={busy}
        onConfirm={(standardId, note) => void confirmRemove(standardId, note)}
      />
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
  const setAccountStatus = useOfflineMutation(
    api.security.setAccountStatus,
    "security.setAccountStatus",
  );
  const setShadowban = useOfflineMutation(api.security.setShadowban, "security.setShadowban");
  const reinstateAccount = useOfflineMutation(
    api.security.reinstateAccount,
    "security.reinstateAccount",
  );
  const removeAccount = useOfflineMutation(api.admin.removeAccount, "admin.removeAccount");
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

  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const confirmRemove = async (userId: string, standardId: string, note: string) => {
    setRemoving(true);
    try {
      const res = await removeAccount({
        userId: userId as Id<"users">,
        standardId,
        note,
      });
      setPendingRemove(null);
      if (res) return;
      toast.success("Account removed — every trace of them is gone.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove.");
    } finally {
      setRemoving(false);
    }
  };

  const accounts = results as unknown as {
    _id: string;
    _creationTime: number;
    name?: string | null;
    username?: string | null;
    maskedEmail?: string | null;
    avatarUrl?: string | null;
    riskScore?: number | null;
    accountStatus?: string | null;
    riskReasons?: string[] | null;
    shadowban?: boolean | null;
    silentFlags?: number | null;
    moderationStandardId?: string | null;
    moderationNote?: string | null;
  }[];

  const [pendingAction, setPendingAction] = useState<{
    userId: string;
    kind: "restrict" | "ban" | "silence";
  } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingReinstate, setPendingReinstate] = useState<string | null>(null);
  const [reinstateBusy, setReinstateBusy] = useState(false);

  const confirmReinstate = async (
    userId: string,
    standardId: string,
    note: string,
  ) => {
    setReinstateBusy(true);
    try {
      const res = await reinstateAccount({
        userId: userId as Id<"users">,
        standardId,
        note,
      });
      setPendingReinstate(null);
      if (res) return;
      toast.success("Account reinstated — their profile is fully active again.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reinstate.");
    } finally {
      setReinstateBusy(false);
    }
  };

  // Unsilencing is a restore (no citation needed); silencing opens the
  // Standard citation dialog.
  const handleSilence = (userId: string, shadowban: boolean | null | undefined) => {
    if (shadowban) {
      void setShadowban({ userId: userId as Id<"users">, shadowban: false });
    } else {
      setPendingAction({ userId, kind: "silence" });
    }
  };

  const confirmAction = async (standardId: string, note: string) => {
    if (pendingAction === null) return;
    const { userId, kind } = pendingAction;
    setBusy(true);
    try {
      if (kind === "silence") {
        const res = await setShadowban({
          userId: userId as Id<"users">,
          shadowban: true,
          standardId,
          note,
        });
        setPendingAction(null);
        if (res) return;
        toast.success("Account silenced.");
      } else {
        const res = await setAccountStatus({
          userId: userId as Id<"users">,
          status: kind === "restrict" ? "restricted" : "banned",
          standardId,
          note,
        });
        setPendingAction(null);
        if (res) return;
        toast.success(kind === "restrict" ? "Account restricted." : "Account banned.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    } finally {
      setBusy(false);
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
                @{u.username} · {u.maskedEmail} · risk {u.riskScore ?? 0}/100
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
              {u.moderationStandardId ? (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <StandardChip standardId={u.moderationStandardId} />
                  {u.moderationNote ? (
                    <span
                      className="max-w-full truncate text-[11px] text-muted-foreground"
                      title={u.moderationNote}
                    >
                      — {u.moderationNote}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setExpandedId(expandedId === u._id ? null : u._id)}
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <History className="size-3.5" />
                {expandedId === u._id ? "Hide audit trail" : "Audit trail"}
                {expandedId === u._id ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </button>
              {expandedId === u._id ? (
                <div className="mt-2">
                  <AuditTrail userId={u._id} />
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANTS[u.accountStatus ?? "active"] as "default"}>
              {u.accountStatus ?? "active"}
            </Badge>
            {u.shadowban ? (
              <Badge variant="destructive">
                <EyeOff className="mr-1 size-3" />
                Silenced
              </Badge>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingReinstate(u._id)}
              title="Restore this account to full active status, recording the reason"
            >
              <UserCheck className="size-4" />
              Reinstate
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" aria-label="More actions">
                  <Ellipsis className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => handleSilence(u._id, u.shadowban)}>
                  <EyeOff className="size-4" />
                  {u.shadowban ? "Unsilence" : "Silence"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setPendingAction({ userId: u._id, kind: "restrict" })}
                >
                  <ShieldAlert className="size-4" />
                  Restrict
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setPendingAction({ userId: u._id, kind: "ban" })}
                >
                  <Ban className="size-4" />
                  Ban account
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setPendingRemove(u._id)}
                >
                  <Trash2 className="size-4" />
                  Remove account
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
      <StandardViolationDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        title={
          pendingAction?.kind === "silence"
            ? "Silence this account"
            : pendingAction?.kind === "restrict"
              ? "Restrict this account"
              : "Ban this account"
        }
        description={
          pendingAction
            ? "Cite the PureWire Standard principle this account violated — the citation is recorded on its moderation trail."
            : ""
        }
        confirmLabel={
          pendingAction?.kind === "silence"
            ? "Silence account"
            : pendingAction?.kind === "restrict"
              ? "Restrict account"
              : "Ban account"
        }
        busy={busy}
        onConfirm={(standardId, note) => void confirmAction(standardId, note)}
      />
      <RemoveAccountDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        user={accounts.find((u) => u._id === pendingRemove) ?? null}
        busy={removing}
        onConfirm={(userId, standardId, note) =>
          void confirmRemove(userId, standardId, note)
        }
      />
      <ReinstateAccountDialog
        open={pendingReinstate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingReinstate(null);
        }}
        user={accounts.find((u) => u._id === pendingReinstate) ?? null}
        busy={reinstateBusy}
        onConfirm={(userId, standardId, note) =>
          void confirmReinstate(userId, standardId, note)
        }
      />
    </div>
  );
}

/** Human labels for the silent-flag reasons, in the order admins should read them. */
const REASON_LABELS: Record<string, { label: string; cls: string }> = {
  duplicate: {
    label: "Copied content",
    cls: "bg-destructive/10 text-destructive",
  },
  ai: {
    label: "AI-suspicious",
    cls: "bg-oxide/10 text-oxide dark:text-oxide-light",
  },
  "rate-limit": {
    label: "Rate limits",
    cls: "bg-muted text-muted-foreground",
  },
  "farm-reciprocal": {
    label: "Instant mutual follows",
    cls: "bg-moss/10 text-moss",
  },
  "farm-churn": {
    label: "Follow churn",
    cls: "bg-moss/10 text-moss",
  },
  scam: {
    label: "Scams & phishing",
    cls: "bg-destructive/10 text-destructive",
  },
};

/** Where a silent flag came from — the surface that tripped the signal. */
const SOURCE_LABELS: Record<string, string> = {
  "duplicate-post": "Rejected duplicate post",
  "ai-review": "AI-suspicious content",
  "ai-spam": "Repeat AI-content pattern (accelerated)",
  "rateLimit:post": "Posting budget",
  "rateLimit:comment": "Commenting budget",
  "rateLimit:like": "Liking budget",
  "rateLimit:follow": "Following budget",
  "rateLimit:share": "Sharing budget",
  "rateLimit:upload": "Upload budget",
  "follow-reciprocal": "Instant mutual follow",
  "follow-churn": "Follow churn",
  "phish-block-post": "Blocked phishing post",
  "phish-review-post": "Phishing-suspicious post",
  "phish-block-comment": "Blocked phishing comment",
  "phish-review-comment": "Phishing-suspicious comment",
  "phish-block-story": "Blocked phishing story",
  "phish-review-story": "Phishing-suspicious story",
  "phish-block-profile": "Blocked phishing profile edit",
  "phish-review-profile": "Phishing-suspicious profile edit",
};

/** Human labels for admin moderation actions on the audit trail. */
const ACTION_LABELS: Record<string, string> = {
  silence: "Silenced",
  unsilence: "Unsilenced",
  restrict: "Restricted",
  ban: "Banned",
  approve: "Approved",
  reinstate: "Reinstated",
  flag: "Flagged",
};

/**
 * A single account's full audit trail: every silent-flag event (trigger,
 * points, source, when) and every admin action (who silenced/restored,
 * when, and the cited Standard principle). Fetched on demand when expanded.
 */
function AuditTrail({ userId }: { userId: string }) {
  const history = useQuery(api.security.silentFlagHistory, {
    userId: userId as Id<"users">,
  });
  if (history === undefined) {
    return <Skeleton className="h-24" />;
  }
  const empty =
    history === null ||
    (history.events.length === 0 && history.actions.length === 0);
  if (empty) {
    return (
      <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
        No moderation history on record for this account.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Current flags{" "}
          <b className="text-foreground">{history?.silentFlags}</b>
        </span>
        <span className="text-muted-foreground">
          Lifetime{" "}
          <b className="text-foreground">{history?.lifetimeSilentFlags}</b>
        </span>
      </div>
      {history?.events.map((event, i) => (
        <div
          key={`e${i}`}
          className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-1.5 text-xs"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={[
                "shrink-0 rounded-full px-2 py-0.5 font-medium",
                REASON_LABELS[event.reason]?.cls ?? "bg-muted text-muted-foreground",
              ].join(" ")}
            >
              {REASON_LABELS[event.reason]?.label ?? event.reason}
            </span>
            {event.source ? (
              <span className="truncate text-muted-foreground">
                {SOURCE_LABELS[event.source] ?? event.source}
              </span>
            ) : null}
            <span className="shrink-0 text-muted-foreground">
              {timeAgo(event.createdAt)}
            </span>
          </span>
          <span className="shrink-0 font-semibold">+{event.points}</span>
        </div>
      ))}
      {history?.actions.map((action, i) => (
        <div
          key={`a${i}`}
          className="flex items-center justify-between gap-2 rounded-lg bg-primary/5 px-3 py-1.5 text-xs"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary">
              {ACTION_LABELS[action.action] ?? action.action}
            </span>
            <span className="truncate text-muted-foreground">
              {action.actor === null
                ? "automatically"
                : `by @${action.actor}`}
              {action.note ? ` — ${action.note}` : ""}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {timeAgo(action.createdAt)}
            </span>
          </span>
          {action.standardId ? <StandardChip standardId={action.standardId} /> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Silenced tab: quietly shadowbanned accounts, separated from the Security
 * queue. Shows why each account was silenced (reason breakdown), how many
 * flags it ever collected (lifetime view), the full event history, and lets
 * an admin unsilence one or many accounts at once.
 */
function SilencedPanel() {
  const bulkUnsilence = useOfflineMutation(api.security.bulkUnsilence, "security.bulkUnsilence");
  const reinstateAccount = useOfflineMutation(
    api.security.reinstateAccount,
    "security.reinstateAccount",
  );
  const removeAccount = useOfflineMutation(api.admin.removeAccount, "admin.removeAccount");
  const { results, status, loadMore } = usePaginatedQuery(
    api.security.listSilencedAccounts,
    {},
    { initialNumItems: 15 },
  );
  const { ref, inView } = useInView();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [pendingReinstate, setPendingReinstate] = useState<string | null>(null);
  const [reinstateBusy, setReinstateBusy] = useState(false);

  const confirmReinstate = async (
    userId: string,
    standardId: string,
    note: string,
  ) => {
    setReinstateBusy(true);
    try {
      const res = await reinstateAccount({
        userId: userId as Id<"users">,
        standardId,
        note,
      });
      setPendingReinstate(null);
      if (res) return;
      toast.success("Account reinstated — their profile is fully active again.");
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reinstate.");
    } finally {
      setReinstateBusy(false);
    }
  };

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(15);
    }
  }, [inView, status, loadMore]);

  const confirmRemove = async (userId: string, standardId: string, note: string) => {
    setRemoving(true);
    try {
      const res = await removeAccount({
        userId: userId as Id<"users">,
        standardId,
        note,
      });
      setPendingRemove(null);
      if (res) return;
      toast.success("Account removed — every trace of them is gone.");
      // The account just left the silenced list; drop it from any selection.
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove.");
    } finally {
      setRemoving(false);
    }
  };

  const accounts = results as unknown as {
    _id: string;
    _creationTime: number;
    name?: string | null;
    username?: string | null;
    maskedEmail?: string | null;
    avatarUrl?: string | null;
    silentFlags?: number | null;
    lifetimeSilentFlags?: number | null;
    silentEventCount?: number | null;
    breakdown?: Record<string, number> | null;
    silencedAt?: number | null;
    moderationStandardId?: string | null;
    moderationNote?: string | null;
  }[];

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const unsilenceIds = async (ids: string[], label: string) => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await bulkUnsilence({ userIds: ids as Id<"users">[] });
      if (res) return;
      toast.success(label);
      // Drop the restored accounts from any selection so a bulk button never
      // counts an account that has already left the silenced list.
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not unsilence.");
    } finally {
      setBusy(false);
    }
  };

  const unsilenceSelected = async () => {
    await unsilenceIds(
      [...selected],
      selected.size === 1
        ? "Account unsilenced — content is public again."
        : `${selected.size} accounts unsilenced — content is public again.`,
    );
  };

  const unsilenceOne = async (userId: string) => {
    await unsilenceIds(
      [userId],
      "Account unsilenced — content is public again.",
    );
  };

  const allSelected =
    accounts.length > 0 && accounts.every((u) => selected.has(u._id));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Quietly silenced accounts — their content is invisible to everyone
          until a human reviews and lifts the silence.
        </p>
        {selected.size > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void unsilenceSelected()}
            disabled={busy}
          >
            <Unlock className="size-4" />
            Unsilence {selected.size}
            {selected.size > 1 ? " accounts" : " account"}
          </Button>
        ) : null}
      </div>
      {status === "LoadingFirstPage" &&
        Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      {accounts.length === 0 && status !== "LoadingFirstPage" && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No silenced accounts. Accounts are only silenced after repeated
          abuse signals — no error, no notice, until a human reviews them.
        </p>
      )}
      {accounts.map((u, i) => {
        const isSelected = selected.has(u._id);
        const isExpanded = expandedId === u._id;
        return (
          <motion.div
            key={u._id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.3) }}
            className={`rounded-xl border p-3 ${
              isSelected ? "border-oxide/50 bg-oxide/5" : ""
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggle(u._id)}
                  aria-label={isSelected ? "Deselect account" : "Select account"}
                  className={`flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors ${
                    isSelected
                      ? "border-oxide bg-oxide text-white"
                      : "border-border text-transparent hover:border-oxide/50"
                  }`}
                >
                  {isSelected ? <CheckCheck className="size-4" /> : <Square className="size-3.5" />}
                </button>
                <UserAvatar user={u} className="size-10" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {u.name || u.username || "Unknown"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    @{u.username} · {u.maskedEmail} · silenced{" "}
                    {timeAgo(u.silencedAt ?? u._creationTime)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">
                  <EyeOff className="mr-1 size-3" />
                  Silenced
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void unsilenceOne(u._id)}
                  disabled={busy}
                  title="Restore their content to the public feed"
                >
                  <Unlock className="size-4" />
                  Unsilence
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={busy || removing}
                      aria-label="More actions"
                    >
                      <Ellipsis className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => setPendingReinstate(u._id)}
                      disabled={busy || removing}
                    >
                      <UserCheck className="size-4" />
                      Reinstate
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setPendingRemove(u._id)}
                      disabled={busy || removing}
                    >
                      <Trash2 className="size-4" />
                      Remove account
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 pl-9">
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                Current {u.silentFlags ?? 0}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                Lifetime {u.lifetimeSilentFlags ?? 0}
              </span>
              {Object.entries(u.breakdown ?? {}).map(([reason, points]) => (
                <span
                  key={reason}
                  className={[
                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                    REASON_LABELS[reason]?.cls ?? "bg-muted text-muted-foreground",
                  ].join(" ")}
                >
                  {REASON_LABELS[reason]?.label ?? reason} +{points}
                </span>
              ))}
              {u.moderationStandardId ? (
                <StandardChip standardId={u.moderationStandardId} />
              ) : null}
              <button
                type="button"
                onClick={() =>
                  setExpandedId(isExpanded ? null : u._id)
                }
                className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <History className="size-3.5" />
                {isExpanded ? "Hide history" : "Flag history"}
                {isExpanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </button>
            </div>
            {isExpanded ? (
              <div className="mt-3 pl-9">
                <AuditTrail userId={u._id} />
              </div>
            ) : null}
          </motion.div>
        );
      })}
      <div className="flex items-center justify-between py-2">
        <div ref={ref} className="text-sm text-muted-foreground">
          {status === "LoadingMore" ? "Loading more…" : ""}
        </div>
        {accounts.length > 0 ? (
          <button
            type="button"
            onClick={() =>
              setSelected(
                allSelected
                  ? new Set()
                  : new Set(accounts.map((u) => u._id)),
              )
            }
            className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            {allSelected ? "Clear selection" : "Select all"}
          </button>
        ) : null}
      </div>
      <RemoveAccountDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        user={accounts.find((u) => u._id === pendingRemove) ?? null}
        busy={removing}
        onConfirm={(userId, standardId, note) =>
          void confirmRemove(userId, standardId, note)
        }
      />
      <ReinstateAccountDialog
        open={pendingReinstate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingReinstate(null);
        }}
        user={accounts.find((u) => u._id === pendingReinstate) ?? null}
        busy={reinstateBusy}
        onConfirm={(userId, standardId, note) =>
          void confirmReinstate(userId, standardId, note)
        }
      />
    </div>
  );
}

function AiReviewPanel() {
  const moderatePost = useOfflineMutation(api.admin.moderatePost, "admin.moderatePost");
  const resolveAiReview = useOfflineMutation(api.admin.resolveAiReview, "admin.resolveAiReview");
  const resolveAiReviewBatch = useOfflineMutation(
    api.admin.resolveAiReviewBatch,
    "admin.resolveAiReviewBatch",
  );
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
    aiStatusReason?: string | null;
    // Structured evidence from the multi-signal media assessment (see
    // AiMediaEvidence in aiContent.ts). Stored when media was attached.
    aiEvidence?: {
      byteScan?: { status: string; reason?: string };
      resemble?: { isAi: boolean; confidence: number; metrics?: { label: string; score?: number; aggregatedScore?: number; consistency?: number; certainty?: number }; sourceLabel?: string | null } | null;
      c2pa?: { humanCapture: boolean; claimGenerator?: string } | null;
      ocrRacism?: { status: string; reason: string } | null;
    } | null;
    c2paVerifiedHuman?: boolean | null;
    c2paClaimGenerator?: string | null;
    creatorDisclosure?: string | null;
    reportCount?: number | null;
    author: { username?: string | null; name?: string | null } | null;
  }[];

  const [approvingPage, setApprovingPage] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState<Set<string>>(new Set());

  // Genuine human creators with formal writing styles trip the statistical
  // scan; approving the whole loaded page keeps the queue fast for them.
  const approvePage = async () => {
    if (posts.length === 0 || approvingPage) return;
    setApprovingPage(true);
    try {
      const res = await resolveAiReviewBatch({
        postIds: posts.map((p) => p._id as Id<"posts">),
      });
      if (res) return;
      toast.success(
        posts.length === 1
          ? "Marked as original — kept live."
          : `${posts.length} posts marked as original — kept live.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not approve.");
    } finally {
      setApprovingPage(false);
    }
  };

  const approve = async (postId: string) => {
    try {
      const res = await resolveAiReview({ postId: postId as Id<"posts"> });
      if (res) return;
      toast.success("Marked as original — kept live.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    }
  };

  const [pendingRemove, setPendingRemove] = useState<{
    postId: string;
    author: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const confirmRemove = async (standardId: string, note: string) => {
    if (pendingRemove === null) return;
    setBusy(true);
    try {
      const res = await moderatePost({
        postId: pendingRemove.postId as Id<"posts">,
        standardId,
        note,
      });
      setPendingRemove(null);
      if (res) return;
      toast.success("Post removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove.");
    } finally {
      setBusy(false);
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
      {posts.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            <b className="text-foreground">{posts.length}</b> posts waiting —
            genuine creators with formal writing styles get flagged here.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={approvingPage}
            onClick={() => void approvePage()}
            title="Mark every post on this page as human-made and keep it live"
          >
            {approvingPage ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <CheckCheck className="mr-1 size-4" />
            )}
            Looks human — approve page
          </Button>
        </div>
      ) : null}
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
            {(p.reportCount ?? 0) > 0 ? (
              <p
                className="mt-1 text-xs text-muted-foreground"
                title="Member-reported evidence — shown to admins for context, never triggers automatic action."
              >
                <Flag className="mr-1 inline-block size-3" />
                {p.reportCount} open report{(p.reportCount ?? 0) !== 1 ? "s" : ""}
              </p>
            ) : null}
            {p.aiStatusReason ? (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-oxide dark:text-oxide-light">
                <ScanSearch className="mt-0.5 size-3 shrink-0" />
                <span className="line-clamp-2">{p.aiStatusReason}</span>
              </p>
            ) : null}
            {p.c2paVerifiedHuman ? (
              <span
                className="mt-1 inline-flex items-center gap-1 rounded-full border border-copper/40 bg-copper/15 px-2 py-0.5 text-[11px] font-medium text-copper"
                title="The attached media's C2PA manifest declares a camera capture — positive provenance."
              >
                <ShieldCheck className="size-3" />
                C2PA camera capture
              </span>
            ) : null}
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
              onClick={() =>
                setPendingRemove({ postId: p._id, author: p.author?.username ?? null })
              }
              aria-label="Remove post"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <button
            type="button"
            onClick={() =>
              setEvidenceIds((prev) => {
                const next = new Set(prev);
                if (next.has(p._id)) next.delete(p._id);
                else next.add(p._id);
                return next;
              })
            }
            className="mt-2 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {evidenceIds.has(p._id) ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            Evidence
          </button>
          {evidenceIds.has(p._id) ? (
            <AiEvidencePanel post={p} />
          ) : null}
        </motion.div>
      ))}
      <div ref={ref} className="py-2 text-center text-sm text-muted-foreground">
        {status === "LoadingMore" ? "Loading more…" : ""}
      </div>
      <StandardViolationDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title="Remove this post"
        description={
          pendingRemove
            ? `Removing @${pendingRemove.author ?? "unknown"}'s post — cite the PureWire Standard principle it violates.`
            : ""
        }
        confirmLabel="Remove post"
        busy={busy}
        onConfirm={(standardId, note) => void confirmRemove(standardId, note)}
      />
    </div>
  );
}


function StoryReviewPanel() {
  const moderateStory = useOfflineMutation(api.admin.moderateStory, "admin.moderateStory");
  const resolveAiReviewStory = useOfflineMutation(api.admin.resolveAiReviewStory, "admin.resolveAiReviewStory");
  const resolveAiReviewStoryBatch = useOfflineMutation(
    api.admin.resolveAiReviewStoryBatch,
    "admin.resolveAiReviewStoryBatch",
  );
  const { results, status, loadMore } = usePaginatedQuery(
    api.admin.listAiReviewStories,
    {},
    { initialNumItems: 15 },
  );
  const { ref, inView } = useInView();
  useEffect(() => { if (inView && status === "CanLoadMore") { void loadMore(15); } }, [inView, status, loadMore]);

  const stories = results as unknown as {
    _id: string;
    _creationTime: number;
    caption?: string | null;
    aiStatusReason?: string | null;
    aiEvidence?: {
      byteScan?: { status: string; reason?: string };
      resemble?: { isAi: boolean; confidence: number; metrics?: { label: string; score?: number; aggregatedScore?: number; consistency?: number; certainty?: number }; sourceLabel?: string | null } | null;
      c2pa?: { humanCapture: boolean; claimGenerator?: string } | null;
      ocrRacism?: { status: string; reason: string } | null;
    } | null;
    author: { username?: string | null; name?: string | null } | null;
  }[];

  const [evidenceIds, setEvidenceIds] = useState<Set<string>>(new Set());
  const [approvingPage, setApprovingPage] = useState(false);

  const approvePage = async () => {
    if (stories.length === 0 || approvingPage) return;
    setApprovingPage(true);
    try {
      await resolveAiReviewStoryBatch({ storyIds: stories.map(s => s._id as Id<"stories">) });
      toast.success(stories.length === 1 ? "Cleared — story stays live." : stories.length + " stories cleared.");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not approve."); }
    finally { setApprovingPage(false); }
  };

  const approve = async (storyId: string) => {
    try {
      await resolveAiReviewStory({ storyId: storyId as Id<"stories"> });
      toast.success("Cleared — story stays live.");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not update."); }
  };

  const [pendingRemove, setPendingRemove] = useState<{ storyId: string; author: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRemove = async (standardId: string, note: string) => {
    if (!pendingRemove) return;
    setBusy(true);
    try {
      await moderateStory({ storyId: pendingRemove.storyId as Id<"stories">, standardId, note });
      setPendingRemove(null);
      toast.success("Story removed.");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not remove."); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2">
      {status === "LoadingFirstPage" && Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
      {stories.length === 0 && status !== "LoadingFirstPage" && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No stories waiting on review. Every story is scanned for AI-generated content before it goes live.
        </p>
      )}
      {stories.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground"><b className="text-foreground">{stories.length}</b> stories waiting — a human moderator must judge each one.</p>
          <Button size="sm" variant="outline" disabled={approvingPage} onClick={() => void approvePage()}>
            {approvingPage ? <Loader2 className="mr-1 size-4 animate-spin" /> : <CheckCheck className="mr-1 size-4" />} Clear page
          </Button>
        </div>
      )}
      {stories.map((s, i) => (
        <motion.div key={s._id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.3) }} className="flex items-center justify-between gap-3 rounded-xl border p-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground"><b className="text-foreground">@{s.author?.username}</b> · {timeAgo(s._creationTime)}</p>
            <p className="mt-1 line-clamp-2 text-sm">{s.caption ?? "(no caption)"}</p>
            {s.aiStatusReason && <p className="mt-1 flex items-start gap-1 text-[11px] text-oxide dark:text-oxide-light"><ScanSearch className="mt-0.5 size-3 shrink-0" /><span className="line-clamp-2">{s.aiStatusReason}</span></p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" className="text-xs" onClick={() => void approve(s._id)}><CheckCheck className="mr-1 size-3" />Clear</Button>
            <Button variant="ghost" size="sm" className="text-xs text-destructive hover:text-destructive" onClick={() => setPendingRemove({ storyId: s._id, author: s.author?.username ?? null })}><Trash2 className="size-3" /></Button>
          </div>
          <button type="button" onClick={() => setEvidenceIds((prev) => { const next = new Set(prev); if (next.has(s._id)) next.delete(s._id); else next.add(s._id); return next; })} className="mt-2 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
            {evidenceIds.has(s._id) ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} Evidence
          </button>
          {evidenceIds.has(s._id) ? <AiEvidencePanel post={s as any} /> : null}
        </motion.div>
      ))}
      <div ref={ref} className="h-8" />
      {status === "LoadingMore" && <Skeleton className="h-12" />}
      <StandardViolationDialog title="Remove this story" open={pendingRemove !== null} onOpenChange={(open) => { if (!open) setPendingRemove(null); }} description={pendingRemove ? "Removing @" + (pendingRemove.author ?? "unknown") + "'s story — cite the PureWire Standard principle it violates." : ""} confirmLabel="Remove story" busy={busy} onConfirm={(standardId, note) => void confirmRemove(standardId, note)} />
    </div>
  );
}

function RacismReviewPanel() {
  const moderatePost = useOfflineMutation(api.admin.moderatePost, "admin.moderatePost");
  const resolveRacismReview = useOfflineMutation(api.admin.resolveRacismReview, "admin.resolveRacismReview");
  const resolveRacismReviewBatch = useOfflineMutation(api.admin.resolveRacismReviewBatch, "admin.resolveRacismReviewBatch");
  const { results, status, loadMore } = usePaginatedQuery(api.admin.listRacismReview, {}, { initialNumItems: 15 });
  const { ref, inView } = useInView();
  useEffect(() => { if (inView && status === "CanLoadMore") { void loadMore(15); } }, [inView, status, loadMore]);

  const posts = results as unknown as {
    _id: string; _creationTime: number; content: string;
    aiStatusReason?: string | null;
    aiEvidence?: {
      byteScan?: { status: string; reason?: string };
      resemble?: { isAi: boolean; confidence: number; metrics?: { label: string; score?: number; aggregatedScore?: number; consistency?: number; certainty?: number }; sourceLabel?: string | null } | null;
      c2pa?: { humanCapture: boolean; claimGenerator?: string } | null;
      ocrRacism?: { status: string; reason: string } | null;
    } | null;
    c2paVerifiedHuman?: boolean | null;
    c2paClaimGenerator?: string | null;
    creatorDisclosure?: string | null;
    racismReviewCategory?: string | null;
    racismEvasionScore?: number | null; reportCount?: number | null;
    author: { username?: string | null; name?: string | null } | null;
  }[];

  const [evidenceIds, setEvidenceIds] = useState<Set<string>>(new Set());

  const [approvingPage, setApprovingPage] = useState(false);
  const approvePage = async () => {
    if (posts.length === 0 || approvingPage) return;
    setApprovingPage(true);
    try {
      await resolveRacismReviewBatch({ postIds: posts.map(p => p._id as Id<"posts">) });
      toast.success(posts.length === 1 ? "Cleared — post stays live." : posts.length + " posts cleared.");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not approve."); }
    finally { setApprovingPage(false); }
  };

  const approve = async (postId: string) => {
    try {
      await resolveRacismReview({ postId: postId as Id<"posts"> });
      toast.success("Cleared — post stays live.");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not update."); }
  };

  const [pendingRemove, setPendingRemove] = useState<{ postId: string; author: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRemove = async (standardId: string, note: string) => {
    if (!pendingRemove) return;
    setBusy(true);
    try {
      await moderatePost({ postId: pendingRemove.postId as Id<"posts">, standardId, note });
      setPendingRemove(null);
      toast.success("Post removed.");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not remove."); }
    finally { setBusy(false); }
  };

  const catLabel = (c: string | null | undefined) => ({ racial_slur:"Racial slur", ethnic_slur:"Ethnic slur", racial_dehumanization:"Racial dehumanization", racial_supremacy:"Racial supremacy", racial_inferiority:"Racial inferiority claim", racial_segregation:"Segregation advocacy", racial_harassment:"Racial harassment", racial_violence:"Call for racial violence", holocaust_denial:"Holocaust/genocide denial", racial_stereotype_attack:"Stereotype used to attack", coded_hate:"Coded racial language" } as Record<string,string>)[c ?? ""] ?? c;

  return (
    <div className="flex flex-col gap-2">
      {status === "LoadingFirstPage" && Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
      {posts.length === 0 && status !== "LoadingFirstPage" && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No posts flagged for racism review. Every post is scanned for racial and ethnic hate before it goes live.
        </p>
      )}
      {posts.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground"><b className="text-foreground">{posts.length}</b> posts flagged — a human moderator must judge each one.</p>
          <Button size="sm" variant="outline" disabled={approvingPage} onClick={() => void approvePage()}>
            {approvingPage ? <Loader2 className="mr-1 size-4 animate-spin" /> : <CheckCheck className="mr-1 size-4" />} Clear page
          </Button>
        </div>
      )}
      {posts.map((p, i) => (
        <motion.div key={p._id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.3) }} className="flex items-center justify-between gap-3 rounded-xl border p-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground"><b className="text-foreground">@{p.author?.username}</b> · {timeAgo(p._creationTime)}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {catLabel(p.racismReviewCategory) && <Badge variant="outline" className="shrink-0 text-[11px]"><Flag className="mr-1 size-3" />{catLabel(p.racismReviewCategory)}</Badge>}
              {p.racismEvasionScore != null && p.racismEvasionScore > 0 && <Badge variant="outline" className="shrink-0 text-[11px] text-oxide dark:text-oxide-light">Evasion {p.racismEvasionScore}/10</Badge>}
            </div>
            <p className="mt-1 line-clamp-2 text-sm">{p.content}</p>
            {p.aiStatusReason && <p className="mt-1 flex items-start gap-1 text-[11px] text-oxide dark:text-oxide-light"><ScanSearch className="mt-0.5 size-3 shrink-0" /><span className="line-clamp-2">{p.aiStatusReason}</span></p>}
            {(p.reportCount ?? 0) > 0 && <p className="mt-1 text-xs text-muted-foreground"><Flag className="mr-1 inline-block size-3" />{p.reportCount} open report{p.reportCount !== 1 ? "s" : ""}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" className="text-xs" onClick={() => void approve(p._id)}><CheckCheck className="mr-1 size-3" />Clear</Button>
            <Button variant="ghost" size="sm" className="text-xs text-destructive hover:text-destructive" onClick={() => setPendingRemove({ postId: p._id, author: p.author?.username ?? null })}><Trash2 className="size-3" /></Button>
          </div>
          <button
            type="button"
            onClick={() =>
              setEvidenceIds((prev) => {
                const next = new Set(prev);
                if (next.has(p._id)) next.delete(p._id);
                else next.add(p._id);
                return next;
              })
            }
            className="mt-2 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {evidenceIds.has(p._id) ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            Evidence
          </button>
          {evidenceIds.has(p._id) ? (
            <AiEvidencePanel post={p} />
          ) : null}
        </motion.div>
      ))}
      <div ref={ref} className="h-8" />
      {status === "LoadingMore" && <Skeleton className="h-12" />}
      <StandardViolationDialog title="Remove this post" open={pendingRemove !== null} onOpenChange={(open) => { if (!open) setPendingRemove(null); }} description={pendingRemove ? 'Removing @' + (pendingRemove.author ?? "unknown") + "'s post — cite the PureWire Standard principle it violates." : ""} confirmLabel="Remove post" busy={busy} onConfirm={(standardId, note) => void confirmRemove(standardId, note)} />
    </div>
  );
}
