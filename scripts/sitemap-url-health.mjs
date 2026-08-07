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
      if (expectedLd === null) {
        // Fixed page: SPA route, the app shell IS its real content.
        check(
          url,
          res.status === 200 && isShell,
          `status ${res.status}, shell=${isShell}`,
        );
      } else {
        const ldOk = body.includes(expectedLd);
        check(
          url,
          res.status === 200 && !isShell && ldOk,
          `status ${res.status}, shell=${isShell}, JSON-LD=${ldOk ? "ok" : "MISSING"}`,
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
