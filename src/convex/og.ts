/**
 * Server-rendered Open Graph page for a single post.
 *
 * Link previews (Discord, X/Twitter, WhatsApp, iMessage, Slack, LinkedIn…)
 * fetch the raw HTML of a shared URL before any JavaScript runs. The SPA's
 * index.html only carries site-wide tags, so every shared post used to
 * preview as the generic PureWire card. This route renders the REAL post
 * server-side at /og/post/:id — the author's handle in the title, the post
 * body in the description, and the post's first photo as the image — and
 * the Vercel middleware (middleware.ts) serves it to crawler user-agents
 * hitting /post/:id while real browsers keep getting the app.
 *
 * Visibility matches the app exactly: the route runs the same `getPost`
 * query the post page uses, so removed posts, posts by banned/blocked
 * authors, AI-review-pending posts, and silently shadowbanned content all
 * return a plain 404 — nothing about a silenced account leaks into a link
 * preview.
 *
 * The canonical URL is passed by the middleware as `?u=` (the real
 * purewire.vercel.app/post/:id the crawler asked for); when absent the
 * route falls back to the configured site URL so the tags still point at
 * the right place.
 */
import { httpAction } from "./_generated/server";

import { api } from "./_generated/api";

/** Production frontend origin, overridable via the Convex env var. */
const SITE_URL = (process.env.VITE_SITE_URL ?? "https://purewire.vercel.app").replace(
  /\/$/,
  "",
);

/** Escape a string for use inside an HTML attribute. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Collapse whitespace and cap a post body for og:description. */
function excerpt(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

const SITE_DESCRIPTION =
  "A social platform built around expression, connection, and freedom — not advertising or corporate sponsorships. Every post verified original, no algorithms, no ads.";

/** A minimal 404 page: brand tags only, never any content of the hidden post. */
function notFoundHtml(canonical: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>PureWire — Say it anyway.</title>
<meta property="og:site_name" content="PureWire" />
<meta property="og:type" content="website" />
<meta property="og:title" content="PureWire — Say it anyway." />
<meta property="og:description" content="${esc(SITE_DESCRIPTION)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="PureWire — Say it anyway." />
<meta http-equiv="refresh" content="0;url=${esc(canonical)}" />
</head>
<body style="margin:0;background:#171918;color:#f4f0e8;font-family:system-ui,sans-serif">
  <main style="max-width:560px;margin:0 auto;padding:48px 20px">
    <p style="font-size:15px;line-height:1.6">This post isn't available. It may have been removed, or the account behind it may no longer be public.</p>
    <p><a href="${esc(canonical)}" style="color:#b84a32;font-weight:600">Open PureWire</a></p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=300",
    },
  });
}

export const postOg = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const id = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const canonical =
    url.searchParams.get("u") ?? `${SITE_URL}/post/${encodeURIComponent(id)}`;
  if (id.length === 0) {
    return notFoundHtml(canonical);
  }

  // Same query the post page uses — visibility rules (banned, blocked,
  // silenced, shadowbanned, AI-review) all apply, and the author + resolved
  // media URLs come back ready to render.
  let post: {
    content: string;
    author: { name?: string | null; username?: string | null } | null;
    mediaUrls?: { kind: string; url: string | null }[] | null;
  } | null = null;
  try {
    post = await ctx.runQuery(api.posts.getPost, {
      postId: id as never,
    });
  } catch {
    post = null;
  }
  if (post === null) {
    return notFoundHtml(canonical);
  }

  const username = post.author?.username ?? null;
  const displayName = post.author?.name ?? username;
  const title = username
    ? `@${username} on PureWire`
    : displayName
      ? `${displayName} on PureWire`
      : "Post on PureWire";
  const description =
    post.content.trim().length > 0
      ? excerpt(post.content)
      : "Shared something on PureWire.";
  // Prefer the post's first photo; otherwise fall back to the brand card.
  const image =
    post.mediaUrls?.find((m) => m.kind === "image" && m.url)?.url ??
    `${SITE_URL}/og-image.png`;
  const imageIsBrand = image === `${SITE_URL}/og-image.png`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="${esc(canonical)}" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta property="og:site_name" content="PureWire" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${esc(image)}" />
${imageIsBrand ? `<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />` : ""}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${esc(image)}" />
<meta http-equiv="refresh" content="0;url=${esc(canonical)}" />
</head>
<body style="margin:0;background:#171918;color:#f4f0e8;font-family:system-ui,sans-serif">
  <main style="max-width:560px;margin:0 auto;padding:48px 20px">
    <p style="font-size:14px;color:#c97952;font-weight:600">PureWire</p>
    <h1 style="font-size:22px;margin:8px 0 4px">${esc(title)}</h1>
    <p style="font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(description)}</p>
    <p style="margin-top:20px"><a href="${esc(canonical)}" style="color:#b84a32;font-weight:600">View the post on PureWire</a></p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
});
