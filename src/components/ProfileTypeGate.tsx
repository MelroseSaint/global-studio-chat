import { useMutation } from "convex/react";
import { Check, Loader2, Palette, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ProfileType = "creator" | "user";

/**
 * The required profile-type declaration, shown as a full-screen gate the
 * moment a signed-in member's `profileType` is unset — new signups land on
 * this step right after verification, before any app content. It renders
 * INSTEAD of the app shell (identity comes first: no feed behind it), and
 * cannot be dismissed without a choice. Nothing is ever assigned silently;
 * the selection is the member's own declaration, and changing it later is
 * always possible in Settings.
 */
export function ProfileTypeGate({
  username,
}: {
  username?: string;
}) {
  const setProfileType = useMutation(api.users.setProfileType);
  const [selected, setSelected] = useState<ProfileType | null>(null);
  const [saving, setSaving] = useState(false);

  const confirm = async () => {
    if (selected === null || saving) return;
    setSaving(true);
    try {
      await setProfileType({ profileType: selected });
      // The users doc (getCurrentUser) updates reactively — the shell
      // unmounts this gate the moment the field lands.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your profile type.");
      setSaving(false);
    }
  };

  const option = (
    value: ProfileType,
    icon: React.ReactNode,
    title: string,
    body: string,
  ) => (
    <button
      type="button"
      onClick={() => setSelected(value)}
      aria-pressed={selected === value}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors",
        selected === value
          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
          : "border-border hover:border-primary/40 hover:bg-muted/40",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {selected === value ? (
            <Check className="size-4 shrink-0 text-primary" />
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {body}
        </span>
      </span>
    </button>
  );

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img
            src="/lockup.svg"
            alt="PureWire — say it anyway"
            className="h-10 w-auto"
          />
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              What type of profile are you?
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {username ? `Welcome, ${username}. ` : ""}This is how you
              identify your profile — you can change it any time in Settings.
              It doesn&apos;t affect what you can do, your content, or your
              followers.
            </p>
          </div>
        </div>

        <div className="grid gap-2.5">
          {option(
            "creator",
            <Palette className="size-5 text-primary" />,
            "Creator",
            "I create and publish original content.",
          )}
          {option(
            "user",
            <UserRound className="size-5 text-muted-foreground" />,
            "User",
            "I primarily use PureWire to discover, interact, and participate.",
          )}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Neither choice means more or less — Creator isn&apos;t a verified
          badge and User isn&apos;t a restricted one. Both profiles can post,
          share, and participate.
        </p>
        <Button
          className="mt-5 w-full"
          onClick={() => void confirm()}
          disabled={selected === null || saving}
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          Continue
        </Button>
      </div>
    </div>
  );
}
