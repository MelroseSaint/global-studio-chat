/**
 * Server-rendered Open Graph pages for a single post (/og/post/:id) and a
 * single profile (/og/profile/:handle).
 *
 * Link previews (Discord, X/Twitter, WhatsApp, iMessage, Slack, LinkedIn…)
 * fetch the raw HTML of a shared URL before any JavaScript runs. The SPA's
 * index.html only carries site-wide tags, so every shared URL used to
 * preview as the generic PureWire card. These routes render the REAL
 * content server-side — the author's handle in the title, the post body or
 * bio in the description, the post's first photo or the profile avatar as
 * the image, plus page-level JSON-LD (Article / ProfilePage) — and the
 * Vercel middleware (middleware.ts) serves them to crawler user-agents
 * hitting /post/:id and /u/:handle while real browsers keep getting the app.
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

/**
 * Production frontend origin — repo-owned default, kept in sync with the
 * siteUrl() plugin in vite.config.ts. Override via the Convex env var
 * PUREWIRE_SITE_URL when a custom domain lands. The old VITE_SITE_URL name
 * is deliberately NOT read: a stale value there is exactly what shipped the
 * Convex static-hosting host in share tags.
 *
 * Exported so the dynamic sitemap (sitemap.ts) shares the single source
 * of truth instead of re-declaring it.
 */
export const SITE_URL = (process.env.PUREWIRE_SITE_URL ?? "https://purewire.vercel.app").replace(
  /\/$/,
  "",
);

/**
 * True when the request arrived on the canonical production host rather
 * than the Convex static mirror (outgoing-seal-727.convex.site) or a
 * preview deployment. Shared with the host-aware robots.txt route
 * (robots.ts) so both surfaces agree on which host search engines may
 * index.
 */
export function isCanonicalHost(request: Request): boolean {
  return new URL(request.url).host === new URL(SITE_URL).host;
}

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

/**
 * Serialize JSON-LD safely inside a <script> tag: escape every "<" so user
 * content (post bodies, bios) can never break out of the tag.
 */
