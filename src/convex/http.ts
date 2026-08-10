import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";

import { httpAction } from "./_generated/server";
import { auth } from "@/convex/auth";
import { verifyAdminIp } from "./adminIp";
import { pageOg, postOg, profileOg } from "./og";
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

// Server-rendered static page (/og/about) — the fee/feature disclosure.
// Registered before the static routes so the SPA catch-all can never shadow
// it; the Vercel middleware proxies /about here for crawler user-agents so
// Googlebot sees the real disclosure text instead of a blank SPA shell.
// Both spellings are registered: the middleware fetches /og/about (no
// trailing slash), and a trailing-slash hit must not 404 either.
http.route({
  path: "/og/about",
  method: "GET",
  handler: pageOg,
});
http.route({
  pathPrefix: "/og/about/",
  method: "GET",
  handler: pageOg,
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

// QA feed echo — serves a deterministic blocklist feed fixture for the
// blocklist-engine QA. The QA used to point its fixture feed at
// httpbin.org/base64, a third-party service that flakes (503s) and reds
// the nightly gate; this route is the self-hosted replacement. The URL
// carries the payload as base64 (same shape as httpbin), the handler
// decodes and serves it as text/plain, and the harness env gate keeps it
// inert on any deployment without the QA harness enabled. Registered
// before the static routes so it can never be shadowed by the SPA.
http.route({
  pathPrefix: "/qa/feed/",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    if (process.env.TEST_HARNESS_ENABLED !== "1") {
      return new Response("Not found", { status: 404 });
    }
    const path = new URL(request.url).pathname;
    const payload = path.slice("/qa/feed/".length).split("/")[0] ?? "";
    if (payload.length === 0) {
      return new Response("Missing payload", { status: 400 });
    }
    // URL-safe base64: standard base64 contains `/` and `+`, which would
    // break the path segment — swap them back before decoding. atob is the
    // runtime's decoder (Buffer isn't available in the edge HTTP context).
    let body: string;
    try {
      const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      body = atob(b64);
    } catch {
      return new Response("Bad base64", { status: 400 });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Never cached: every QA run's payload is unique, and a stale
        // response would make the routing checks read an old fixture.
        "Cache-Control": "no-store",
      },
    });
  }),
});

// Serve the PureWire frontend (dist) from https://outgoing-seal-727.convex.site.
// The staticHosting component is mounted in convex.config.ts; dist is uploaded
// by `npm run upload:version`. Vercel remains the primary host, and the
// UpdateBanner uses the same component's deployment query for live-reload.
registerStaticRoutes(http, components.staticHosting);

export default http;
