#!/usr/bin/env node
/**
 * Dynamic rendering guard — production.
 *
 * The Vercel middleware proxies crawler user-agents on /post/:id,
 * /u/:handle, and /about to the Convex OG httpActions (server-rendered
 * Article / ProfilePage / AboutPage pages with JSON-LD), while real
 * browsers get the SPA. This check proves that differentiation still holds
 * for the newest post and profile in the live sitemap, and for the /about
 * transparency page:
 *
 *   - Googlebot UA  → 200, NO SPA shell, expected content present
 *     (posts/profiles: their JSON-LD; /about: the fee-disclosure text
 *     "no hidden fees" — if a Googlebot fetch ever returns the SPA shell,
 *     search engines see a blank app and every OG/JSON-LD investment is
 *     dead, and the transparency page's fee disclosure would silently
 *     disappear from what search engines can read).
 *   - Browser UA    → 200, SPA shell present
 *     (if the middleware ever serves the OG page to browsers, real users
 *     get a non-interactive page and the app is broken).
 *
 * Runs on every push to main + nightly via the production healthcheck.
 * Zero dependencies (Node ≥18 built-in fetch). Override the target with
 * SITE_URL. Exit 0 = differentiation intact, 1 = regression with
 * ::error:: lines.
 */
const SITE = (process.env.SITE_URL ?? "https://purewire.vercel.app").replace(/\/+$/, "");

// Matches the middleware's CRAWLER_UA list, so this request actually hits
// the server-rendered OG path instead of the SPA.
const CRAWLER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
// A plain desktop browser — the opposite side of the middleware's split.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SPA_MARKER = '<div id="root">';

let checks = 0;
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  checks++;
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` (${detail})` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const fetchAs = async (url, ua) => {
  const res = await fetch(url, {
    headers: { "user-agent": ua },
    redirect: "follow",
  });
  return { status: res.status, body: await res.text() };
};

const main = async () => {
  console.log(`\nDynamic rendering guard (Googlebot vs browser) — ${SITE}\n`);

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
  const posts = locs.filter((u) => u.includes("/post/"));
  const profiles = locs.filter((u) => u.includes("/u/"));
  if (posts.length === 0 || profiles.length === 0) {
    console.error(
      "::error::sitemap has no post/profile URLs — cannot verify dynamic rendering",
    );
    process.exitCode = 1;
    return;
  }

  // The fee/feature disclosure text that /about must always carry — the
  // transparency promise (free, no hidden fees) the healthcheck guards.
  const FEE_MARKER = "no hidden fees";
  const targets = [
    { kind: "post", url: posts[0], ld: '"@type":"Article"' },
    { kind: "profile", url: profiles[0], ld: '"@type":"ProfilePage"' },
    { kind: "about", url: `${SITE}/about`, marker: FEE_MARKER },
  ];

  for (const t of targets) {
    // The crawler side — must be server-rendered, never the SPA shell.
    try {
      const bot = await fetchAs(t.url, CRAWLER_UA);
      const botShell = bot.body.includes(SPA_MARKER);
      const contentOk = t.marker
        ? bot.body.includes(t.marker)
        : bot.body.includes(t.ld);
      check(
        `Googlebot ${t.kind} is server-rendered`,
        bot.status === 200 && !botShell && contentOk,
        t.marker
          ? `HTTP ${bot.status}, shell=${botShell}, fee text=${contentOk ? "ok" : "MISSING"}`
          : `HTTP ${bot.status}, shell=${botShell}, JSON-LD=${contentOk ? "ok" : "MISSING"}`,
      );
    } catch (err) {
      check(`Googlebot ${t.kind} is server-rendered`, false, String(err));
      continue;
    }

    // The browser side — must get the SPA, proving the middleware still
    // splits the two instead of serving the OG page (or the shell) to both.
    try {
      const br = await fetchAs(t.url, BROWSER_UA);
      const brShell = br.body.includes(SPA_MARKER);
      check(
        `Browser ${t.kind} gets the SPA (differentiation intact)`,
        br.status === 200 && brShell,
        `HTTP ${br.status}, shell=${brShell}`,
      );
    } catch (err) {
      check(`Browser ${t.kind} gets the SPA (differentiation intact)`, false, String(err));
    }
  }

  console.log(`\n${passed}/${checks} checks passed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error("Dynamic rendering guard crashed:", err);
  process.exitCode = 1;
});
