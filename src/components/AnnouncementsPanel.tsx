import { useMutation, useQuery } from "convex/react";
import {
  Bell,
  Calendar,
  Loader2,
  Megaphone,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { value: "platform", label: "Platform" },
  { value: "safety", label: "Safety" },
  { value: "feature", label: "Feature" },
  { value: "event", label: "Event" },
  { value: "community", label: "Community" },
] as const;

const CATEGORY_COLORS: Record<string, string> = {
  platform: "border-l-blue-500",
  safety: "border-l-red-500",
  feature: "border-l-emerald-500",
  event: "border-l-amber-500",
  community: "border-l-violet-500",
};

/** Format a unix-ms timestamp as a local datetime string for the input. */
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format a unix-ms timestamp for display (e.g. "Aug 5, 2026 at 10:30 AM"). */
function formatScheduled(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AnnouncementsPanel() {
  const announcements = useQuery(api.announcements.listAll);
  const create = useMutation(api.announcements.create);
  const update = useMutation(api.announcements.update);
  const remove = useMutation(api.announcements.remove);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<string>("platform");
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setTitle("");
    setBody("");
    setCategory("platform");
    setScheduleMode(false);
    setScheduledAt("");
  };

  const handleSave = async () => {
    if (!title.trim() || !body.trim()) return;
    setSaving(true);
    try {
      const scheduledMs = scheduleMode && scheduledAt
        ? new Date(scheduledAt).getTime()
        : undefined;

      if (editingId) {
        await update({
          announcementId: editingId as any,
          title: title.trim(),
          body: body.trim(),
          category: category as any,
          ...(scheduledMs !== undefined
            ? { scheduledAt: scheduledMs, status: "scheduled" as const }
            : scheduleMode
              ? {}
              : { status: "active" as const }),
        });
      } else {
        await create({
          title: title.trim(),
          body: body.trim(),
          category: category as any,
          ...(scheduledMs !== undefined ? { scheduledAt: scheduledMs } : {}),
        });
      }
      resetForm();
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (a: any) => {
    setEditingId(a._id);
    setTitle(a.title);
    setBody(a.body);
    setCategory(a.category);
    if (a.scheduledAt) {
      setScheduleMode(true);
      setScheduledAt(toDatetimeLocal(a.scheduledAt));
    } else {
      setScheduleMode(false);
      setScheduledAt("");
    }
    setShowForm(true);
  };

  const statusBadge = (status: string, scheduledAt?: number) => {
    if (status === "active") {
      return (
        <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
          Active
        </span>
      );
    }
    if (status === "scheduled") {
      return (
        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
          Scheduled · {formatScheduled(scheduledAt)}
        </span>
      );
    }
    return (
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        Inactive
      </span>
    );
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Announcements</h2>
          <p className="text-sm text-muted-foreground">
            Posted on the home page as a subtle, dismissible banner. Each user
            dismisses it once — it never returns for them. Schedule ahead to
            queue notices for a future date.
          </p>
        </div>
        {!showForm && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="size-4" />
            New
          </Button>
        )}
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {editingId ? "Edit announcement" : "New announcement"}
              </CardTitle>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ann-title">Title</Label>
              <Input
                id="ann-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Scheduled maintenance tonight"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-body">Message</Label>
              <Textarea
                id="ann-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                placeholder="Tell members what they need to know…"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Schedule toggle + date picker */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setScheduleMode(!scheduleMode);
                    if (scheduleMode) setScheduledAt("");
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                    scheduleMode
                      ? "bg-amber-500/10 text-amber-600"
                      : "bg-muted text-muted-foreground hover:bg-muted/80",
                  )}
                >
                  <Calendar className="size-3" />
                  {scheduleMode ? "Scheduled" : "Post now"}
                </button>
              </div>
              {scheduleMode && (
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="w-fit"
                />
              )}
              {scheduleMode && scheduledAt && (
                <p className="text-[11px] text-muted-foreground">
                  Goes live on{" "}
                  {formatScheduled(new Date(scheduledAt).getTime())}
                </p>
              )}
            </div>

            {/* Live preview */}
            {(title || body) && (
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Preview — home page
                </Label>
                <div
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border border-l-[3px] bg-muted/40 px-3 py-2.5 text-sm",
                    CATEGORY_COLORS[category] ?? "border-l-muted-foreground",
                  )}
                >
                  <Bell className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {CATEGORIES.find((c) => c.value === category)?.label ?? category}
                      </span>
                      {title ? (
                        <span className="truncate font-semibold">{title || "(no title yet)"}</span>
                      ) : null}
                    </div>
                    {body ? (
                      <p className="mt-0.5 leading-snug text-muted-foreground line-clamp-2">
                        {body}
                      </p>
                    ) : null}
                  </div>
                  <span className="-mr-1 -mt-1 shrink-0 rounded-full p-1 text-muted-foreground/40">
                    <X className="size-3.5" />
                  </span>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : editingId ? (
                  <Pencil className="size-4" />
                ) : (
                  <Megaphone className="size-4" />
                )}
                {scheduleMode && scheduledAt ? "Schedule" : editingId ? "Save changes" : "Post announcement"}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* List of announcements */}
      {announcements === undefined ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : announcements.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-1 py-8 text-center">
            <Bell className="size-8 text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">
              No announcements yet
            </p>
            <p className="text-xs text-muted-foreground">
              Create one to notify members on the home page, or schedule one
              for later.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {announcements.map((a) => (
            <Card
              key={a._id}
              className={cn(
                "border-l-[3px]",
                a.status === "active"
                  ? CATEGORY_COLORS[a.category] ?? "border-l-muted-foreground"
                  : "border-l-muted-foreground/30 opacity-60",
              )}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {a.category}
                      </span>
                      {statusBadge(a.status, a.scheduledAt)}
                    </div>
                    <CardTitle className="text-sm">{a.title}</CardTitle>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(a)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="Edit"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (a.status === "active" || a.status === "scheduled") {
                          void update({
                            announcementId: a._id,
                            status: "inactive",
                          });
                        } else {
                          void remove({ announcementId: a._id });
                        }
                      }}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      title={a.status === "inactive" ? "Delete" : "Deactivate"}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{a.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
