import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// PureWire is hosted on Convex static hosting at
// https://outgoing-seal-727.convex.site (Vercel is the primary host).
// The component owns the root and serves the dist build uploaded by
// `npm run upload:version`; the app's own routes (auth) are registered in
// src/convex/http.ts via registerStaticRoutes, which is why the component is
// mounted here WITHOUT an httpPrefix — the app keeps its root-level routes
// and the static site is served from the component.
const app = defineApp();
app.use(staticHosting);

export default app;
