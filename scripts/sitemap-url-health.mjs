#!/usr/bin/env node
/**
 * Sitemap URL health check — production.
 *
 * The dynamic /sitemap.xml only earns its place if the URLs it submits
 * actually render. This script fetches the live sitemap, samples the newest
 * posts (/post/:id) and profiles (/u/:handle) plus all fixed pages, and
 * fetches each with a CRAWLER user-agent — the same path a search engine
 * takes, which is the only one that proves real content:
 *
 *   - posts/profiles must return 200 with the server-rendered OG page
 *     (Article / ProfilePage JSON-LD) — never a 404 and never the SPA
 *     shell, which would mean a visibility regression silently submitted a
 *     dead or unfetchable URL.
 *   - fixed pages are SPA routes, so 200 + the app shell is their real
 *     content.
 *
 * Zero dependencies (Node ≥18 built-in fetch). Override the target with
 * SITEMAP_SITE_URL. Exit 0 = all sampled URLs healthy, 1 = a failure.
 */
const SITE = (
  process.env.SITEMAP_SITE_URL ?? "https://purewire.vercel.app"
).replace(/\/+$/, "");

// Matches the middleware's CRAWLER_UA list, so the request actually hits
// the server-rendered OG path instead of the SPA.
const CRAWLER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const SPA_MARKER = '<div id="root">';
const MAX_PER_CLASS = 8; // newest-first sample from the sitemap
const siteHost = new URL(SITE).hostname;

// The canonical tag as a normalized absolute URL, or null when missing/
// malformed. Trailing slashes are stripped so a canonical that matches the
// sitemap URL modulo a trailing slash does not false-fail.
const canonicalOf = (body) => {
  const m = body.match(/<link rel="canonical" href="([^"]+)"/i);
  if (!m) return null;
  try {
    return new URL(m[1].replace(/&amp;/g, "&")).href.replace(/\/$/, "");
  } catch {
    return null;
  }
};

let checks = 0;
let passed = 0;
const check = (name, ok, extra = "") => {
  checks++;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const main = async () => {
  console.log(`\nSitemap URL health — ${SITE}\n`);

  const sitemapRes = await fetch(`${SITE}/sitemap.xml`, {
    headers: { "user-agent": CRAWLER_UA },
  });
  if (!sitemapRes.ok) {
    console.error(`::error::sitemap fetch failed: HTTP ${sitemapRes.status}`);
    process.exitCode = 1;
    return;
  }
  const xml = await sitemapRes.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check("sitemap fetched with URLs", locs.length > 0, `${locs.length} URLs`);

  const fixed = locs.filter((u) => !/\/post\/|\/u\//.test(u));
  const posts = locs.filter((u) => u.includes("/post/"));
  const profiles = locs.filter((u) => u.includes("/u/"));
  const sample = [
    ...new Set([...fixed, ...posts.slice(0, MAX_PER_CLASS), ...profiles.slice(0, MAX_PER_CLASS)]),
  ];
  if (posts.length + profiles.length === 0) {
    console.log("No posts/profiles in the sitemap — nothing dynamic to verify.");
  }

  for (const url of sample) {
    const isPost = url.includes("/post/");
    const isProfile = url.includes("/u/");
    const expectedLd = isPost
      ? '"@type":"Article"'
      : isProfile
        ? '"@type":"ProfilePage"'
        : null;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": CRAWLER_UA },
        redirect: "follow",
      });
      const body = await res.text();
      const isShell = body.includes(SPA_MARKER);
      const canonical = canonicalOf(body);
      // No redirect drift: the fetch must land on the exact sitemap URL
      // (a 301/308 hop to a trailing-slash or host variant is drift).
      const noRedirect = res.url === url;
      if (expectedLd === null) {
        // Fixed page: SPA route, the app shell IS its real content, and the
        // canonical is the site root by design (per-page canonicals are
        // applied client-side). So assert the canonical HOST cannot drift —
        // e.g. to the Convex mirror or a stale dashboard host.
        const canonicalOk =
          canonical !== null && new URL(canonical).hostname === siteHost;
        check(
          url,
          res.status === 200 && isShell && noRedirect && canonicalOk,
          `status ${res.status}, shell=${isShell}, canonical=${canonical ?? "MISSING"}`,
        );
      } else {
        const ldOk = body.includes(expectedLd);
        // Canonicalization guard: the canonical tag must EXACTLY equal the
        // sitemap URL — no host, path, trailing-slash, or redirect drift —
        // so a regression surfaces instead of silently self-canonicalizing
        // to a different URL and wasting crawl equity.
        const canonicalOk = canonical === url;
        check(
          url,
          res.status === 200 && !isShell && ldOk && noRedirect && canonicalOk,
          `status ${res.status}, shell=${isShell}, JSON-LD=${ldOk ? "ok" : "MISSING"}, ` +
            `canonical=${canonicalOk ? "MATCH" : `${canonical ?? "MISSING"} != ${url}`}`,
        );
      }
    } catch (err) {
      check(url, false, String(err));
    }
  }

  console.log(`\n${passed}/${checks} checks passed`);
  if (passed !== checks) process.exitCode = 1;
};

main().catch((err) => {
  console.error("Sitemap URL health crashed:", err);
  process.exitCode = 1;
});
