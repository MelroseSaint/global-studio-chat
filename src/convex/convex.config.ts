import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// The frontend is served by Vercel. The staticHosting component is mounted
// only to expose the deployment-version query that powers the UpdateBanner
// live-reload prompt (see convex/staticHosting.ts). Static file serving is
// handled by Vercel, so no static routes are registered in http.ts.
const app = defineApp();
app.use(staticHosting);

export default app;
