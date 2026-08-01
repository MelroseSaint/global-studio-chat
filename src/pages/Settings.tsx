import { useMutation } from "convex/react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { isValidUsername, PLATFORM_OPTIONS } from "@/lib/format";

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

  const [name, setName] = useState(user.name ?? "");
  const [username, setUsername] = useState(user.username ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [links, setLinks] = useState<LinkRow[]>(user.links ?? []);
  const [avatar, setAvatar] = useState<MediaItem[]>([]);
  const [banner, setBanner] = useState<MediaItem[]>([]);
  const [saving, setSaving] = useState(false);

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
          Customize your profile and how others see you on PureWire.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Photo & banner</CardTitle>
          <CardDescription>
            Upload your own photos — no link needed.
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
              placeholder="Tell people about yourself…"
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
    </div>
  );
}
