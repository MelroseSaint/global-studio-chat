import { useMutation } from "convex/react";
import { Check, Loader2, Palette, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type ProfileType = "creator" | "user";

/**
 * The required profile-type selection. Shown to every signed-in member
 * whose `profileType` is unset — new signups right after they land, and
 * existing accounts until they choose. It cannot be dismissed without a
 * choice (the selection is the member's own declaration; nothing is ever
 * assigned silently). Changing it later is always possible in Settings.
 */
export function ProfileTypePrompt({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
      // unmounts this prompt the moment the field lands.
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your profile type.");
    } finally {
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
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>What type of profile are you?</DialogTitle>
          <DialogDescription>
            This is how you identify your profile — you can change it any
            time in Settings. It doesn&apos;t affect what you can do, your
            content, or your followers.
          </DialogDescription>
        </DialogHeader>
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
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Neither choice means more or less — Creator isn&apos;t a verified
          badge and User isn&apos;t a restricted one. Both profiles can post,
          share, and participate.
        </p>
        <Button onClick={() => void confirm()} disabled={selected === null || saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          Continue
        </Button>
      </DialogContent>
    </Dialog>
  );
}
