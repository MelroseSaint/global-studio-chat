import { useMutation, useQuery } from "convex/react";
import JSZip from "jszip";
import {
  AlertTriangle,
  Download,
  Laptop,
  Loader2,
  LogOut,
  MapPin,
  MessageSquare,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  VolumeX,
  X,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { LocationPicker, type PickedLocation } from "@/components/LocationPicker";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { isValidUsername, PLATFORM_OPTIONS } from "@/lib/format";
import {
  clearAutoplayPreference,
  useVideoAutoplay,
} from "@/lib/video-autoplay";
import { cn } from "@/lib/utils";

interface LinkRow {
  platform: string;
  url: string;
}

/** Pick a file extension for an exported media item — from the URL when it
 * carries one, otherwise a sensible default per kind. */
function extFor(url: string | null | undefined, kind: string): string {
  if (url) {
    const m = url.split(/[?#]/)[0].match(/\.([a-zA-Z0-9]{2,5})$/);
    if (m) return m[1].toLowerCase();
  }
  if (kind === "image") return "jpg";
  if (kind === "video") return "mp4";
  return "m4a";
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
  // Video autoplay: a user-facing override for the device policy (off on
  // iOS/cellular by default — see lib/video-autoplay). Applies to every
  // inline video: the main feed's cards and the shared-post previews.
  const { autoplay, preference, setPreference } = useVideoAutoplay();
  const updateProfile = useMutation(api.users.updateProfile);
  const deleteAccount = useMutation(api.account.deleteAccount);
  const currentSession = useQuery(api.account.getCurrentSession);
  const signOutOtherSessions = useMutation(api.account.signOutOtherSessions);
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState(user.name ?? "");
  const [username, setUsername] = useState(user.username ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [links, setLinks] = useState<LinkRow[]>(user.links ?? []);
  const [avatar, setAvatar] = useState<MediaItem[]>([]);
  const [banner, setBanner] = useState<MediaItem[]>([]);
  const [location, setLocation] = useState<PickedLocation | null>(
    user.location?.label ? { label: user.location.label } : null,
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [endingSessions, setEndingSessions] = useState(false);

  // Personal keyword muting.
  const saveMutesMutation = useMutation(api.mutes.setMutedKeywords);
  const [mutedKeywords, setMutedKeywords] = useState<string[]>(
    user.mutedKeywords ?? [],
  );
  const [muteInput, setMuteInput] = useState("");
  const [savingMutes, setSavingMutes] = useState(false);
  const addMute = () => {
    const term = muteInput.trim().toLowerCase();
    if (!term || mutedKeywords.includes(term)) return;
    setMutedKeywords((prev) => [...prev, term]);
    setMuteInput("");
  };
  const saveMutes = async () => {
    setSavingMutes(true);
    try {
      await saveMutesMutation({ keywords: mutedKeywords });
      toast.success("Mute list saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSavingMutes(false);
    }
  };

  // Granular DM permission.
  const setDmPermissionMutation = useMutation(api.users.setDmPermission);
  const [dmPermission, setDmPermission] = useState<string>(
    (user as { dmPermission?: string }).dmPermission ?? "everyone",
  );
  const saveDmPermission = async (value: string) => {
    try {
      await setDmPermissionMutation({
        dmPermission: value as "everyone" | "following" | "nobody",
      });
      toast.success("Message settings updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update.");
    }
  };

  // User data export — a ZIP: readable profile/posts text, the actual
  // uploaded media files, and the full JSON archive.
  const exportData = useQuery(api.exportData.exportMyData);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const downloadExport = async () => {
    if (!exportData) {
      toast.error("Your data isn't ready yet — try again in a moment.");
      return;
    }
    setExporting(true);
    setExportProgress("Assembling archive…");
    try {
      const zip = new JSZip();
      const stamp = new Date().toISOString().slice(0, 10);
      const profile = exportData.profile as {
        name?: string | null;
        username?: string | null;
        bio?: string | null;
      };

      zip.file(
        "README.txt",
        [
          "PureWire — your data export",
          `Exported: ${exportData.exportedAt}`,
          "",
          "This archive contains everything you created on PureWire:",
          "  profile.txt — your account details and stats",
          "  posts.txt   — every post you made, in readable form",
          "  media/      — the photos, videos, and audio files you uploaded",
          "  export.json — the complete machine-readable archive",
          "",
          "Media files are named by post (media/post-01-1.jpg is the first",
          "file of your first post), and posts.txt lists them next to each",
          "post so it is easy to match them up.",
          "",
          "This data is yours — take it anywhere. Deleting your account",
          "erases it from PureWire, so download first if you want a copy.",
        ].join("\n"),
      );

      zip.file(
        "profile.txt",
        [
          "PureWire profile",
          "----------------",
          `Name: ${profile.name ?? ""}`,
          `Username: @${profile.username ?? ""}`,
          `Bio: ${profile.bio ?? ""}`,
          `Preferences: ${JSON.stringify(exportData.preferences)}`,
          "",
          "Stats",
          "-----",
          `Posts: ${exportData.stats.posts}`,
          `Media files: ${exportData.stats.media}`,
          `Comments: ${exportData.stats.comments}`,
          `Stories: ${exportData.stats.stories}`,
          `Following: ${exportData.stats.following}`,
          `Followers: ${exportData.stats.followers}`,
          `Blocks: ${exportData.stats.blocks}`,
          `Notifications: ${exportData.stats.notifications}`,
        ].join("\n"),
      );

      // posts.txt — every post, clearly formatted, with its media listed.
      const lines: string[] = [];
      exportData.posts.forEach((post, i) => {
        const n = i + 1;
        lines.push("", "=".repeat(60), `POST ${n}`, "=".repeat(60));
        lines.push(`Posted: ${new Date(post.createdAt).toISOString()}`);
        lines.push(`Post id: ${post.id}`);
        lines.push(
          `Likes: ${post.likeCount}  |  Comments: ${post.commentCount}`,
        );
        const loc = post.location as { label?: string } | null | undefined;
        if (loc?.label) lines.push(`Location: ${loc.label}`);
        if (post.media.length > 0) {
          lines.push(`Media (${post.media.length}):`);
          post.media.forEach((m, mi) => {
            const name = `post-${String(n).padStart(2, "0")}-${mi + 1}.${extFor(m.url, m.kind)}`;
            lines.push(`  media/${name}  (${m.kind})`);
          });
        }
        lines.push("", post.content);
      });
      zip.file("posts.txt", lines.join("\n"));

      // The actual media files, named by post so they match posts.txt.
      const mediaFolder = zip.folder("media");
      if (mediaFolder === null) {
        throw new Error("Could not create the media folder.");
      }
      const missing: string[] = [];
      let downloaded = 0;
      for (let i = 0; i < exportData.posts.length; i++) {
        const post = exportData.posts[i];
        const n = i + 1;
        for (let mi = 0; mi < post.media.length; mi++) {
          const m = post.media[mi];
          const name = `post-${String(n).padStart(2, "0")}-${mi + 1}.${extFor(m.url, m.kind)}`;
          if (!m.url) {
            missing.push(name);
            continue;
          }
          downloaded++;
          setExportProgress(`Downloading media ${downloaded}…`);
          try {
            const res = await fetch(m.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            mediaFolder.file(name, await res.arrayBuffer());
          } catch {
            missing.push(name);
          }
        }
      }
      if (missing.length > 0) {
        mediaFolder.file(
          "_could-not-download.txt",
          [
            "The following media files could not be downloaded (the file may",
            "have been removed from the media host). Everything else is intact.",
            "",
            ...missing,
          ].join("\n"),
        );
      }

      zip.file("export.json", JSON.stringify(exportData, null, 2));

      setExportProgress("Zipping…");
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `purewire-export-${stamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export downloaded — your posts and media are inside.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not build the export.",
      );
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

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
    // Erasure covers the browser-local preference cache too — the server
    // copy already died with the users row, so the device copy must not
    // survive the account.
    clearAutoplayPreference();
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
      const res = await updateProfile({
        name: name.trim() || undefined,
        username: username.trim() || undefined,
        bio: bio.trim() || undefined,
        links: links.filter((l) => l.platform && l.url.trim()),
        // Dual-mode artwork: an uploaded picture is either a Convex storage
        // id (fallback) or an external Cloudinary URL (primary path) — pass
        // whichever the upload produced; the mutation clears the other.
        avatarStorageId: avatar[0]?.storageId,
        avatarUrl: avatar[0]?.externalUrl,
        bannerStorageId: banner[0]?.storageId,
        bannerUrl: banner[0]?.externalUrl,
        // An empty label is the same as none — null clears it.
        location: location?.label?.trim() ? location : null,
      });
      // A structured rejection (e.g. a link the phishing scan refuses)
      // comes back as a result, not a thrown error — surface the reason.
      if (res && res.ok === false) {
        toast.error(res.error);
        return;
      }
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

  const endOtherSessions = async () => {
    if (endingSessions) return;
    setEndingSessions(true);
    try {
      const { ended } = await signOutOtherSessions();
      toast.success(
        ended === 0
          ? "No other devices were signed in."
          : `Signed out on ${ended} other device${ended === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign out other devices.");
    } finally {
      setEndingSessions(false);
    }
  };

  const sessionSince = currentSession?.createdAt
    ? new Date(currentSession.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

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
          <CardTitle className="text-base">Media</CardTitle>
          <CardDescription>
            Save data and battery when you&apos;re on a phone.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="video-autoplay">
                Play videos automatically
              </Label>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                Applies to every video on your feed and in shared-post
                previews. Off by default on iPhone/iPad and data-saving
                connections — videos then wait for your tap.
              </p>
            </div>
            <Switch
              id="video-autoplay"
              aria-label="Play videos automatically"
              checked={autoplay}
              onCheckedChange={(on) => setPreference(on)}
            />
          </div>
          {preference === "auto" && (
            <p className="text-xs italic text-muted-foreground">
              Currently following the device default.
            </p>
          )}
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
              disabled={user.isOwner}
              title={user.isOwner ? "The owner identity is fixed." : undefined}
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
              disabled={user.isOwner}
              title={user.isOwner ? "The owner handle is fixed." : undefined}
              className={cn(
                isValidUsername(username) ? "" : "border-destructive",
                user.isOwner ? "cursor-not-allowed opacity-60" : "",
              )}
            />
            {!isValidUsername(username) && (
              <p className="text-xs text-destructive">
                3-24 chars: lowercase letters, numbers, underscores.
              </p>
            )}
            {user.isOwner ? (
              <p className="flex items-center gap-1.5 text-xs text-oxide dark:text-oxide-light">
                <ShieldCheck className="size-3.5" />
                The owner identity is fixed — name and handle can never change.
              </p>
            ) : null}
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
            <div
              key={i}
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
            >
              <Select
                value={link.platform}
                onValueChange={(v) => updateLink(i, { platform: v })}
              >
                <SelectTrigger className="w-full sm:w-40 sm:shrink-0">
                  <SelectValue placeholder="Platform" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORM_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                  {/* Legacy rows may carry a platform that isn't in the
                      options list — keep it selectable so nothing gets
                      silently dropped on save. */}
                  {link.platform &&
                    !(PLATFORM_OPTIONS as readonly string[]).includes(
                      link.platform,
                    ) && (
                      <SelectItem value={link.platform}>
                        {link.platform}
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              <Input
                value={link.url}
                onChange={(e) => updateLink(i, { url: e.target.value })}
                placeholder="your.handle"
                className="flex-1 placeholder:text-foreground/55"
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 self-end text-muted-foreground hover:text-destructive sm:self-auto"
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <p className="text-center text-xs text-muted-foreground sm:text-right">
          {user.emailVerificationTime ? "Email verified" : "Email unverified"} ·{" "}
          {user.maskedEmail}
        </p>
        <Button
          onClick={() => void save()}
          disabled={saving}
          className="w-full sm:w-auto"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save changes
        </Button>
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="size-4 text-oxide dark:text-oxide-light" />
            Your location
          </CardTitle>
          <CardDescription>
            A place you call home — search for it or use your current
            location. The label shows on your profile; the coordinates are
            stored only as a coarsened ~1 km area, never the precise point,
            so the Local feed can find what's near you without live tracking.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="location-picker">Home location</Label>
            <LocationPicker
              id="location-picker"
              value={location}
              onChange={setLocation}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Search or type a place name. Only a coarsened ~1 km anchor is
            ever stored — never your exact coordinates — and other members
            only ever see the label you choose.
          </p>
        </CardContent>
      </Card>

      <Separator />

      {/* Sessions — the permanent-session promise, on this device */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Laptop className="size-4 text-oxide dark:text-oxide-light" />
            Your session
          </CardTitle>
          <CardDescription>
            This device's sign-in stays until you sign out — PureWire never
            logs anyone out on a timeout.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 rounded-xl border bg-muted/30 p-4 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Signed in since
              </p>
              <p className="mt-0.5">{sessionSince ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                This session
              </p>
              <p className="mt-0.5">
                {currentSession?.permanent
                  ? "Stays until you sign out"
                  : "Ends after 30 days (you turned off Keep me signed in)"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
            <div className="flex items-start gap-3">
              <LogOut className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-semibold">End the session everywhere else</p>
                <p className="text-sm text-muted-foreground">
                  {currentSession && currentSession.otherSessions > 0
                    ? `Signed in on ${currentSession.otherSessions} other device${currentSession.otherSessions === 1 ? "" : "s"}. Signing out there won't affect this device.`
                    : "You're not signed in anywhere else right now."}
                </p>
              </div>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={
                    endingSessions ||
                    currentSession == null ||
                    currentSession.otherSessions === 0
                  }
                >
                  <LogOut className="size-4" />
                  Sign out everywhere else
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Sign out on every other device?</DialogTitle>
                  <DialogDescription>
                    This ends your session on all other devices. This device
                    stays signed in — you won't be interrupted here. You can
                    sign back in on any device with your email and password.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2 sm:justify-between">
                  <DialogClose asChild>
                    <Button variant="outline" disabled={endingSessions}>
                      Keep this session
                    </Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    className="gap-1.5"
                    disabled={endingSessions}
                    onClick={() => void endOtherSessions()}
                  >
                    {endingSessions ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <LogOut className="size-4" />
                    )}
                    {endingSessions ? "Ending…" : "Sign out everywhere else"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Feed control — personal keyword muting */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <VolumeX className="size-4 text-oxide dark:text-oxide-light" />
            Muted words & phrases
          </CardTitle>
          <CardDescription>
            Posts mentioning anything on your personal list are hidden from
            your feed. Matching is Unicode-aware — "café" and "cafe" are the
            same word — and only ever applied to your own views. Nobody else
            sees your list.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {mutedKeywords.map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
              >
                {k}
                <button
                  type="button"
                  onClick={() =>
                    setMutedKeywords((prev) => prev.filter((x) => x !== k))
                  }
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  aria-label={`Remove ${k}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {mutedKeywords.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No muted words yet — add topics you'd rather not see.
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Input
              value={muteInput}
              onChange={(e) => setMuteInput(e.target.value)}
              placeholder="e.g. election, spoilers"
              className="max-w-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addMute();
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={addMute}
              disabled={!muteInput.trim()}
            >
              <Plus className="size-4" />
              Add
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={saveMutes}
              disabled={savingMutes}
              title="Save your mute list"
            >
              {savingMutes ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Direct messages — who can reach you */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="size-4 text-oxide dark:text-oxide-light" />
            Who can message you
          </CardTitle>
          <CardDescription>
            PureWire DMs are end-to-end encrypted — but you decide who can
            even open a conversation with you in the first place, before any
            message or key exchange happens.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {(
              [
                { value: "everyone", label: "Everyone" },
                { value: "following", label: "Accounts I follow" },
                { value: "nobody", label: "Nobody" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setDmPermission(opt.value);
                  void saveDmPermission(opt.value);
                }}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  dmPermission === opt.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {dmPermission === "everyone"
              ? "Any member can start a conversation with you."
              : dmPermission === "following"
                ? "Only accounts you follow can message you. Other members see a notice instead of a message box."
                : "No one can open a conversation with you. Your existing threads stay readable."}
          </p>
        </CardContent>
      </Card>

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
            email — only a salted one-way hash. Everything you create is kept
            only as long as your account exists. You can delete your account
            and all of it permanently, right here.
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
              <p className="mt-0.5">Salted one-way SHA-256 hash only</p>
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
            long, and how it is protected.{" "}
            <Link to="/about" className="text-primary hover:underline">
              See everything PureWire offers — fees, feeds, features, and
              policies
            </Link>
            .
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <Download className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="font-semibold">Download your data</p>
                <p className="text-sm text-muted-foreground">
                  A ZIP archive of everything you've created — your posts as
                  readable text, the photos, videos, and audio files you
                  uploaded, plus the full data archive. Yours to keep, back up,
                  or take anywhere.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={downloadExport}
              disabled={exporting || exportData === undefined}
            >
              {exporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {exporting ? (exportProgress ?? "Preparing…") : "Download archive"}
            </Button>
          </div>
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
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  disabled={user.isOwner}
                  title={
                    user.isOwner
                      ? "The owner account cannot be deleted — the platform is not self-destructible."
                      : undefined
                  }
                >
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
