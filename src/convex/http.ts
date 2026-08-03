import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";

import { auth } from "@/convex/auth";
import { postOg } from "./og";
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

// Serve the PureWire frontend (dist) from https://outgoing-seal-727.convex.site.
// The staticHosting component is mounted in convex.config.ts; dist is uploaded
// by `npm run upload:version`. Vercel remains the primary host, and the
// UpdateBanner uses the same component's deployment query for live-reload.
registerStaticRoutes(http, components.staticHosting);

export default http;
