#!/usr/bin/env node
/**
 * Nightly SEO audit against the live site using a subset of the claude-seo
 * toolkit (AgriciDaniel/claude-seo @ v2.2.4 — the same scripts used for
 * manual sweeps of purewire.vercel.app).
 *
 * Zero npm dependencies. The subset's only third-party Python dependency is
 * `requests` (the CI workflow installs it into a fresh venv); every script
 * here is invoked directly, bypassing the skill's runtime gate.
 *
 * Checks (each is a regression floor — a breach fails the job):
 *   1. fetch_page.py --googlebot on the sitemap → 200, <urlset, and at least
 *      one /post/ + one /u/ entry (user content stays indexable).
 *   2. fetch_page.py --googlebot on the newest post + profile from the live
 *      sitemap → 200 AND the server-rendered OG page (Article / ProfilePage
 *      JSON-LD), never the SPA shell (dynamic rendering works for crawlers).
 *   3. gbp_deprecation_lint.py on the fetched post + profile HTML → zero
 *      deprecated-schema findings (critical/high/medium).
 *   4. content_quality.py --json on the post + profile HTML → overall score
 *      >= CQ_FLOOR (default 70; observed live 78 post / 74 profile).
 *
 * Prints a PASS/FAIL table, writes seo-audit-metrics.md (embedded into the
 * alert issue by the workflow), and exits 1 on any regression with
 * ::error:: lines. Env: SITE_URL, SEO_SCRIPTS_DIR, PYTHON, CQ_FLOOR.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SITE = (process.env.SITE_URL ?? "https://purewire.vercel.app").replace(/\/+$/, "");
const rawFloor = Number(process.env.CQ_FLOOR ?? 70);
const CQ_FLOOR = Number.isFinite(rawFloor) ? rawFloor : 70;
const CRAWLER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SPA_MARKER = '<div id="root">';

// --- skill script resolution -------------------------------------------------
const scriptCandidates = [
  process.env.SEO_SCRIPTS_DIR && join(process.env.SEO_SCRIPTS_DIR, "fetch_page.py"),
  join(resolve("."), ".agents", "skills", "seo", "scripts", "fetch_page.py"),
  join(process.env.HOME ?? "", ".claude", "skills", "seo", "scripts", "fetch_page.py"),
].filter(Boolean);
const scriptPath = scriptCandidates.find(existsSync);
if (!scriptPath) {
  console.error(
    "::error::claude-seo scripts not found. Set SEO_SCRIPTS_DIR to the skill's scripts/ dir (e.g. a clone of AgriciDaniel/claude-seo).",
  );
  process.exit(1);
}
const SCRIPTS_DIR = resolve(scriptPath, "..");

// --- python resolution --------------------------------------------------------
const pythonCandidates = [
  process.env.PYTHON,
  "python3",
  "python",
].filter(Boolean);
function findPython() {
  for (const cand of pythonCandidates) {
    const probe = spawnSync(cand, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return cand;
  }
  return null;
}
const PYTHON = findPython();
if (!PYTHON) {
  console.error("::error::no usable Python 3.10+ found. Set PYTHON to the venv interpreter.");
  process.exit(1);
}

// --- helpers ------------------------------------------------------------------
let checks = 0;
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  checks++;
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` (${detail})` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const runPy = (script, args) => {
  const res = spawnSync(PYTHON, [join(SCRIPTS_DIR, script), ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  // fetch_page.py logs "Status: 200" / "Saved to …" to STDERR, so parse the
  // combined stream (content_quality's JSON stays pure on stdout).
  return { code: res.status ?? -1, stdout, stderr, all: stdout + "\n" + stderr };
};

const tmp = mkdtempSync(join(tmpdir(), "seo-audit-"));

// --- main ----------------------------------------------------------------------
const main = async () => {
  console.log(`\nSEO audit (claude-seo subset) — ${SITE}\n`);

  // 1) Sitemap: fetch with the Googlebot UA through the middleware.
  const sitemapOut = join(tmp, "sitemap.xml");
  const sm = runPy("fetch_page.py", ["--googlebot", "--output", sitemapOut, `${SITE}/sitemap.xml`]);
  const smStatus = Number((sm.all.match(/Status: (\d+)/) ?? [])[1] ?? 0);
  check("sitemap fetch (Googlebot)", smStatus === 200, `HTTP ${smStatus}`);
  let xml = "";
  try {
    xml = readFileSync(sitemapOut, "utf8");
  } catch {
    /* handled below */
  }
  check("sitemap is a urlset", /<urlset/.test(xml));
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const posts = locs.filter((u) => u.includes("/post/"));
  const profiles = locs.filter((u) => u.includes("/u/"));
  check("sitemap lists posts", posts.length > 0, `${posts.length} post(s)`);
  check("sitemap lists profiles", profiles.length > 0, `${profiles.length} profile(s)`);

  // 2) Fetch the newest post + profile exactly like a search engine would.
  const targets = [
    { kind: "post", url: posts[0], ld: '"@type":"Article"', file: join(tmp, "post.html") },
    { kind: "profile", url: profiles[0], ld: '"@type":"ProfilePage"', file: join(tmp, "profile.html") },
  ];
  for (const t of targets) {
    if (!t.url) {
      check(`fetch ${t.kind}`, false, "no URL in sitemap");
      continue;
    }
    const f = runPy("fetch_page.py", ["--googlebot", "--output", t.file, t.url]);
    const status = Number((f.all.match(/Status: (\d+)/) ?? [])[1] ?? 0);
    t.status = status;
    let body = "";
    try {
      body = readFileSync(t.file, "utf8");
    } catch {
      /* handled below */
    }
    const isShell = body.includes(SPA_MARKER);
    const ldOk = body.includes(t.ld);
    const ok = status === 200 && !isShell && ldOk;
    check(
      `fetch ${t.kind} (Googlebot, server-rendered)`,
      ok,
      `HTTP ${status}, shell=${isShell}, JSON-LD=${ldOk ? "ok" : "MISSING"}`,
    );
    t.body = body;
  }

  // 3) Schema lint on the fetched pages.
  for (const t of targets) {
    if (!t.body) continue;
    const lint = runPy("gbp_deprecation_lint.py", ["--file", t.file]);
    const m = lint.stdout.match(/(\d+) critical, (\d+) high, (\d+) medium/);
    const counts = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    const clean = counts && counts.every((c) => c === 0) && /PASS/.test(lint.stdout);
    check(
      `gbp_deprecation_lint ${t.kind}`,
      clean === true,
      counts ? `critical=${counts[0]} high=${counts[1]} medium=${counts[2]}` : "unparsable output",
    );
  }

  // 4) Content quality on the fetched pages.
  const scores = {};
  for (const t of targets) {
    if (!t.body) continue;
    const cq = runPy("content_quality.py", ["--json", t.file]);
    let quality = null;
    try {
      quality = JSON.parse(cq.stdout).overall_quality;
    } catch {
      /* unparsable */
    }
    scores[t.kind] = quality;
    check(
      `content_quality ${t.kind}`,
      typeof quality === "number" && quality >= CQ_FLOOR,
      quality === null ? "unparsable output" : `overall=${quality} (floor ${CQ_FLOOR})`,
    );
  }

  // --- metrics file for the alert issue ---------------------------------------
  const now = new Date().toISOString();
  const metrics = [
    `## SEO audit metrics — ${now}`,
    "",
    `| Check | Result |`,
    `|---|---|`,
    `| Sitemap fetch (Googlebot) | ${smStatus === 200 ? "ok" : `HTTP ${smStatus}`} |`,
    `| Sitemap posts | ${posts.length} |`,
    `| Sitemap profiles | ${profiles.length} |`,
    ...targets.flatMap((t) => {
      const body = t.body ?? "";
      return [
        `| Fetch ${t.kind} (Googlebot) | HTTP ${t.status ?? "n/a"}, shell=${body.includes(SPA_MARKER)}, JSON-LD=${body.includes(t.ld)} |`,
        `| GBP lint ${t.kind} | ${scores[t.kind] === undefined ? "n/a (unfetched)" : "see log"} |`,
        `| Content quality ${t.kind} | ${scores[t.kind] ?? "n/a"} (floor ${CQ_FLOOR}) |`,
      ];
    }),
    "",
    `Failing checks: ${failures.length ? failures.join("; ") : "none"}`,
    "",
  ].join("\n");
  try {
    writeFileSync(join(resolve("."), "seo-audit-metrics.md"), metrics);
  } catch {
    /* metrics are best-effort */
  }

  console.log(`\n${passed}/${checks} checks passed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exitCode = 1;
  }
};

main()
  .catch((err) => {
    console.error("SEO audit crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
