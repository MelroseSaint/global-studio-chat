/**
 * Mirror /admin → canonical host redirect.
 *
 * The Convex static mirror (outgoing-seal-727.convex.site) serves a copy
 * of the built frontend, and that copy used to silently lag the main host
 * (the admin-dropdown incident: /admin there showed the old tab row while
 * purewire.vercel.app had the new UI). The admin dashboard is the surface
 * where a stale copy is worst — it is a live tool, not indexable content —
 * so instead of syncing it like everything else, this route makes a stale
 * admin copy structurally impossible: every /admin request that reaches
 * the Convex site answers 301 to the canonical host, which serves the real
 * app. The static sync keeps the rest of the mirror current, and the
 * mirror-freshness guard (scripts/mirror-freshness-check.mjs) asserts this
 * redirect stays in place.
 *
 * Registered before the static catch-all in http.ts, so the SPA fallback
 * can never shadow it. The Vercel production host is unaffected: it serves
 * /admin itself, so this route only ever answers requests that reach the
 * Convex site directly.
 */
import { httpAction } from "./_generated/server";

import { isCanonicalHost, SITE_URL } from "./og";

export const adminRedirect = httpAction(async (_ctx, request) => {
  // The canonical host never reaches this router (Vercel serves the app
  // directly), but if PUREWIRE_SITE_URL were ever misconfigured to a
  // Convex site URL, redirecting would loop — refuse instead.
  if (isCanonicalHost(request)) {
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(request.url);
  // Preserve the path and any query (?section=blocklist deep links, etc.)
  // so a mirror hit lands on the exact same panel on the canonical host.
  const target = `${SITE_URL}${url.pathname}${url.search}`;
  return new Response(null, {
    status: 301,
    headers: {
      Location: target,
      // Never cached: a stale redirect target (e.g. during a domain
      // migration) would pin old traffic to the wrong host.
      "Cache-Control": "no-store",
    },
  });
});
