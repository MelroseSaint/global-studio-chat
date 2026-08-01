import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";

import { auth } from "@/convex/auth";
import { components } from "./_generated/api";

const http = httpRouter();

// Auth OIDC discovery, token exchange and callback routes.
auth.addHttpRoutes(http);

// Serve the PureWire frontend (dist) from https://outgoing-seal-727.convex.site.
// The staticHosting component is mounted in convex.config.ts; dist is uploaded
// by `npm run upload:version`. Vercel remains the primary host, and the
// UpdateBanner uses the same component's deployment query for live-reload.
registerStaticRoutes(http, components.staticHosting);

export default http;
