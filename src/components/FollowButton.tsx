import { useMutation } from "convex/react";
import { Loader2, UserCheck, UserPlus } from "lucide-react";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { mayProceed } from "@/lib/rate-limit";

export function FollowButton({
  username,
  initialFollowing,
  className,
  size = "sm",
}: {
  username: string;
  initialFollowing: boolean;
  className?: string;
  size?: "sm" | "default" | "lg";
}) {
  const follow = useMutation(api.users.follow);
  const unfollow = useMutation(api.users.unfollow);
  const { user } = useAuth();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const next = !following;
    // Redis preflight (distributed token bucket) — fail fast before the
    // backend write when the hourly follow budget is spent. Degrades
    // open; Convex's table limit is the backstop.
    if (next && !(await mayProceed("follow", user?._id))) {
      setBusy(false);
      toast.error(
        "You're moving a little too fast. Slow down and try again in a moment.",
      );
      return;
    }
    setFollowing(next);
    try {
      if (next) {
        await follow({ username });
      } else {
        await unfollow({ username });
      }
    } catch (err) {
      setFollowing(!next);
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant={following ? "outline" : "default"}
      size={size}
      className={className}
      onClick={() => void toggle()}
      disabled={busy}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : following ? (
        <UserCheck className="size-4" />
      ) : (
        <UserPlus className="size-4" />
      )}
      {following ? "Following" : "Follow"}
    </Button>
  );
}
