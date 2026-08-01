import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { UpdateBanner } from "@convex-dev/static-hosting/react";

import { AppLayout } from "@/components/AppLayout";
import { RequireAuth } from "@/components/RequireAuth";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/index.css";

import { Admin } from "@/pages/Admin";
import { Auth } from "@/pages/Auth";
import { Explore } from "@/pages/Explore";
import { Feed } from "@/pages/Feed";
import { Landing } from "@/pages/Landing";
import { NotFound } from "@/pages/NotFound";
import { Notifications } from "@/pages/Notifications";
import { PostDetail } from "@/pages/PostDetail";
import { Privacy } from "@/pages/Privacy";
import { Profile } from "@/pages/Profile";
import { Settings } from "@/pages/Settings";
import { Support } from "@/pages/Support";
import { Terms } from "@/pages/Terms";

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
    <ConvexAuthProvider client={convex}>
      <TooltipProvider delayDuration={200}>
        <BrowserRouter>
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
  </StrictMode>,
);
