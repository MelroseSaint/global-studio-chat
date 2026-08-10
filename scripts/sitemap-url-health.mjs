#!/usr/bin/env node
/**
 * Sitemap URL health check — production.
 *
 * The dynamic /sitemap.xml only earns its place if the URLs it submits
 * actually render. This script fetches the live sitemap, samples the newest
 * posts (/post/:id) and profiles (/u/:handle) plus all fixed pages, and
 * fetches each with a CRAWLER user-agent — the same path a search engine
 * takes, which is the only one that proves real content. It also guards the
 * sitemap at the source: every <loc> (on the main host AND the Convex
 * static mirror) must carry the expected canonical host — a wrong-host
 * sitemap fails before any URL is even sampled.
 *
 *   - posts/profiles must return 200 with the server-rendered OG page
 *     (Article / ProfilePage JSON-LD) — never a 404 and never the SPA
 *     shell, which would mean a visibility regression silently submitted a
 *     dead or unfetchable URL. Both link surfaces must point at the exact
 *     sitemap URL: the <link rel=canonical> AND the og:url meta tag.
 *   - /about is server-rendered for crawlers like the dynamic pages (the
 *     fee/feature disclosure must be present in the HTML, never the shell),
 *     so it gets the same canonical + og:url strictness.
 *   - other fixed pages are SPA routes, so 200 + the app shell is their
 *     real content.
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

// The canonical host every sitemap <loc> must carry — the repo-owned
// production host (vite.config.ts SITE_URL_DEFAULT / PUREWIRE_SITE_URL),
// the same one the healthcheck's SEO-basics guard asserts. The dynamic
// sitemap is also served by the Convex static mirror and by previews, but
// its URLs must ALWAYS point here: a wrong-host loc is cross-host duplicate
// content, caught at the source instead of being submitted to search
// engines. Override only for deliberate tests.
const EXPECTED_HOST = (
  process.env.EXPECTED_SITEMAP_HOST ?? "https://purewire.vercel.app"
).replace(/\/+$/, "");
// Origin (scheme + host), not hostname alone: an http:// loc on the same
// host is still wrong — the site canonicalizes to https — and the script's
// canonical/og:url checks are full-URL strict, so this matches that bar.
const expectedOrigin = new URL(EXPECTED_HOST).origin;

// The Convex static-hosting mirror serves the same dynamic sitemap (the
// http.ts /sitemap.xml action), so its locs must be guarded too.
const MIRROR = (
  process.env.SITEMAP_MIRROR_URL ?? "https://outgoing-seal-727.convex.site"
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

// Locs that do NOT carry the expected canonical origin (scheme + host), or
// that fail to parse as URLs at all — the wrong-host sitemap signal.
const locsOffHost = (locs) =>
  locs.filter((u) => {
    try {
      return new URL(u).origin !== expectedOrigin;
    } catch {
      return true;
    }
  });

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

// The og:url tag, normalized exactly like the canonical — the other link
// surface on the same server-rendered OG page. Null when missing/malformed.
const ogUrlOf = (body) => {
  const m = body.match(/<meta property="og:url" content="([^"]+)"/i);
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

  // Wrong-host guard on the primary sitemap: every submitted URL must be on
  // the canonical origin — no mirror host, no preview host, no stale var, no
  // downgraded scheme. Requires at least one loc so an empty urlset cannot
  // pass vacuously.
  const badLocs = locsOffHost(locs);
  check(
    "all sitemap locs carry the canonical host",
    locs.length > 0 && badLocs.length === 0,
    badLocs.length > 0
      ? `${badLocs.slice(0, 3).join(", ")}${badLocs.length > 3 ? ` +${badLocs.length - 3} more` : ""}`
      : `${locs.length} locs on ${EXPECTED_HOST}`,
  );

  // The Convex static mirror serves the same sitemap — assert it fetches AND
  // that its locs carry the canonical host, catching a wrong-host sitemap at
  // the source rather than only on the main host.
  const mirrorRes = await fetchWithRetry(`${MIRROR}/sitemap.xml`, {
    headers: { "user-agent": CRAWLER_UA },
  });
  const mirrorOk = mirrorRes.ok;
  const mirrorXml = mirrorOk ? await mirrorRes.text() : "";
  const mirrorLocs = [...mirrorXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const badMirrorLocs = locsOffHost(mirrorLocs);
  check("mirror serves the sitemap", mirrorOk, `HTTP ${mirrorRes.status}`);
  check(
    "mirror sitemap locs carry the canonical host",
    mirrorOk && mirrorLocs.length > 0 && badMirrorLocs.length === 0,
    !mirrorOk
      ? `HTTP ${mirrorRes.status}`
      : mirrorLocs.length === 0
        ? "no locs parsed"
        : `${badMirrorLocs.slice(0, 3).join(", ")}${badMirrorLocs.length > 3 ? ` +${badMirrorLocs.length - 3} more` : ""}`,
  );

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
    // /about is server-rendered for crawlers (fee/feature disclosure), so
    // it is verified like the dynamic pages, not like an SPA fixed page.
    const isAbout = url.includes("/about");
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
      if (expectedLd === null && !isAbout) {
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
        // The content signal for this URL class: JSON-LD on posts/profiles,
        // the fee/feature disclosure text on /about.
        const contentOk = isAbout
          ? body.includes("no hidden fees")
          : body.includes(expectedLd);
        // Canonicalization guard: the canonical tag must EXACTLY equal the
        // sitemap URL — no host, path, trailing-slash, or redirect drift —
        // so a regression surfaces instead of silently self-canonicalizing
        // to a different URL and wasting crawl equity.
        const canonicalOk = canonical === url;
        // og:url guard, mirroring the canonical on the other link surface:
        // the share/open-graph URL must point at the exact sitemap URL too,
        // so social unfurlers and the crawler agree on which page this is.
        const ogUrl = ogUrlOf(body);
        const ogUrlOk = ogUrl === url;
        check(
          url,
          res.status === 200 && !isShell && contentOk && noRedirect && canonicalOk && ogUrlOk,
          `status ${res.status}, shell=${isShell}, content=${contentOk ? "ok" : "MISSING"}, ` +
            `canonical=${canonicalOk ? "MATCH" : `${canonical ?? "MISSING"} != ${url}`}, ` +
            `og:url=${ogUrlOk ? "MATCH" : `${ogUrl ?? "MISSING"} != ${url}`}`,
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
