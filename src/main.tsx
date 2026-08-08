import { StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { UpdateBanner } from "@convex-dev/static-hosting/react";

import { AppLayout } from "@/components/AppLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PageLoader } from "@/components/PageLoader";
import { RequireAuth } from "@/components/RequireAuth";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/index.css";
import { PUBLIC_ROUTES } from "@/lib/routes";

// Entry and error pages stay eager for an instant first paint. Every other
// route is code-split: the shell downloads once and the page body streams in
// on demand, so the initial bundle stays small.
import { Landing } from "@/pages/Landing";
import { NotFound } from "@/pages/NotFound";

// Pages export named components, so each lazy factory remaps its named export
// onto the `default` that React.lazy resolves.
const Admin = lazy(() => import("@/pages/Admin").then((m) => ({ default: m.Admin })));
const Auth = lazy(() => import("@/pages/Auth").then((m) => ({ default: m.Auth })));
const Explore = lazy(() =>
  import("@/pages/Explore").then((m) => ({ default: m.Explore })),
);
const Feed = lazy(() => import("@/pages/Feed").then((m) => ({ default: m.Feed })));
const Messages = lazy(() =>
  import("@/pages/Messages").then((m) => ({ default: m.Messages })),
);
const Notifications = lazy(() =>
  import("@/pages/Notifications").then((m) => ({ default: m.Notifications })),
);
const PostDetail = lazy(() =>
  import("@/pages/PostDetail").then((m) => ({ default: m.PostDetail })),
);
const Privacy = lazy(() =>
  import("@/pages/Privacy").then((m) => ({ default: m.Privacy })),
);
const Profile = lazy(() =>
  import("@/pages/Profile").then((m) => ({ default: m.Profile })),
);
const Settings = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.Settings })),
);
const Status = lazy(() =>
  import("@/pages/Status").then((m) => ({ default: m.Status })),
);
const Support = lazy(() =>
  import("@/pages/Support").then((m) => ({ default: m.Support })),
);
const Terms = lazy(() => import("@/pages/Terms").then((m) => ({ default: m.Terms })));

// One element per shared public route (PUBLIC_ROUTES). Adding a route to
// the manifest registers it here AND in the SEO sitemap automatically.
const PUBLIC_ELEMENTS: Record<(typeof PUBLIC_ROUTES)[number], ReactNode> = {
  "/": <Landing />,
  "/auth": <Auth />,
  "/privacy": <Privacy />,
  "/terms": <Terms />,
  "/status": <Status />,
};

// Data router: every navigation state update runs inside React's
// startTransition, so a route change never blocks the next paint — the
// previous UI stays visible until the destination's render commits (and
// Suspense shows the loader only while a lazy chunk streams in). Tap-to-
// navigate INP stays low even when the destination page (e.g. /auth) mounts
// heavy content, instead of the click waiting out the full mount.
const router = createBrowserRouter([
  ...PUBLIC_ROUTES.map((path) => ({ path, element: PUBLIC_ELEMENTS[path] })),
  {
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { path: "/home", element: <Feed /> },
      { path: "/messages", element: <Messages /> },
      { path: "/explore", element: <Explore /> },
      { path: "/notifications", element: <Notifications /> },
      { path: "/u/:username", element: <Profile /> },
      { path: "/post/:postId", element: <PostDetail /> },
      { path: "/settings", element: <Settings /> },
      { path: "/support", element: <Support /> },
      { path: "/admin", element: <Admin /> },
    ],
  },
  { path: "*", element: <NotFound /> },
]);

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

// PWA: register the offline-capable service worker in production only (in
// dev it would fight Vite's HMR and live reload).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is progressive — a failed registration never blocks
      // the app.
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* A failing query (e.g. backend drift) must never blank the app — the
        boundary renders a reload fallback instead. */}
    <ErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <TooltipProvider delayDuration={200}>
          <Suspense fallback={<PageLoader />}>
            <RouterProvider router={router} />
          </Suspense>
          {/* Live-reload prompt when a new deployment ships. */}
          <UpdateBanner
            message="A new version of PureWire is available"
            buttonText="Refresh"
            className="brand-gradient-bg"
            style={{
              borderRadius: "999px",
              padding: "0.65rem 0.75rem 0.65rem 1.25rem",
              boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35)",
              fontSize: "14px",
            }}
          />
          <Toaster />
        </TooltipProvider>
      </ConvexAuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
