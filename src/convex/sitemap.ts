/**
 * Dynamic sitemap.xml — replaces the old static six-page file so user
 * content becomes indexable.
 *
 * Served at /sitemap.xml by the Vercel middleware (middleware.ts proxies
 * the path here for every user-agent, like the OG pages do for crawlers).
 * The URL set is: the fixed public pages (PUBLIC_ROUTES in src/lib/routes.ts,
 * shared with the router — add a public page there and it appears here
 * automatically), plus the newest public posts (/post/:id) and public
 * profiles (/u/:handle) — the exact URLs whose server-rendered OG pages
 * carry index,follow + a real-host canonical.
 *
 * Visibility mirrors the app for an anonymous crawler: posts pending AI
 * review and shadowbanned profiles are excluded (their pages 404 via
 * getPost/getProfile, so submitting them would waste crawl budget).
 *
 * The output is CDN-cached (s-maxage 3600) and refreshes on a schedule via
 * the cache revalidation, so it never recomputes per request.
 */
import { httpAction } from "./_generated/server";

import { internal } from "./_generated/api";
import { PUBLIC_ROUTES } from "@/lib/routes";
import { SITE_URL } from "./og";

function urlTag(loc: string, lastmod?: number): string {
  const lastmodTag =
    lastmod !== undefined
      ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>`
      : "";
  return `  <url>\n    <loc>${loc}</loc>${lastmodTag}\n  </url>`;
}

export const sitemapXml = httpAction(async (ctx) => {
  const [posts, users] = await Promise.all([
    ctx.runQuery(internal.posts.listPublicPostsForSitemap),
    ctx.runQuery(internal.users.listPublicUsersForSitemap),
  ]);

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...PUBLIC_ROUTES.map((p) => urlTag(`${SITE_URL}${p}`)),
    ...posts.map((p) => urlTag(`${SITE_URL}/post/${p.id}`, p.lastmod)),
    ...users.map((u) =>
      urlTag(`${SITE_URL}/u/${encodeURIComponent(u.username)}`, u.lastmod),
    ),
    "</urlset>",
  ].join("\n");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // CDN-cached for an hour; browsers revalidate after 5 minutes.
      // Sitemaps are fetched at most daily by search engines, so the
      // refresh cost is negligible.
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
});
