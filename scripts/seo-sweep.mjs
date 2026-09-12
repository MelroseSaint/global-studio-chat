#!/usr/bin/env node
/**
 * SEO sweep — the claude-seo linters + content quality over the WHOLE live
 * sitemap, not just the newest post/profile (that narrower check is
 * scripts/seo-audit.mjs). Same toolkit, same conventions:
 *
 *   - fetch_page.py --googlebot  → the crawler-facing server-rendered page
 *   - parse_html.py --json       → title / meta description / canonical /
 *                                  h1 / schema JSON-LD (structural lints)
 *   - gbp_deprecation_lint.py    → retired GBP features (chat, business.site)
 *   - content_quality.py --json  → QRG filler/AI-pattern/repetition scores
 *
 * Regression semantics (a breach fails CI with exit 1):
 *   - every sampled URL must fetch 200 with the server-rendered JSON-LD
 *     (never the SPA shell),
 *   - structural lints must pass (title 10..70, meta description ≤160,
 *     canonical on the site host, ≥1 h1, ≥1 schema block),
 *   - gbp_deprecation_lint must be clean (0 critical/high/medium),
 *   - content_quality overall must be ≥ CQ_FLOOR (default 60),
 *   - a content_quality FLAG not present in the class baseline
 *     (scripts/seo-sweep-baseline.json) is a NEW regression — the baseline
 *     is recorded from the live site with --write-baseline and committed,
 *     so a flag that never appeared before fails the run.
 *
 * The IPTC AI-label check (iptc_ai_label) audits the site OG image, not
 * pages, and currently every image lacks the label, so it is OFF by
 * default and only enforced with REQUIRE_IPTC_LABEL=1 (needs exiftool) —
 * flip it on once the label is injected at the source.
 *
 * Usage:
 *   npm run qa:seo-sweep            # sample 8 posts + 8 profiles
 *   SITEMAP_SAMPLE=50 npm run qa:seo-sweep
 *   npm run qa:seo-sweep:all        # every post + profile in the sitemap
 *   node scripts/seo-sweep.mjs --write-baseline   # (re)record the baseline
 *
 * Zero npm deps. Env: SITE_URL, SEO_SCRIPTS_DIR, PYTHON, CQ_FLOOR,
 * SITEMAP_SAMPLE, REQUIRE_IPTC_LABEL, EXIFTOOL, SEO_SWEEP_BASELINE.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SITE = (process.env.SITE_URL ?? "https://purewire.vercel.app").replace(/\/+$/, "");
const FULL_SWEEP = process.argv.includes("--all");
const rawSample = Number(process.env.SITEMAP_SAMPLE ?? 8);
const SAMPLE_PER_CLASS = FULL_SWEEP ? Infinity : (Number.isFinite(rawSample) ? rawSample : 8);
const rawFloor = Number(process.env.CQ_FLOOR ?? 60);
const CQ_FLOOR = Number.isFinite(rawFloor) ? rawFloor : 60;
const REQUIRE_IPTC = process.env.REQUIRE_IPTC_LABEL === "1";
const WRITE_BASELINE = process.argv.includes("--write-baseline");
const BASELINE_PATH =
  process.env.SEO_SWEEP_BASELINE ??
  join(resolve("."), "scripts", "seo-sweep-baseline.json");
const CRAWLER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SPA_MARKER = '<div id="root">';

// --- skill script + python resolution (same as seo-audit.mjs) ---------------
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

const pythonCandidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
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

// --- baseline ----------------------------------------------------------------
let baseline = {};
if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    baseline = {};
  }
}
const observed = {}; // class -> Set(flags) collected this run

// --- helpers -----------------------------------------------------------------
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
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    all: (res.stdout ?? "") + "\n" + (res.stderr ?? ""),
  };
};

const tmp = mkdtempSync(join(tmpdir(), "seo-sweep-"));

// Strip the document head + scripts/styles so content_quality scores the
// VISIBLE article body, not the raw document: meta/og/twitter/JSON-LD tags
// legitimately repeat the same excerpt (that's how share cards work), and
// scoring the raw HTML counts that duplication as "repetitive content" —
// a false positive that grows with post length. Body-only is what a human
// (or a crawler dumping visible text) would actually read.
function visibleBodyHtml(raw) {
  return raw
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
}

// --- per-page audit ----------------------------------------------------------
function auditPage({ kind, url, file, site }) {
  const label = `${kind} ${url.replace(site, "")}`;

  // 1) Crawler fetch → 200 + server-rendered, never the SPA shell.
  const f = runPy("fetch_page.py", ["--googlebot", "--output", file, url]);
  const status = Number((f.all.match(/Status: (\d+)/) ?? [])[1] ?? 0);
  const body = existsSync(file) ? readFileSync(file, "utf8") : "";
  const isShell = body.includes(SPA_MARKER);
  const ld = kind === "post" ? '"@type":"Article"' : '"@type":"ProfilePage"';
  const ldOk = body.includes(ld);
  const fetchOk = status === 200 && !isShell && ldOk;
  check(
    `fetch ${label}`,
    fetchOk,
    `HTTP ${status}, shell=${isShell}, JSON-LD=${ldOk ? "ok" : "MISSING"}`,
  );
  if (!fetchOk) return { status, body };

  // 2) Structural lints via parse_html.py.
  const ph = runPy("parse_html.py", [file, "--json"]);
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
  check(
    `title length ${label}`,
    parsed !== null && title.length >= 10 && title.length <= 70,
    parsed ? `${title.length} chars` : "unparsable",
  );
  check(
    `meta description ≤160 ${label}`,
    parsed !== null && metaDesc.length > 0 && metaDesc.length <= 160,
    parsed ? `${metaDesc.length} chars` : "missing/unparsable",
  );
  check(
    `canonical on site ${label}`,
    parsed !== null && canonical.startsWith(site),
    canonical ? canonical : "missing",
  );
  check(`h1 present ${label}`, h1Count >= 1, `h1=${h1Count}`);
  check(`schema JSON-LD ${label}`, schemaCount >= 1, `blocks=${schemaCount}`);

  // 3) GBP deprecation lint.
  const lint = runPy("gbp_deprecation_lint.py", ["--file", file]);
  const m = lint.stdout.match(/(\d+) critical, (\d+) high, (\d+) medium/);
  const counts = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  const clean = counts !== null && counts.every((c) => c === 0) && /PASS/.test(lint.stdout);
  check(
    `gbp_deprecation_lint ${label}`,
    clean,
    counts ? `critical=${counts[0]} high=${counts[1]} medium=${counts[2]}` : "unparsable output",
  );

  // 4) Content quality: overall floor + NEW-flag regression vs baseline.
  //    Score the visible BODY (head/scripts/styles stripped) — the meta
  //    tags that repeat the excerpt are share-card boilerplate, not
  //    repetitive content, and would inflate the repetition signal.
  const bodyOnly = join(tmp, `body-${Math.random().toString(36).slice(2, 8)}.html`);
  writeFileSync(bodyOnly, visibleBodyHtml(body), "utf8");
  const cq = runPy("content_quality.py", ["--json", bodyOnly]);
  let quality = null;
  let flags = [];
  try {
    const j = JSON.parse(cq.stdout);
    quality = j.overall_quality;
    flags = j.flags ?? [];
  } catch {
    /* unparsable */
  }
  observed[kind] = observed[kind] ?? new Set();
  for (const fl of flags) observed[kind].add(fl);
  check(
    `content_quality overall ${label}`,
    typeof quality === "number" && quality >= CQ_FLOOR,
    quality === null ? "unparsable" : `overall=${quality} (floor ${CQ_FLOOR})`,
  );
  const allowed = new Set((baseline[kind]?.flags ?? []).map(String));
  const newFlags = flags.filter((fl) => !allowed.has(String(fl)));
  const flagsOk = newFlags.length === 0;
  check(
    `content_quality flags ${label}`,
    flagsOk,
    flagsOk
      ? `flags=[${flags.join(",")}]`
      : `NEW flags [${newFlags.join(",")}] not in baseline (baseline=${[...allowed].join(",") || "none"})`,
  );
  return { status, body, quality, flags };
}

