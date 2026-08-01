import { useMutation } from "convex/react";
import {
  AlertTriangle,
  Loader2,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { MediaUpload, type MediaItem } from "@/components/MediaUpload";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { isValidUsername, PLATFORM_OPTIONS } from "@/lib/format";
import { cn } from "@/lib/utils";

interface LinkRow {
  platform: string;
  url: string;
}

type Profile = NonNullable<ReturnType<typeof useAuth>["user"]>;

export function Settings() {
  const { user } = useAuth();

  if (!user) return null;
  // Remount the form when the user changes so its state is initialized from
  // the profile directly — no sync-from-effect needed.
  return <SettingsForm key={user._id} user={user} />;
}

function SettingsForm({ user }: { user: Profile }) {
  const updateProfile = useMutation(api.users.updateProfile);
  const deleteAccount = useMutation(api.account.deleteAccount);
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState(user.name ?? "");
  const [username, setUsername] = useState(user.username ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [links, setLinks] = useState<LinkRow[]>(user.links ?? []);
  const [avatar, setAvatar] = useState<MediaItem[]>([]);
  const [banner, setBanner] = useState<MediaItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const eraseAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteAccount();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete.");
      setDeleting(false);
      return;
    }
    // The account is gone — signing out and returning home must always
    // happen, even if the session was already invalidated server-side.
    try {
      await signOut();
    } finally {
      navigate("/");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await updateProfile({
        name: name.trim() || undefined,
        username: username.trim() || undefined,
        bio: bio.trim() || undefined,
        links: links.filter((l) => l.platform && l.url.trim()),
        avatarStorageId: avatar[0]?.storageId,
        bannerStorageId: banner[0]?.storageId,
      });
      toast.success("Profile updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const updateLink = (i: number, patch: Partial<LinkRow>) => {
    setLinks((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 pb-24 sm:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Make your space yours — your name, your look, your links, your call.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Photo & banner</CardTitle>
          <CardDescription>
            Upload real images — no URL strings, no middlemen.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label>Profile picture</Label>
            <div className="flex items-center gap-4">
              <UserAvatar
                user={
                  avatar[0]
                    ? { ...user, avatarUrl: avatar[0].url }
                    : user
                }
                className="size-16"
              />
              <MediaUpload
                value={avatar}
                onChange={(items) => setAvatar(items.slice(0, 1))}
                max={1}
                compact
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Profile banner</Label>
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-32 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                {banner[0] ? (
                  <img
                    src={banner[0].url}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : user.bannerUrl ? (
                  <img
                    src={user.bannerUrl}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No banner
                  </span>
                )}
              </div>
              <MediaUpload
                value={banner}
                onChange={(items) => setBanner(items.slice(0, 1))}
                max={1}
                compact
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile info</CardTitle>
          <CardDescription>
            Your name, username and bio are public.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) =>
                setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
              }
              maxLength={24}
              className={isValidUsername(username) ? "" : "border-destructive"}
            />
            {!isValidUsername(username) && (
              <p className="text-xs text-destructive">
                3-24 chars: lowercase letters, numbers, underscores.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Say it anyway — introduce yourself…"
              rows={3}
              maxLength={200}
            />
            <p className="text-right text-xs text-muted-foreground">
              {bio.length}/200
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Links</CardTitle>
          <CardDescription>
            Link your other social accounts — Facebook, Instagram, Snapchat,
            YouTube, Discord and more.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {links.map((link, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={link.platform}
                onChange={(e) => updateLink(i, { platform: e.target.value })}
                className="h-10 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {PLATFORM_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <Input
                value={link.url}
                onChange={(e) => updateLink(i, { url: e.target.value })}
                placeholder="your.handle"
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() =>
                  setLinks((ls) => ls.filter((_, idx) => idx !== i))
                }
                aria-label="Remove link"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="self-start gap-1.5"
            onClick={() => setLinks((ls) => [...ls, { platform: "Website", url: "" }])}
          >
            <Plus className="size-4" />
            Add link
          </Button>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex items-center justify-end gap-3">
        <p className="text-xs text-muted-foreground">
          {user.emailVerificationTime ? "Email verified" : "Email unverified"} ·{" "}
          {user.maskedEmail}
        </p>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save changes
        </Button>
      </div>

      <Separator />

      {/* Data & privacy — full transparency, right to erasure */}
      <Card className="border-oxide/25">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-oxide dark:text-oxide-light" />
            Your data & privacy
          </CardTitle>
          <CardDescription>
            PureWire saves zero tracking data and never stores your plain-text
            email — only a one-way hash. Everything you create is kept only as
            long as your account exists. You can delete your account and all of
            it permanently, right here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 rounded-xl border bg-muted/30 p-4 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Email
              </p>
              <p className="mt-0.5">{user.maskedEmail}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Stored email form
              </p>
              <p className="mt-0.5">One-way SHA-256 hash only</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Tracking
              </p>
              <p className="mt-0.5">None — no analytics, no cookies</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            <Link to="/privacy" className="text-primary hover:underline">
              Read the full data & transparency statement
            </Link>{" "}
            — a plain-language inventory of everything stored, why, for how
            long, and how it is protected.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div>
                <p className="font-semibold">Delete account and all data</p>
                <p className="text-sm text-muted-foreground">
                  Permanently removes your profile, posts, comments, likes,
                  shares, stories, follows, notifications, tickets, and every
                  file you uploaded. This cannot be undone.
                </p>
              </div>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive" size="sm" className="gap-1.5">
                  <Trash2 className="size-4" />
                  Delete my account
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete your account permanently?</DialogTitle>
                  <DialogDescription>
                    This erases every trace of your account from PureWire —
                    profile, posts, comments, likes, shares, stories, follows,
                    notifications, support tickets, and all uploaded files.
                    There is no undo and no copy kept anywhere.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2 sm:justify-between">
                  <DialogClose asChild>
                    <Button variant="outline" disabled={deleting}>
                      Keep my account
                    </Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    className={cn("gap-1.5")}
                    disabled={deleting}
                    onClick={() => void eraseAccount()}
                  >
                    {deleting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    {deleting ? "Erasing…" : "Yes, delete everything"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
