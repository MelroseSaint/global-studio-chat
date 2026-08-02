import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
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
const Support = lazy(() =>
  import("@/pages/Support").then((m) => ({ default: m.Support })),
);
const Terms = lazy(() => import("@/pages/Terms").then((m) => ({ default: m.Terms })));

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
          <BrowserRouter>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route
                element={
                  <RequireAuth>
                    <AppLayout />
                  </RequireAuth>
                }
              >
                <Route path="/home" element={<Feed />} />
                <Route path="/explore" element={<Explore />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/u/:username" element={<Profile />} />
                <Route path="/post/:postId" element={<PostDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/support" element={<Support />} />
                <Route path="/admin" element={<Admin />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
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
        </BrowserRouter>
      </TooltipProvider>
      </ConvexAuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
