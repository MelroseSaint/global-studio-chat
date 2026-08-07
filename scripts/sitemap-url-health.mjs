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
 * SITEMAP_SITE_URL and the per-class sample size with SITEMAP_SAMPLE
 * (default 8). Pass --all for a FULL sweep of every post and profile in
 * the sitemap — the deep-audit mode used by `npm run qa:sitemap-urls:all`
 * and the healthcheck's manual dispatch. Exit 0 = healthy, 1 = a failure.
 */
const SITE = (
  process.env.SITEMAP_SITE_URL ?? "https://purewire.vercel.app"
).replace(/\/+$/, "");

// Matches the middleware's CRAWLER_UA list, so the request actually hits
// the server-rendered OG path instead of the SPA.
const CRAWLER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const SPA_MARKER = '<div id="root">';
const FULL_SWEEP = process.argv.includes("--all");
const rawSample = Number(process.env.SITEMAP_SAMPLE ?? 8);
// Newest-first per-class sample size (posts, profiles); SITEMAP_SAMPLE=0
// is ignored, so a garbage value falls back to the default 8.
const SAMPLE_PER_CLASS =
  Number.isFinite(rawSample) && rawSample >= 1 ? Math.floor(rawSample) : 8;
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

// Retry transient failures (network errors, 429, 5xx) with backoff. The
// sitemap job runs in parallel with the Vercel deploy, which briefly serves
// 5xx during rollout — a real regression must fail, but a deploy-window
// blip must not.
const isTransient = (status) => status === 429 || status >= 500;
const fetchWithRetry = async (url, options, attempts = 3) => {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (!isTransient(res.status) || i === attempts - 1) return res;
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
  throw lastErr ?? new Error(`exhausted retries on ${url}`);
};

const main = async () => {
  const mode = FULL_SWEEP
    ? "FULL SWEEP (all posts + profiles)"
    : `sample ${SAMPLE_PER_CLASS}/class`;
  console.log(`\nSitemap URL health — ${SITE} — ${mode}\n`);

  const sitemapRes = await fetchWithRetry(`${SITE}/sitemap.xml`, {
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
  const postSample = FULL_SWEEP ? posts : posts.slice(0, SAMPLE_PER_CLASS);
  const profileSample = FULL_SWEEP ? profiles : profiles.slice(0, SAMPLE_PER_CLASS);
  const sample = [...new Set([...fixed, ...postSample, ...profileSample])];
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
      const res = await fetchWithRetry(url, {
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
