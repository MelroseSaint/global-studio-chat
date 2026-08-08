import { useMutation, useQuery } from "convex/react";
import {
  Bell,
  Compass,
  Home,
  LifeBuoy,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Settings,
  Shield,
  User,
} from "lucide-react";
import { Component, Suspense, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";

import { api } from "@/convex/_generated/api";
import { PageLoader } from "@/components/PageLoader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useAdminIpVerify } from "@/hooks/use-admin-ip-verify";
import { detectAutomation } from "@/lib/automation-signal";
import {
  clientRegionToken,
  clientUaHash,
} from "@/lib/session-signal";
import { cn } from "@/lib/utils";

function NavItem({
  to,
  icon: Icon,
  label,
  end = false,
  badge,
  title,
  ariaLabel,
  stacked = false,
}: {
  to: string;
  icon: typeof Home;
  label: string;
  end?: boolean;
  badge?: number;
  title?: string;
  ariaLabel?: string;
  /** Compact icon-over-label form used by the mobile bottom bar. */
  stacked?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={title}
      // The label span is display:none below lg (icon-only rail), which
      // removes it from the accessibility tree — the aria-label keeps the
      // item named for screen readers at every breakpoint. An explicit
      // ariaLabel (e.g. the Admin workload string) wins when present.
      aria-label={ariaLabel ?? label}
      className={({ isActive }) =>
        cn(
          "relative flex items-center rounded-xl font-medium transition-colors",
          stacked
            ? "min-w-0 flex-1 flex-col gap-0.5 px-1 py-1.5 text-[10px] leading-none"
            : "gap-3 px-3 py-2.5 text-[15px] sm:justify-center lg:justify-start",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-foreground/80 hover:bg-muted hover:text-foreground",
        )
      }
    >
      <span className="relative">
        <Icon className={stacked ? "size-[22px]" : "size-5"} />
        {badge ? (
          <span className="absolute -right-2 -top-1.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
      {stacked ? (
        <span className="w-full max-w-full truncate text-center">{label}</span>
      ) : (
        <span className="hidden lg:inline">{label}</span>
      )}
    </NavLink>
  );
}

/**
 * Catches a query error so the workload badge can degrade to "nothing"
 * instead of crashing the shell. useQuery in this Convex version THROWS
 * query errors during render (there is no error-as-value path), so the
 * only way to keep a failure local is an error boundary around the
 * component that runs the query. Keyed on `enabled` by the caller, so the
 * boundary resets (and the query re-subscribes) whenever the admin's
 * verification state changes — a failure is only ever "no badge for this
 * window", never a permanent blank.
 */
class WorkloadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Runs the moderation workload query and reports its data upward via
 * onData. Lives inside WorkloadBoundary, so a failing query renders
 * nothing (no badge, no title) until the backend recovers — the shell
 * never crashes over a badge count.
 */
function WorkloadQuery({
  enabled,
  onData,
}: {
  enabled: boolean;
  onData: (w: { openTickets: number; aiReview: number } | undefined) => void;
}) {
  const workload = useQuery(
    api.admin.moderationWorkload,
    enabled ? undefined : "skip",
  );
  useEffect(() => {
    onData(
      workload !== undefined && typeof workload === "object"
        ? workload
        : undefined,
    );
  }, [workload, onData]);
  return null;
}

export function AppLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const unread = useQuery(api.notifications.unreadCount);
  const dmUnread = useQuery(api.dms.unreadDmCount);
  const ensureAdminStatus = useMutation(api.admin.ensureAdminStatus);
  const pruneExpiredStories = useMutation(api.account.pruneExpiredStories);
  // Self-auditing session security: file this device's one-way fingerprint
  // against the session. A wildly different fingerprint on a later load
  // silently revokes the session and signs this device out.
  const sessionSignal = useMutation(api.sessionAudit.signal);
  // Browser-automation detection: the client scores its own browser for
  // headless/CDP/driver markers and files the coarse score. Feeding the
  // silent-flag pipeline, so driven browsers quietly lose reach instead of
  // getting a single user-facing rejection.
  const reportAutomation = useMutation(api.automation.report);
  const [sessionRevoked, setSessionRevoked] = useState(false);
  const isAdmin = user?.role === "admin";

  // Backend-verified admin device gate (see adminIp.ts): while the admin
  // is signed in, the backend must keep OBSERVING this session's IP — the
  // browser proves nothing on its own. Heartbeats every few minutes, and
  // re-verifies on tab focus / reconnect. If the backend ever sees this
  // session from a different IP it deletes the session and reports it
  // revoked — we sign out immediately, so no admin power survives a
  // cross-network replay. Declared before the workload query because that
  // query is gated on its result.
  const adminIpState = useAdminIpVerify({
    enabled: isAdmin && !sessionRevoked,
    onRevoked: async () => {
      setSessionRevoked(true);
      await signOut();
    },
  });
  // The Admin entry (nav + badge) only appears once this device has been
  // verified against the backend; while the first verify is in flight the
  // admin simply sees no Admin menu rather than a flashing, half-usable
  // dashboard. (The page itself also gates on adminIpStatus.)
  const adminVerified = adminIpState === "verified";

  // Moderation workload for admins: open tickets + posts waiting on AI
  // review. FIRES ONLY AFTER the device is IP-verified: requireAdmin →
  // assertAdminIpVerified throws a ConvexError when the binding is
  // missing or stale, and useQuery THROWS query errors during render in
  // this Convex version (there is no error-as-value path), so firing
  // before verification would crash the whole shell with a route error.
  // Gating mirrors the Admin page, which refuses to fire its data queries
  // until adminIpStatus reports verified.
  // The workload badge: open tickets + posts waiting on AI review. Runs in
  // a boundary-isolated child so a query failure shows no badge instead of
  // crashing the shell, and only fires once the device is IP-verified.
  const [workloadData, setWorkloadData] = useState<
    { openTickets: number; aiReview: number } | undefined
  >(undefined);
  const moderationTotal =
    workloadData === undefined
      ? 0
      : workloadData.openTickets + workloadData.aiReview;
  const workloadTitle =
    workloadData === undefined
      ? undefined
      : `${workloadData.openTickets} open ticket${workloadData.openTickets === 1 ? "" : "s"} · ${workloadData.aiReview} post${workloadData.aiReview === 1 ? "" : "s"} in review`;

  // Ensure a pre-existing admin account (e.g. from earlier testing) gets
  // the admin role on next load, and prune expired story content so
  // nothing outlives its 24-hour life.
  useEffect(() => {
    if (user) {
      void ensureAdminStatus();
      void pruneExpiredStories();
    }
  }, [user, ensureAdminStatus, pruneExpiredStories]);

  // Self-auditing session fingerprint: on every shell load, file this
  // device's fingerprint. If the server finds a different fingerprint on
  // the same session (stolen cookie, account takeover), it revokes the
  // session and we sign out with a clear reason.
  useEffect(() => {
    if (!user || sessionRevoked) return;
    let cancelled = false;
    void (async () => {
      try {
        const [uaHash, regionToken] = await Promise.all([
          clientUaHash(),
          Promise.resolve(clientRegionToken()),
        ]);
        const res = await sessionSignal({ uaHash, regionToken });
        if (!cancelled && res?.revoked === true) {
          setSessionRevoked(true);
          // The session no longer exists server-side — clear the local
          // auth state so the sign-in gate redirects to /auth.
          await signOut();
        }
      } catch {
        // Fingerprinting is best-effort; never crash the shell for it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, sessionRevoked, sessionSignal, signOut]);

  // Browser-automation detection: score this browser once per session and
  // file the coarse result. Non-blocking and best-effort — a real user
  // whose browser trips a weak signal is never interrupted; the score only
  // feeds the quiet escalation pipeline when several strong automation
  // markers agree.
  useEffect(() => {
    if (!user || sessionRevoked) return;
    try {
      const { score, signals } = detectAutomation();
      if (score > 0 || signals.length > 0) {
        void reportAutomation({ score, signals }).catch(() => {});
      }
    } catch {
      // Detection is optional; never let it affect the shell.
    }
  }, [user, sessionRevoked, reportAutomation]);

  // PWA app-icon badge: the OS shows the pending moderation workload on the
  // installed PureWire icon so admins know there is work waiting even when
  // the app is closed. Only meaningful in a standalone-installed context;
  // the Badging API is a progressive enhancement (guarded, never throws).
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    if (moderationTotal > 0) {
      void navigator.setAppBadge(moderationTotal).catch(() => {});
    } else {
      void navigator.clearAppBadge().catch(() => {});
    }
  }, [moderationTotal]);

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
      <WorkloadBoundary
        key={isAdmin && adminVerified && !sessionRevoked ? "on" : "off"}
      >
        <WorkloadQuery
          enabled={isAdmin && adminVerified && !sessionRevoked}
          onData={setWorkloadData}
        />
      </WorkloadBoundary>

      {/* Sidebar — icon-only w-20 rail at sm–lg (tablets), full w-64 with
          labels at lg+. Below sm the bottom nav takes over. */}
      <aside className="sticky top-0 hidden h-[calc(100dvh-env(safe-area-inset-top))] w-20 shrink-0 flex-col border-r bg-sidebar pt-[env(safe-area-inset-top)] sm:flex lg:w-64">
        <div className="flex h-16 items-center px-4 sm:justify-center lg:justify-start lg:px-6">
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
            to="/messages"
            icon={MessageSquare}
            label="Messages"
            badge={dmUnread ?? 0}
          />
          <NavItem
            to="/notifications"
            icon={Bell}
            label="Notifications"
            badge={unread ?? 0}
          />
          <NavItem to={profileTo} icon={User} label="Profile" />
          <NavItem to="/settings" icon={Settings} label="Settings" />
          <NavItem to="/support" icon={LifeBuoy} label="Support" />
        </nav>
        <div className="border-t p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground sm:justify-center lg:justify-start"
                aria-label={
                  isAdmin && moderationTotal > 0
                    ? `More — ${moderationTotal} item${moderationTotal === 1 ? "" : "s"} awaiting moderation`
                    : "More"
                }
              >
                <span className="relative">
                  <MoreHorizontal className="size-5" />
                  {isAdmin && moderationTotal > 0 ? (
                    <span className="absolute -right-1.5 -top-1 size-2 rounded-full bg-primary" />
                  ) : null}
                </span>
                <span className="hidden lg:inline">More</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-52">
              {isAdmin && adminVerified ? (
                <DropdownMenuItem
                  className="cursor-pointer"
                  onSelect={() => navigate("/admin")}
                  title={workloadTitle}
                >
                  <Shield />
                  Admin
                  {moderationTotal > 0 ? (
                    <span className="ml-auto flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                      {moderationTotal > 99 ? "99+" : moderationTotal}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="cursor-pointer"
                onSelect={() => void handleSignOut()}
              >
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col lg:ml-0">
        {/* Top header — phones only. Tablets get the icon rail (which
            carries the logo) and desktops the full sidebar, so showing
            this bar there would duplicate the brand mark. */}
        <header className="sticky top-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center border-b bg-background/80 px-4 pt-[env(safe-area-inset-top)] backdrop-blur sm:hidden">
          <NavLink to="/home" className="flex items-center gap-2">
            <img src="/logo.svg" alt="PureWire" className="size-7 rounded-lg" />
            <span className="font-bold tracking-tight">PureWire</span>
          </NavLink>
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

      {/* Phone bottom nav — below sm only; tablets use the icon rail and
          desktops the full sidebar. Capped at five slots so it never crowds
          a phone. Secondary destinations (Support, Settings, Admin) live in
          the More menu instead of stretching the bar. */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 flex items-stretch justify-around gap-1 border-t bg-background/95 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 backdrop-blur sm:hidden">
        <NavItem to="/home" icon={Home} label="Home" end stacked />
        <NavItem to="/explore" icon={Compass} label="Discover" stacked />
        <NavItem
          to="/notifications"
          icon={Bell}
          label="Alerts"
          badge={unread ?? 0}
          stacked
        />
        <NavItem to={profileTo} icon={User} label="Profile" stacked />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-[10px] leading-none font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground",
              )}
              aria-label={
                isAdmin && moderationTotal > 0
                  ? `More — ${moderationTotal} item${moderationTotal === 1 ? "" : "s"} awaiting moderation`
                  : "More"
              }
            >
              <span className="relative">
                <MoreHorizontal className="size-[22px]" />
                {isAdmin && moderationTotal > 0 ? (
                  <span className="absolute -right-1.5 -top-1 size-2 rounded-full bg-primary" />
                ) : null}
              </span>
              More
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-52">
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => navigate("/messages")}
            >
              <MessageSquare />
              Messages
              {dmUnread && dmUnread > 0 ? (
                <span className="ml-auto flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  {dmUnread > 99 ? "99+" : dmUnread}
                </span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => navigate("/support")}
            >
              <LifeBuoy />
              Support
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => navigate("/settings")}
            >
              <Settings />
              Settings
            </DropdownMenuItem>
            {isAdmin && adminVerified ? (
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => navigate("/admin")}
                title={workloadTitle}
              >
                <Shield />
                Admin
                {moderationTotal > 0 ? (
                  <span className="ml-auto flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {moderationTotal > 99 ? "99+" : moderationTotal}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="cursor-pointer"
              onSelect={() => void handleSignOut()}
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </div>
  );
}