// --- IPTC AI label (off unless required) -------------------------------------
function iptcCheck() {
  if (!REQUIRE_IPTC) {
    console.log(
      "SKIP iptc_ai_label (site OG image) — off by default; set REQUIRE_IPTC_LABEL=1 to enforce once the label is injected at the source.",
    );
    return;
  }
  const et =
    process.env.EXIFTOOL ??
    (process.platform === "win32"
      ? join(process.env.HOME ?? "", "exiftool", "exiftool-13.59_64", "exiftool.exe")
      : "exiftool");
  if (!existsSync(et)) {
    console.error("::error::REQUIRE_IPTC_LABEL=1 but exiftool is not available. Set EXIFTOOL.");
    failures.push("iptc_ai_label (exiftool missing)");
    checks++;
    return;
  }
  const probe = spawnSync(et, ["-ver"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.error("::error::exiftool does not run. Set EXIFTOOL to a working binary.");
    failures.push("iptc_ai_label (exiftool broken)");
    checks++;
    return;
  }
  const img = join(tmp, "og-image.png");
  const dl = spawnSync("curl", ["-fsSL", "-o", img, `${SITE}/og-image.png`], { encoding: "utf8" });
  if (dl.status !== 0 || !existsSync(img)) {
    console.error("::error::could not download the site OG image for the IPTC audit.");
    failures.push("iptc_ai_label (og-image download failed)");
    checks++;
    return;
  }
  const out = spawnSync(et, ["-G1", "-s", "-DigitalSourceType", img], { encoding: "utf8" });
  const labelled = (out.stdout ?? "").trim().length > 0;
  check("iptc_ai_label og-image", labelled, labelled ? out.stdout.trim() : "DigitalSourceType MISSING");
}

// --- main --------------------------------------------------------------------
const main = async () => {
  console.log(`\nSEO sweep (claude-seo linters + content quality) — ${SITE}\n`);

  // 1) The live sitemap, fetched the way a search engine sees it.
  const smFile = join(tmp, "sitemap.xml");
  const sm = runPy("fetch_page.py", ["--googlebot", "--output", smFile, `${SITE}/sitemap.xml`]);
  const smStatus = Number((sm.all.match(/Status: (\d+)/) ?? [])[1] ?? 0);
  check("sitemap fetch (Googlebot)", smStatus === 200, `HTTP ${smStatus}`);
  let xml = "";
  try {
    xml = readFileSync(smFile, "utf8");
  } catch {
    /* handled below */
  }
  check("sitemap is a urlset", /<urlset/.test(xml));
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const posts = locs.filter((u) => u.includes("/post/"));
  const profiles = locs.filter((u) => u.includes("/u/"));
  check("sitemap lists posts", posts.length > 0, `${posts.length} post(s)`);
  check("sitemap lists profiles", profiles.length > 0, `${profiles.length} profile(s)`);

  // The nightly QA harness creates + then shadowbans/deletes reserved
  // `qa_*` throwaway accounts; the sitemap's CDN cache lags those flips by
  // up to an hour, so a cached sitemap can briefly list a qa_ profile that
  // already 404s. That is harness noise, not a content regression — skip
  // the handles (real dead profiles still fail the fetch check).
  const realProfiles = profiles.filter((u) => !/\/u\/qa_[^/]+$/.test(u));
  const skippedTest = profiles.length - realProfiles.length;
  if (skippedTest > 0) {
    console.log(
      `Note: skipping ${skippedTest} qa_* test profile(s) (QA-harness noise, cached-sitemap lag).`,
    );
  }

  const sample = (arr) => (SAMPLE_PER_CLASS === Infinity ? arr : arr.slice(0, SAMPLE_PER_CLASS));
  const targets = [
    ...sample(posts).map((url) => ({ kind: "post", url })),
    ...sample(realProfiles).map((url) => ({ kind: "profile", url })),
  ];
  const scope = SAMPLE_PER_CLASS === Infinity ? "full" : `sample ${SAMPLE_PER_CLASS}/class`;
  console.log(`Sweeping ${targets.length} URLs (${scope})\n`);

  for (const t of targets) {
    const file = join(tmp, `${t.kind}-${Math.random().toString(36).slice(2, 8)}.html`);
    t.result = auditPage({ ...t, file, site: SITE });
  }

  iptcCheck();

  // --- baseline --------------------------------------------------------------
  if (WRITE_BASELINE) {
    const out = {};
    for (const [cls, set] of Object.entries(observed)) {
      out[cls] = { flags: [...set].sort() };
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + "\n");
    console.log(`\nWrote baseline to ${BASELINE_PATH}: ${JSON.stringify(out)}`);
  }

  // --- metrics file for the alert issue --------------------------------------
  const now = new Date().toISOString();
  const rows = targets.map((t) => {
    const r = t.result ?? {};
    return [
      `| ${t.kind} ${t.url.replace(SITE, "")} |`,
      `fetch=${r.status ?? "n/a"}${r.body?.includes(SPA_MARKER) ? " shell!" : ""} |`,
      `overall=${r.quality ?? "n/a"} flags=[${(r.flags ?? []).join(",")}] |`,
    ].join(" ");
  });
  const metrics = [
    `## SEO sweep metrics — ${now}`,
    "",
    `| Page | Result |`,
    `|---|---|`,
    ...rows,
    "",
    `Scope: ${scope}. Content-quality floor: ${CQ_FLOOR}.`,
    `Failing checks: ${failures.length ? failures.join("; ") : "none"}`,
    "",
  ].join("\n");
  try {
    writeFileSync(join(resolve("."), "seo-sweep-metrics.md"), metrics);
  } catch {
    /* metrics are best-effort */
  }

  console.log(`\n${passed}/${checks} checks passed`);
  if (WRITE_BASELINE) {
    console.log("Baseline written — not failing on new flags this run.");
  } else if (failures.length > 0) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exitCode = 1;
  }
};

main()
  .catch((err) => {
    console.error("SEO sweep crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
