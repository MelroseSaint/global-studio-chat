/**
 * Host-aware robots.txt — keeps every non-canonical host out of search.
 *
 * The Convex static mirror (outgoing-seal-727.convex.site) serves the same
 * built frontend as the production host, so its public/robots.txt used to
 * say "Allow: /" and Google indexed the mirror instead of the canonical
 * domain. This route (registered before the static catch-all in http.ts)
 * answers /robots.txt on the Convex site directly: the canonical host keeps
 * the normal allow + sitemap, every other host (the mirror, preview
 * deploys) gets a full disallow so search engines rank purewire.vercel.app
 * — never a duplicate surface.
 *
 * The Vercel production host is unaffected: vercel.json serves
 * public/robots.txt from its filesystem, so this route only ever answers
 * requests that reach the Convex site directly.
 */
import { httpAction } from "./_generated/server";

import { isCanonicalHost, SITE_URL } from "./og";

export const robotsTxt = httpAction(async (_ctx, request) => {
  if (isCanonicalHost(request)) {
    return new Response(
      `# Host is hardcoded — keep in sync with SITE_URL_DEFAULT in\n# vite.config.ts (and public/robots.txt) when the canonical domain changes.\nUser-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
      {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }
  return new Response("User-agent: *\nDisallow: /\n", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});
