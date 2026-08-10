import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";

import { auth } from "@/convex/auth";
import { verifyAdminIp } from "./adminIp";
import { postOg, profileOg } from "./og";
import { robotsTxt } from "./robots";
import { sitemapXml } from "./sitemap";
import { components } from "./_generated/api";

const http = httpRouter();

// Auth OIDC discovery, token exchange and callback routes.
auth.addHttpRoutes(http);

// Server-rendered Open Graph page for a single post. Registered BEFORE the
// static site routes so /og/post/:id can never be shadowed by the SPA
// catch-all — the Vercel middleware fetches this for crawlers hitting
// /post/:id, giving shared links a real post preview instead of the generic
// PureWire card.
http.route({
  pathPrefix: "/og/post/",
  method: "GET",
  handler: postOg,
});

// Server-rendered Open Graph page for a single profile. Same reasoning as
// the post route above: registered before the static routes so
// /og/profile/:handle serves the ProfilePage to crawlers (the Vercel
// middleware proxies /u/:handle here) instead of the SPA catch-all.
http.route({
  pathPrefix: "/og/profile/",
  method: "GET",
  handler: profileOg,
});

// Dynamic sitemap: replaces the static public/sitemap.xml so user content
// (posts + profiles) is indexable. The Vercel middleware proxies
// /sitemap.xml here for every user-agent. Registered before the static
// routes so the SPA catch-all can never shadow it.
http.route({
  path: "/sitemap.xml",
  method: "GET",
  handler: sitemapXml,
});

// Host-aware robots.txt: the canonical domain keeps allow + sitemap, every
// other host (the Convex static mirror, preview deploys) gets a full
// disallow so Google ranks purewire.vercel.app, never the mirror. Without
// this, the static public/robots.txt ("Allow: /") would be served here too
// and the mirror would stay crawlable. Registered before the static routes
// so the SPA catch-all can never shadow it.
http.route({
  path: "/robots.txt",
  method: "GET",
  handler: robotsTxt,
});

// Backend-verified admin IP binding (see adminIp.ts). The admin client
// POSTs here with its bearer token right after sign-in and on a heartbeat;
// the action records the IP the edge OBSERVED (not one the client claims),
// and requireAdmin refuses admin power unless that binding is fresh. POST
// + OPTIONS (CORS preflight); registered before the static routes so the
// SPA catch-all can never shadow it.
http.route({
  path: "/admin/ip/verify",
  method: "POST",
  handler: verifyAdminIp,
});
http.route({
  path: "/admin/ip/verify",
  method: "OPTIONS",
  handler: verifyAdminIp,
});

// Serve the PureWire frontend (dist) from https://outgoing-seal-727.convex.site.
// The staticHosting component is mounted in convex.config.ts; dist is uploaded
// by `npm run upload:version`. Vercel remains the primary host, and the
// UpdateBanner uses the same component's deployment query for live-reload.
registerStaticRoutes(http, components.staticHosting);

export default http;
