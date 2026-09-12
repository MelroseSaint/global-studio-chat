#!/usr/bin/env node
/**
 * PureWire critical-path JS size guard.
 *
 * The browser downloads and executes every chunk the built index.html
 * preloads (module scripts + modulepreload links) BEFORE the first paint —
 * that total is the "critical path" and the single biggest lever on load
 * time. This guard fails the build when that total grows past a committed
 * baseline, so a regression like re-adding the ui/motion chunks to the
 * entry (a ~150 kB silent hit to every page load, including the public
 * Landing) can never land unnoticed.
 *
 * Usage:
 *   node scripts/check-critical-path.mjs            # check against baseline
 *   node scripts/check-critical-path.mjs --update   # deliberately re-baseline
 *
 * Env:
 *   CRITICAL_PATH_TOLERANCE  allowed growth fraction over the baseline
 *                            (default 0.05 — covers byte-level drift between
 *                            builds while still failing on any real chunk
 *                            reappearing in the entry).
 *
 * The baseline lives in scripts/critical-path-baseline.json. To accept a
 * LEGITIMATE growth (a genuinely necessary new eager dependency), run with
 * --update after verifying the increase, and commit the new baseline.
 *
 * Exit codes: 0 = within baseline, 1 = regression (or broken dist), 2 = the
 * baseline file is missing (misconfigured run).
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(process.cwd(), "dist", "index.html");
const BASELINE_PATH = join(process.cwd(), "scripts", "critical-path-baseline.json");
const TOLERANCE = Number(process.env.CRITICAL_PATH_TOLERANCE ?? 0.05);
const UPDATE = process.argv.includes("--update");

/** Every critical-path JS URL the built HTML references, in load order. */
function preloadedJsUrls(html) {
  const urls = new Set();
  // module scripts (the entry) and modulepreload links (its static graph).
  const scriptRe = /<script[^>]+type="module"[^>]+src="([^"]+\.js)"/g;
  const preloadRe = /<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g;
  for (const re of [scriptRe, preloadRe]) {
    for (let m = re.exec(html); m !== null; m = re.exec(html)) {
      urls.add(m[1]);
    }
  }
  return [...urls];
}

function main() {
  if (!Number.isFinite(TOLERANCE) || TOLERANCE < 0) {
    console.error(`CRITICAL_PATH_TOLERANCE must be a non-negative number (got "${process.env.CRITICAL_PATH_TOLERANCE}").`);
    process.exit(1);
  }
  let html;
  try {
    html = readFileSync(DIST, "utf8");
  } catch {
    console.error(`Critical-path guard: ${DIST} not found — run \`npm run build\` first.`);
    process.exit(1);
  }

  const urls = preloadedJsUrls(html);
  if (urls.length === 0) {
    console.error("Critical-path guard: no module scripts or modulepreload links found in dist/index.html — the parser may be stale (Vite changed its HTML shape).");
    process.exit(1);
  }

  let total = 0;
  const rows = urls
    .map((u) => {
      const file = join(process.cwd(), "dist", u);
      let bytes;
      try {
        bytes = statSync(file).size;
      } catch {
        console.error(`Critical-path guard: preloaded chunk ${u} missing from dist/.`);
        process.exit(1);
      }
      total += bytes;
      return { url: u, bytes };
    })
    .sort((a, b) => b.bytes - a.bytes);

  console.log("Critical-path JS (preloaded chunks):");
  for (const { url, bytes } of rows) {
    console.log(`  ${String(bytes).padStart(8)}  ${url}`);
  }
  console.log(`  ${String(total).padStart(8)}  total (${(total / 1024).toFixed(1)} kB raw, ~${(total / 1024 * 0.32).toFixed(1)} kB gzip est.)`);

  if (UPDATE) {
    const next = {
      totalBytes: total,
      updatedAt: new Date().toISOString(),
      note: "Critical-path JS total (sum of HTML-preloaded chunks). Update deliberately via --update.",
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
    console.log(`Baseline updated to ${total} bytes.`);
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    console.error(`Critical-path guard: baseline file ${BASELINE_PATH} is missing or invalid. Create it with \`node scripts/check-critical-path.mjs --update\`.`);
    process.exit(2);
  }
  const baselineBytes = Number(baseline.totalBytes);
  const allowed = Math.ceil(baselineBytes * (1 + TOLERANCE));
  console.log(`  baseline ${baselineBytes} bytes · tolerance ${(TOLERANCE * 100).toFixed(0)}% → allowed ${allowed} bytes`);

  if (total > allowed) {
    const delta = total - baselineBytes;
    console.error(
      `FAIL: critical-path JS grew ${delta} bytes (${(delta / 1024).toFixed(1)} kB) past the baseline. ` +
        `If this growth is intentional, verify it and re-baseline with \`node scripts/check-critical-path.mjs --update\`.`,
    );
    process.exit(1);
  }
  console.log(`Critical-path JS within baseline (${total} ≤ ${allowed}).`);
}

main();