function jsonLd(data: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(
    /</g,
    "\\u003c",
  )}</script>`;
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
    _creationTime: number;
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
  const bodyText =
    post.content.trim().length > 0
      ? post.content
      : "Shared something on PureWire.";
  const description = excerpt(bodyText);
  // Google truncates search snippets around 155-160 chars; the social tags
  // (Discord etc.) tolerate ~200. Keep the meta description inside the
  // snippet window while og:description / twitter:description keep the
  // fuller 180-char version. The visible <p> below renders the FULL body
  // so a crawler (and the content-quality linters that read the page)
  // sees the actual article, never a truncated teaser.
  const metaDescription = excerpt(description, 155);
  // Prefer the post's first photo; otherwise fall back to the brand card.
  const image =
    post.mediaUrls?.find((m) => m.kind === "image" && m.url)?.url ??
    `${SITE_URL}/og-image.png`;
  const imageIsBrand = image === `${SITE_URL}/og-image.png`;
  // The middleware forwards the real URL as ?u=; a page fetched that way
  // (or directly on the canonical host) is the canonical page and stays
  // index,follow. A direct hit on the Convex mirror without ?u= is a
  // duplicate surface — noindex so Google never ranks the mirror over
  // purewire.vercel.app.
  const robotsMeta =
    url.searchParams.get("u") !== null || isCanonicalHost(request)
      ? "index, follow"
      : "noindex, nofollow";
  const authorName = post.author?.name ?? post.author?.username ?? null;
  const articleLd = jsonLd({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    url: canonical,
    datePublished: new Date(post._creationTime).toISOString(),
    ...(imageIsBrand ? {} : { image: [image] }),
    author: {
      "@type": "Person",
      name: authorName ?? "PureWire",
      ...(post.author?.username
        ? { url: `${SITE_URL}/u/${encodeURIComponent(post.author.username)}` }
        : {}),
    },
  });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${robotsMeta}" />
<link rel="canonical" href="${esc(canonical)}" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDescription)}" />
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
${articleLd}
<meta http-equiv="refresh" content="0;url=${esc(canonical)}" />
</head>
<body style="margin:0;background:#171918;color:#f4f0e8;font-family:system-ui,sans-serif">
  <main style="max-width:560px;margin:0 auto;padding:48px 20px">
    <h1 style="font-size:22px;margin:8px 0 4px">${esc(title)}</h1>
    <p style="font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(bodyText)}</p>
    <p style="margin-top:20px"><a href="${esc(canonical)}" style="color:#b84a32;font-weight:600">View the post</a></p>
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

/**
 * Server-rendered ProfilePage for /og/profile/:handle — served by the Vercel
 * middleware to crawlers hitting /u/:handle. Same visibility discipline as
 * postOg: getProfile applies the shadowban gate (a silenced account's profile
 * 404s for everyone but itself and admins), so nothing leaks into a preview.
 */
/**
 * Server-rendered HTML for the public static pages (currently /about) — the
 * fee/feature disclosure. These pages are pure static content, so rendering
 * them server-side means a crawler (Googlebot, or the healthcheck that
 * mirrors it) sees the actual disclosure text in the HTML instead of a
 * blank SPA shell. The Vercel middleware serves this for crawler
 * user-agents hitting /about; real browsers keep getting the app.
 */
function aboutPageHtml(canonical: string, robotsMeta: string): string {
  const title = "About PureWire — no fees, no ads, no algorithm";
  const description =
    "Everything about PureWire, plainly stated: it's free with no hidden fees, the five feeds you control, every feature, the rules, and what happens to your data.";
  const metaDescription = excerpt(description, 155);
  const pageLd = jsonLd({
    "@context": "https://schema.org",
    "@type": "AboutPage",
    name: "About PureWire",
    description,
    url: canonical,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${robotsMeta}" />
<link rel="canonical" href="${esc(canonical)}" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDescription)}" />
<meta property="og:site_name" content="PureWire" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${esc(`${SITE_URL}/og-image.png`)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${esc(`${SITE_URL}/og-image.png`)}" />
${pageLd}
</head>
<body style="margin:0;background:#171918;color:#f4f0e8;font-family:system-ui,sans-serif">
  <main style="max-width:620px;margin:0 auto;padding:48px 20px">
    <h1 style="font-size:26px;margin:0 0 8px">Everything about PureWire, plainly stated.</h1>
    <p style="font-size:15px;line-height:1.7;color:#c9c4ba">
      This page is the whole picture before you join: what PureWire costs,
      the feeds you get, everything you can do, the rules, and what happens
      to your data. Nothing here is hidden behind an account.
    </p>
    <h2 style="font-size:18px;margin:28px 0 8px">What it costs</h2>
    <p style="font-size:15px;line-height:1.7;color:#c9c4ba">
      PureWire is free to join and free to use — no subscription, no
      paywall, no premium tier, and no hidden fees anywhere. There are no
      ads, no sponsorships, and no promoted posts: posting, uploading
      photos, videos, and audio, sending end-to-end encrypted messages, and
      downloading your data are all free for every member.
    </p>
    <h2 style="font-size:18px;margin:28px 0 8px">Your feeds — five ways to see, zero algorithms</h2>
    <ul style="font-size:15px;line-height:1.7;color:#c9c4ba;padding-left:20px">
      <li>Global — everything on PureWire, in time order.</li>
      <li>Following — posts from the people you follow.</li>
      <li>Latest — the newest posts first.</li>
      <li>Local — posts shared near you (live position, never stored).</li>
      <li>Photos &amp; videos — a media-only view.</li>
    </ul>
    <h2 style="font-size:18px;margin:28px 0 8px">Everything you can do</h2>
    <p style="font-size:15px;line-height:1.7;color:#c9c4ba">
      Posts with photos, video, and audio; stories that vanish after 24
      hours; comments, replies, and likes; sharing any post into a direct
      message or a comment as a preview card; end-to-end encrypted DMs;
      notifications; verified badges; blocking and one-tap reporting.
    </p>
    <h2 style="font-size:18px;margin:28px 0 8px">Your data &amp; account</h2>
    <p style="font-size:15px;line-height:1.7;color:#c9c4ba">
      Download a ZIP of everything you've created — posts as readable text
      plus your uploaded media — and delete your account (and all of it)
      with one action. PureWire stores no tracking data and never sells
      your attention.
    </p>
    <p style="margin-top:28px"><a href="${esc(canonical)}" style="color:#b84a32;font-weight:600">Open PureWire</a></p>
  </main>
</body>
</html>`;
}

