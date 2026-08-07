/**
 * PureWire link-preview middleware (Vercel Edge).
 *
 * When a post or profile is shared, the URL is /post/:id or /u/:handle.
 * Link previews are rendered by crawlers (Discord, X/Twitter, WhatsApp,
 * iMessage, Slack, LinkedIn…) that fetch the raw HTML WITHOUT running the
 * app's JavaScript — so the SPA shell's generic site tags used to make
 * every shared URL preview as the generic PureWire card.
 *
 * This middleware watches those two route shapes and, ONLY for known
 * crawler user-agents, serves the server-rendered OG page from the Convex
 * backend (https://outgoing-seal-727.convex.site/og/post/:id or
 * /og/profile/:handle) — real content: author handle in the title, post
 * body or bio in the description, first photo or avatar as the image, plus
 * Article/ProfilePage JSON-LD. Every other request returns `undefined` so
 * Vercel passes it through to the app untouched.
 *
 * The canonical URL is forwarded as `?u=` so the OG page's og:url points at
 * the purewire.vercel.app address the crawler asked for, never the backend.
 *
 * Edge-runtime constraint: only web-standard Request/Response APIs are
 * used — no `next/server` import, which the Vite project's Edge build
 * cannot resolve.
 */

/** The Convex site that hosts the backend + static frontend. */
const CONVEX_SITE = "https://outgoing-seal-727.convex.site";

/** Crawler user-agent fragments — every major link-preview fetcher. */
const CRAWLER_UA =
  /(discordbot|twitterbot|facebookexternalhit|whatsapp|telegrambot|slackbot|linkedinbot|applebot|googlebot|bingbot|duckduckbot|yandex|baiduspider|skypeuripreview|pinterest|redditbot|snapchat|viber|line|tumblr|quora|embedly|linkding|mastodon|instagram|imessage)/i;

export default async function middleware(
  request: Request,
): Promise<Response | undefined> {
  const { pathname, origin } = new URL(request.url);
  const postMatch = pathname.match(/^\/post\/([^/]+)\/?$/);
  const profileMatch = pathname.match(/^\/u\/([^/]+)\/?$/);
  if ((!postMatch && !profileMatch) || request.method !== "GET") {
    // Not a GET on /post/:id or /u/:handle — let the app serve it normally.
    return undefined;
  }
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!CRAWLER_UA.test(userAgent)) {
    // Real browser — hand the request to the SPA.
    return undefined;
  }
  const canonical = `${origin}${pathname}`;
  const backendPath = postMatch
    ? `/og/post/${encodeURIComponent(postMatch[1])}`
    : `/og/profile/${encodeURIComponent(profileMatch![1])}`;
  try {
    const res = await fetch(
      `${CONVEX_SITE}${backendPath}?u=${encodeURIComponent(canonical)}`,
      { headers: { "user-agent": userAgent } },
    );
    if (res.ok) {
      const html = await res.text();
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300, s-maxage=3600",
        },
      });
    }
  } catch {
    // Backend hiccup — fall through to the SPA rather than failing the fetch.
  }
  return undefined;
}

export const config = {
  matcher: ["/post/:path*", "/u/:path*"],
};
