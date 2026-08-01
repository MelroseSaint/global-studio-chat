import { Link, useNavigate } from "react-router";

import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

export function LogoDropdown({
  className,
}: {
  className?: string;
}) {
  const { isAuthenticated, user, signOut } = useAuth();
  const navigate = useNavigate();

  if (!isAuthenticated) {
    return (
      <Button asChild variant="ghost" className={cn("p-0", className)}>
        <Link to="/" className="gap-2">
          <img
            src="/logo.svg"
            alt="PureWire"
            className="size-7 rounded-lg"
          />
          <span className="font-semibold tracking-tight">PureWire</span>
        </Link>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className={cn("gap-2 p-0", className)}>
          <UserAvatar user={user} className="size-7" />
          <span className="hidden font-semibold tracking-tight sm:inline">
            {user?.name ?? user?.username ?? "PureWire"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium">
            {user?.name ?? user?.username ?? "Member"}
            {user?.verified ? " ✓" : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            @{user?.username}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/home")}>
          Home
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate(`/u/${user?.username}`)}>
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/support")}>
          Support
        </DropdownMenuItem>
        {user?.role === "admin" && (
          <DropdownMenuItem onClick={() => navigate("/admin")}>
            Admin
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void signOut();
            navigate("/");
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