/**
 * Server-rendered static page (/og/about) — served by the Vercel middleware
 * to crawlers hitting /about. Same robots discipline as the post/profile
 * routes: ?u= (or a direct canonical-host hit) stays index,follow; a bare
 * hit on the Convex mirror is noindex so it never competes with the
 * canonical host.
 */
export const pageOg = httpAction(async (_ctx, request) => {
  const url = new URL(request.url);
  const page = url.pathname.split("/").filter(Boolean).pop() ?? "about";
  const canonical = url.searchParams.get("u") ?? `${SITE_URL}/${page}`;
  const robotsMeta =
    url.searchParams.get("u") !== null || isCanonicalHost(request)
      ? "index, follow"
      : "noindex, nofollow";
  return new Response(aboutPageHtml(canonical, robotsMeta), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
});

export const profileOg = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const handle = decodeURIComponent(
    url.pathname.split("/").filter(Boolean).pop() ?? "",
  );
  const canonical =
    url.searchParams.get("u") ?? `${SITE_URL}/u/${encodeURIComponent(handle)}`;
  if (handle.length === 0) {
    return notFoundHtml(canonical);
  }

  let profile: {
    name?: string | null;
    username?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
    _creationTime: number;
  } | null = null;
  try {
    profile = await ctx.runQuery(api.users.getProfile, { username: handle });
  } catch {
    profile = null;
  }
  if (profile === null) {
    return notFoundHtml(canonical);
  }

  const displayName = profile.name ?? profile.username ?? handle;
  const title = profile.username
    ? `@${profile.username} on PureWire`
    : `${displayName} on PureWire`;
  const bodyText =
    profile.bio && profile.bio.trim().length > 0
      ? profile.bio
      : `Check out @${profile.username ?? displayName} on PureWire.`;
  const description = excerpt(bodyText);
  // Google truncates search snippets around 155-160 chars; the social tags
  // tolerate ~200. Keep the meta description inside the snippet window.
  const metaDescription = excerpt(description, 155);
  // Prefer the profile avatar; otherwise fall back to the brand card.
  const image = profile.avatarUrl ?? `${SITE_URL}/og-image.png`;
  const imageIsBrand = image === `${SITE_URL}/og-image.png`;
  // Same canonical-page rule as postOg: ?u= (or a direct canonical-host
  // hit) stays index,follow; a bare hit on the Convex mirror is noindex.
  const robotsMeta =
    url.searchParams.get("u") !== null || isCanonicalHost(request)
      ? "index, follow"
      : "noindex, nofollow";

  const profileLd = jsonLd({
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    name: displayName,
    description,
    url: canonical,
    dateCreated: new Date(profile._creationTime).toISOString(),
    mainEntity: {
      "@type": "Person",
      name: displayName,
      url: canonical,
      ...(profile.avatarUrl ? { image: profile.avatarUrl } : {}),
    },
  });

  // The <h1> is the person's NAME, not a duplicate of the <title> tag
  // (which already carries "@handle on PureWire" for share cards). A
  // heading that repeats the title verbatim doubles every "handle on
  // PureWire" bigram in the page's text and inflates the repetition
  // signal for crawlers that dump visible text.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${robotsMeta}" />
<link rel="canonical" href="${esc(canonical)}" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDescription)}" />
<meta property="og:site_name" content="PureWire" />
<meta property="og:type" content="profile" />
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
${profileLd}
<meta http-equiv="refresh" content="0;url=${esc(canonical)}" />
</head>
<body style="margin:0;background:#171918;color:#f4f0e8;font-family:system-ui,sans-serif">
  <main style="max-width:560px;margin:0 auto;padding:48px 20px">
    <h1 style="font-size:22px;margin:8px 0 4px">${esc(displayName)}</h1>
    <p style="font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(bodyText)}</p>
    <p style="margin-top:20px"><a href="${esc(canonical)}" style="color:#b84a32;font-weight:600">View profile</a></p>
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
