import { useMutation, useQuery } from "convex/react";
import {
  Bell,
  Compass,
  Home,
  LifeBuoy,
  LogOut,
  Settings,
  Shield,
  User,
} from "lucide-react";
import { Suspense, useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";

import { api } from "@/convex/_generated/api";
import { PageLoader } from "@/components/PageLoader";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

function NavItem({
  to,
  icon: Icon,
  label,
  end = false,
  badge,
}: {
  to: string;
  icon: typeof Home;
  label: string;
  end?: boolean;
  badge?: number;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-foreground/80 hover:bg-muted hover:text-foreground",
        )
      }
    >
      <span className="relative">
        <Icon className="size-5" />
        {badge ? (
          <span className="absolute -right-2 -top-1.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
      <span className="hidden lg:inline">{label}</span>
    </NavLink>
  );
}

export function AppLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const unread = useQuery(api.notifications.unreadCount);
  const ensureAdminStatus = useMutation(api.admin.ensureAdminStatus);
  const pruneExpiredStories = useMutation(api.account.pruneExpiredStories);

  // Ensure a pre-existing admin account (e.g. from earlier testing) gets
  // the admin role on next load, and prune expired story content so
  // nothing outlives its 24-hour life.
  useEffect(() => {
    if (user) {
      void ensureAdminStatus();
      void pruneExpiredStories();
    }
  }, [user, ensureAdminStatus, pruneExpiredStories]);

  const username = user?.username ?? "";
  // A member without a username yet has no profile page — send them to
  // Settings (where they can pick one) instead of a dead `/u/` route that
  // 404s.
  const profileTo = username ? `/u/${username}` : "/settings";

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <div className="flex min-h-dvh">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-20 shrink-0 flex-col border-r bg-sidebar lg:flex lg:w-64">
        <div className="flex h-16 items-center px-4 lg:px-6">
          <NavLink to="/home" className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="PureWire" className="size-8 rounded-xl" />
            <span className="hidden font-bold tracking-tight lg:inline">
              PureWire
            </span>
          </NavLink>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          <NavItem to="/home" icon={Home} label="Home" end />
          <NavItem to="/explore" icon={Compass} label="Discover" />
          <NavItem
            to="/notifications"
            icon={Bell}
            label="Notifications"
            badge={unread ?? 0}
          />
          <NavItem to={profileTo} icon={User} label="Profile" />
          <NavItem to="/settings" icon={Settings} label="Settings" />
          <NavItem to="/support" icon={LifeBuoy} label="Support" />
          {user?.role === "admin" && (
            <NavItem to="/admin" icon={Shield} label="Admin" />
          )}
        </nav>
        <div className="border-t p-3">
          <button
            onClick={() => void handleSignOut()}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogOut className="size-5" />
            <span className="hidden lg:inline">Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col lg:ml-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-background/80 px-4 backdrop-blur lg:hidden">
          <NavLink to="/home" className="flex items-center gap-2">
            <img src="/logo.svg" alt="PureWire" className="size-7 rounded-lg" />
            <span className="font-bold tracking-tight">PureWire</span>
          </NavLink>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="relative size-9"
              onClick={() => navigate("/notifications")}
              aria-label="Notifications"
            >
              <Bell className="size-5" />
              {unread ? (
                <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary" />
              ) : null}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              onClick={() => navigate(profileTo)}
              aria-label="Profile"
            >
              <UserAvatar user={user} className="size-8" />
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-2xl flex-1">
          {/* Inner Suspense keeps the sidebar and mobile nav mounted while a
              lazy page chunk streams in — only the content column shows the
              loader, not the whole app shell. */}
          <Suspense fallback={<PageLoader label="Opening" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around border-t bg-background/95 py-2 backdrop-blur lg:hidden">
        <NavItem to="/home" icon={Home} label="" end />
        <NavItem to="/explore" icon={Compass} label="" />
        <NavItem to="/notifications" icon={Bell} label="" badge={unread ?? 0} />
        <NavItem to="/support" icon={LifeBuoy} label="" />
        {user?.role === "admin" && <NavItem to="/admin" icon={Shield} label="" />}
        <NavItem to={profileTo} icon={User} label="" />
      </nav>
    </div>
  );
}
