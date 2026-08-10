#!/usr/bin/env node
/**
 * Live robots.txt guard — production.
 *
 * The search-visibility contract depends on two hosts staying exactly
 * right, and a broken robots.txt is silent: nothing errors for users, only
 * Google notices, weeks later. This guard asserts the LIVE state of both
 * hosts on every push and nightly:
 *
 *   - MAIN host (purewire.vercel.app): robots.txt must still carry the
 *     exact Sitemap line pointing at the canonical host
 *     (https://purewire.vercel.app/sitemap.xml) — a missing, wrong-host,
 *     or downgraded Sitemap line means the sitemap silently stops being
 *     submitted.
 *   - MIRROR host (outgoing-seal-727.convex.site): robots.txt must still
 *     `Disallow: /` everything — if the host-aware robots route ever stops
 *     disallowing (or a static Allow leaks back in), Google can crawl and
 *     index the mirror again and rank it over the canonical host, exactly
 *     the regression that originally shipped the mirror's URLs into
 *     search.
 *
 * Zero dependencies (Node ≥18 built-in fetch), with the same transient
 * retry the other live-site scripts use — a deploy-window 5xx must not
 * false-fail, a real regression must.
 *
 * Overrides: ROBOTS_SITE_URL (main host, default https://purewire.vercel.app),
 * ROBOTS_MIRROR_URL (default https://outgoing-seal-727.convex.site),
 * EXPECTED_SITEMAP_HOST (the canonical host the Sitemap line must carry,
 * default = ROBOTS_SITE_URL). Exit 0 = healthy, 1 = regression with
 * ::error:: lines.
 */
const SITE = (process.env.ROBOTS_SITE_URL ?? "https://purewire.vercel.app").replace(/\/+$/, "");
const MIRROR = (
  process.env.ROBOTS_MIRROR_URL ?? "https://outgoing-seal-727.convex.site"
).replace(/\/+$/, "");
const EXPECTED_HOST = (
  process.env.EXPECTED_SITEMAP_HOST ?? SITE
).replace(/\/+$/, "");

let checks = 0;
let passed = 0;
const check = (name, ok, extra = "") => {
  checks++;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// Retry transient failures (429, 5xx, network) with backoff — the health
// check runs in parallel with deploys, and a deploy-window blip must not
// red the gate.
const isTransient = (status) => status === 429 || status >= 500;
async function fetchText(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!isTransient(res.status) || i === attempts - 1) {
        return { status: res.status, text: await res.text() };
      }
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
  throw lastErr ?? new Error(`exhausted retries on ${url}`);
}

const main = async () => {
  console.log(`\nLive robots.txt guard — main ${SITE} / mirror ${MIRROR}\n`);

  // ── Main host: the exact canonical Sitemap line must survive ────────
  let site;
  try {
    site = await fetchText(`${SITE}/robots.txt`);
  } catch (err) {
    check("main robots.txt fetched", false, String(err));
  }
  if (site) {
    check("main robots.txt served (HTTP 200)", site.status === 200, `HTTP ${site.status}`);
    if (site.status === 200) {
      const sitemapLine = site.text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^sitemap:/i.test(l));
      const exact = sitemapLine !== undefined
        ? new RegExp(`^sitemap:\\s*${EXPECTED_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sitemap\\.xml\\s*$`, "i")
        : null;
      check(
        "main robots.txt Sitemap line points at the canonical host",
        exact !== null && exact.test(sitemapLine),
        sitemapLine ?? "MISSING",
      );
    }
  }

  // ── Mirror host: Disallow: / must survive, and no Allow may return ──
  let mirror;
  try {
    mirror = await fetchText(`${MIRROR}/robots.txt`);
  } catch (err) {
    check("mirror robots.txt fetched", false, String(err));
  }
  if (mirror) {
    check("mirror robots.txt served (HTTP 200)", mirror.status === 200, `HTTP ${mirror.status}`);
    if (mirror.status === 200) {
      const lines = mirror.text.split(/\r?\n/).map((l) => l.trim().toLowerCase());
      const disallowsAll =
        lines.includes("user-agent: *") && lines.includes("disallow: /");
      const hasAllow = lines.some((l) => l.startsWith("allow:"));
      check(
        "mirror robots.txt disallows everything",
        disallowsAll,
        mirror.text.trim().split(/\r?\n/).slice(0, 3).join(" | "),
      );
      check(
        "mirror robots.txt has no Allow line",
        !hasAllow,
        hasAllow ? mirror.text.trim().split(/\r?\n/).filter((l) => /^allow:/i.test(l)).join(" | ") : "",
      );
    }
  }

  console.log(`\n${passed}/${checks} checks passed`);
  if (passed !== checks) process.exitCode = 1;
};

main().catch((err) => {
  console.error("Live robots guard crashed:", err);
  process.exitCode = 1;
});
