/**
 * The app's PUBLIC routes — reachable without signing in.
 *
 * Single source of truth shared by the router (src/main.tsx) and the SEO
 * sitemap (src/convex/sitemap.ts): adding a public page here registers it
 * in both automatically instead of hand-editing each. Auth-gated routes
 * (the RequireAuth block) deliberately live outside this list — the sitemap
 * must never submit URLs that redirect to a login page.
 */
export const PUBLIC_ROUTES = [
  "/",
  "/auth",
  "/privacy",
  "/terms",
  "/status",
] as const;
