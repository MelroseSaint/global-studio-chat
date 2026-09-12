#!/usr/bin/env node
/**
 * Nightly SEO audit against the live site using a subset of the claude-seo
 * toolkit (AgriciDaniel/claude-seo @ v2.2.4 — the same scripts used for
 * manual sweeps of purewire.vercel.app).
 *
 * Zero npm dependencies. The subset's only third-party Python dependencies
 * are `requests`, `beautifulsoup4` (parse_html's HTML tree) and `lxml`
 * (sitemap_discovery's XML parser) — the CI workflow installs all three into
 * a fresh venv; every script here is invoked directly, bypassing the skill's
 * runtime gate.
 *
 * Checks (each is a regression gate — a breach fails the job):
 *   1. fetch_page.py --googlebot on the sitemap → 200, <urlset, and at least
 *      one /post/ + one /u/ entry (user content stays indexable).
 *   1b. sitemap_discovery.py on the site root → runs clean and surfaces
 *      /sitemap.xml via robots.txt / common locations — a sitemap that is
 *      published but undiscoverable is a crawlability regression.
 *   2. fetch_page.py --googlebot on the newest post + profile from the live
 *      sitemap → 200 AND the server-rendered OG page (Article / ProfilePage
 *      JSON-LD), never the SPA shell (dynamic rendering works for crawlers).
 *   2b. parse_html.py --json on the fetched post + profile HTML → the same
 *      structural lints the sitemap-wide sweep enforces (title 10..70,
 *      meta description ≤160, canonical on the site host, ≥1 h1, ≥1 schema
 *      block), so the nightly audit measures what the manual sweep measures.
 *   3. gbp_deprecation_lint.py on the fetched post + profile HTML → zero
 *      deprecated-schema findings (critical/high/medium).
 *   4. content_quality.py --json on the post + profile HTML → overall score
 *      >= CQ_FLOOR (default 70; observed live 78 post / 74 profile).
 *   5. Baseline regression — a score may sit above the absolute floor yet
 *      have DROPPED more than CQ_DELTA (default 5) from the committed
 *      baseline (scripts/seo-audit-baseline.json, recorded from the live
 *      site with --write-baseline): that drop is a regression too, so the
 *      run fails even though the floor check passed. The baseline is
 *      refreshed explicitly (e.g. after an intentional content change),
 *      the same convention as the SEO sweep's flag baseline.
 *
 * Prints a PASS/FAIL table, writes seo-audit-metrics.md (embedded into the
 * alert issue by the workflow), and exits 1 on any regression with
 * ::error:: lines. Env: SITE_URL, SEO_SCRIPTS_DIR, PYTHON, CQ_FLOOR,
 * CQ_DELTA. Flag: --write-baseline (record current scores, skip delta).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SITE = (process.env.SITE_URL ?? "https://purewire.vercel.app").replace(/\/+$/, "");
const rawFloor = Number(process.env.CQ_FLOOR ?? 70);
const CQ_FLOOR = Number.isFinite(rawFloor) ? rawFloor : 70;
const rawDelta = Number(process.env.CQ_DELTA ?? 5);
const CQ_DELTA = Number.isFinite(rawDelta) ? rawDelta : 5;
const WRITE_BASELINE = process.argv.includes("--write-baseline");
const BASELINE_PATH = join(resolve("."), "scripts", "seo-audit-baseline.json");
// Committed baseline of the last known-good run's content-quality scores.
// Missing file / key = no comparison for that kind (never a failure on its
// own); --write-baseline records the current run as the new reference.
let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch {
  baseline = {};
  // A missing file is a first-run (no comparison, never a failure), but a
  // file that EXISTS and fails to parse silently disables the delta guard —
  // say so so an operator notices instead of losing the protection.
  if (existsSync(BASELINE_PATH)) {
    console.warn(
      `WARNING: ${BASELINE_PATH} exists but could not be parsed — the baseline-delta guard is OFF until it's fixed.`,
    );
  }
}
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

  // 1b) Sitemap discovery: robots.txt + common locations must surface the
  // same sitemap the audit validates above — a sitemap that's published but
  // undiscoverable wastes crawl budget no matter how valid its URLs are.
  const disc = runPy("sitemap_discovery.py", [SITE, "--json"]);
  let discovered = null;
  try {
    discovered = JSON.parse(disc.stdout);
  } catch {
    /* unparsable */
  }
  const found = Array.isArray(discovered?.found) ? discovered.found : [];
  // new URL(f.url, SITE): tolerant of a scheme-relative or bare-path URL the
  // discovery script might surface, while still failing on a missing sitemap.
  const foundPaths = found.map((f) => {
    try {
      return new URL(f.url, SITE).pathname;
    } catch {
      return "";
    }
  });
  check(
    "sitemap discovery runs clean",
    discovered !== null && !discovered.error,
    discovered?.error ?? `${found.length} candidate(s)`,
  );
  check(
    "sitemap discovery finds /sitemap.xml",
    foundPaths.includes("/sitemap.xml"),
    foundPaths.join(", ") || "none",
  );

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

  // 2b) Structural lints on the fetched pages (parse_html) — the same
  // title/meta/canonical/h1/schema gates the sitemap-wide sweep enforces,
  // closing the gap between the manual sweep and the nightly audit.
  const structural = {};
  for (const t of targets) {
    if (!t.body) continue;
    const ph = runPy("parse_html.py", [t.file, "--json"]);
    let parsed = null;
    try {
      parsed = JSON.parse(ph.stdout);
    } catch {
      /* unparsable */
    }
    const title = (parsed?.title ?? "").trim();
    const metaDesc = (parsed?.meta_description ?? "").trim();
    const canonical = parsed?.canonical ?? "";
    const h1Count = Array.isArray(parsed?.h1) ? parsed.h1.length : 0;
    const schemaCount = Array.isArray(parsed?.schema) ? parsed.schema.length : 0;
    structural[t.kind] = {
      title: title.length,
      meta: metaDesc.length,
      canonical,
      h1: h1Count,
      schema: schemaCount,
    };
    check(
      `parse_html title ${t.kind}`,
      parsed !== null && title.length >= 10 && title.length <= 70,
      parsed !== null ? `${title.length} chars` : "unparsable",
    );
    check(
      `parse_html meta ≤160 ${t.kind}`,
      parsed !== null && metaDesc.length > 0 && metaDesc.length <= 160,
      parsed !== null ? `${metaDesc.length} chars` : "missing/unparsable",
    );
    check(
      `parse_html canonical ${t.kind}`,
      parsed !== null && canonical.startsWith(SITE),
      canonical ? canonical : "missing",
    );
    check(
      `parse_html h1 ${t.kind}`,
      parsed !== null && h1Count >= 1,
      parsed !== null ? `${h1Count} h1` : "unparsable",
    );
    check(
      `parse_html schema ${t.kind}`,
      parsed !== null && schemaCount >= 1,
      parsed !== null ? `${schemaCount} schema block(s)` : "unparsable",
    );
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

  // 4) Content quality on the fetched pages (absolute floor). Score the
  //    visible BODY (head/scripts/styles stripped): the meta/og/twitter/
  //    JSON-LD tags repeat the excerpt by design (share cards), and raw-
  //    document scoring would count that duplication as repetition.
  const scores = {};
  for (const t of targets) {
    if (!t.body) continue;
    const bodyOnly = join(tmp, `body-${t.kind}.html`);
    writeFileSync(
      bodyOnly,
      (t.body ?? "")
        .replace(/<head[\s\S]*?<\/head>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " "),
      "utf8",
    );
    const cq = runPy("content_quality.py", ["--json", bodyOnly]);
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

  // 5) Baseline regression: a score above the absolute floor can still be a
  //    regression if it dropped more than CQ_DELTA from the committed
  //    baseline (the last known-good run). Comparing catches slow decay that
  //    the absolute floor would miss.
  const deltaNote = (kind) => {
    const base = baseline.scores?.[kind];
    const score = scores[kind];
    if (typeof base !== "number" || typeof score !== "number") {
      return {
        ok: true,
        note: `no comparison (baseline=${base ?? "none"}, score=${score ?? "n/a"})`,
      };
    }
    const drop = base - score;
    const breached = drop > CQ_DELTA;
    const sign = drop >= 0 ? "-" : "+";
    return {
      ok: !breached,
      note: breached
        ? `overall=${score} dropped ${drop} below baseline ${base} (max Δ ${CQ_DELTA})`
        : `overall=${score} vs baseline ${base} (Δ ${sign}${Math.abs(drop)}, max Δ ${CQ_DELTA})`,
    };
  };
  for (const kind of Object.keys(scores)) {
    const d = deltaNote(kind);
    check(
      `baseline ${kind}`,
      WRITE_BASELINE ? true : d.ok,
      WRITE_BASELINE ? "recorded as new baseline" : d.note,
    );
  }

  // --- metrics file for the alert issue ---------------------------------------
  const now = new Date().toISOString();

  // --write-baseline: record this run as the new reference (call it after an
  // intentional content change). Refused in CI and on an unhealthy run, so a
  // broken job can never bless a regression or overwrite the committed
  // baseline with null scores.
  if (WRITE_BASELINE) {
    const healthy =
      failures.length === 0 &&
      typeof scores.post === "number" &&
      typeof scores.profile === "number";
    if (process.env.CI) {
      console.error(
        "::error::--write-baseline refuses to run in CI — record baselines locally and commit the file.",
      );
      process.exitCode = 1;
    } else if (!healthy) {
      console.error(
        `::error::not writing baseline — run had ${failures.length} failure(s) or unparsable scores (post=${scores.post ?? "n/a"}, profile=${scores.profile ?? "n/a"}). Fix the regressions first, then re-record.`,
      );
      process.exitCode = 1;
    } else {
      const out = {
        scores: { post: scores.post, profile: scores.profile },
        updatedAt: now,
      };
      try {
        writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`);
        console.log(`\nWrote baseline to ${BASELINE_PATH}`);
      } catch {
        console.error(`::error::could not write ${BASELINE_PATH}`);
        process.exitCode = 1;
      }
    }
  }
  const metrics = [
    `## SEO audit metrics — ${now}`,
    "",
    `| Check | Result |`,
    `|---|---|`,
    `| Sitemap fetch (Googlebot) | ${smStatus === 200 ? "ok" : `HTTP ${smStatus}`} |`,
    `| Sitemap discovery | ${discovered === null ? "unparsable output" : (discovered?.error ?? `${foundPaths.join(", ") || "none"}`)} |`,
    `| Sitemap posts | ${posts.length} |`,
    `| Sitemap profiles | ${profiles.length} |`,
    ...targets.flatMap((t) => {
      const body = t.body ?? "";
      const base = baseline.scores?.[t.kind];
      const s = structural[t.kind];
      return [
        `| Fetch ${t.kind} (Googlebot) | HTTP ${t.status ?? "n/a"}, shell=${body.includes(SPA_MARKER)}, JSON-LD=${body.includes(t.ld)} |`,
        `| Parse_html ${t.kind} | ${s ? `title=${s.title} meta=${s.meta} h1=${s.h1} schema=${s.schema}` : "n/a (unfetched)"} |`,
        `| GBP lint ${t.kind} | ${scores[t.kind] === undefined ? "n/a (unfetched)" : "see log"} |`,
        `| Content quality ${t.kind} | ${scores[t.kind] ?? "n/a"} (floor ${CQ_FLOOR}) |`,
        `| Baseline ${t.kind} (max Δ ${CQ_DELTA}) | baseline=${base ?? "none"}, score=${scores[t.kind] ?? "n/a"} |`,
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
