import { cn } from "@/lib/utils";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export interface UserAvatarUser {
  _id?: string;
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  image?: string | null;
}

export function UserAvatar({
  user,
  className,
  ring = false,
}: {
  user: UserAvatarUser | null | undefined;
  className?: string;
  ring?: boolean;
}) {
  const src = user?.avatarUrl ?? user?.image ?? undefined;
  const label = user?.name ?? user?.username ?? "?";
  return (
    <Avatar
      className={cn(
        "size-9 shrink-0 select-none border border-border/60",
        ring && "ring-2 ring-ring/60",
        className,
      )}
    >
      <AvatarImage src={src} alt={label} />
      <AvatarFallback className="bg-primary/10 font-semibold text-primary">
        {(label ?? "?").slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
