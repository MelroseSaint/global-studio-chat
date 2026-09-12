#!/usr/bin/env node
/**
 * Dependency vulnerability gate.
 *
 * Runs `npm audit --json` and fails on high/critical vulnerabilities,
 * reporting moderate ones without failing (the free-plan reality: some
 * transitive advisories have no fix yet). `NPM_AUDIT_FAIL_ON` overrides
 * the failing level (`critical` | `high` | `moderate`), and
 * `NPM_AUDIT_ALLOWLIST` (comma-separated advisory IDs) documents
 * accepted risks explicitly instead of silently.
 *
 * Exit codes: 0 clean (or only accepted/allowlisted findings),
 * 1 vulnerabilities at or above the failing level, 2 audit itself failed.
 */
import { execSync } from "node:child_process";

const FAIL_ON = process.env.NPM_AUDIT_FAIL_ON ?? "high";
const LEVELS = { low: 0, moderate: 1, high: 2, critical: 3 };
const failLevel = LEVELS[FAIL_ON] ?? LEVELS.high;
const allowlist = new Set(
  (process.env.NPM_AUDIT_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

let report;
try {
  report = JSON.parse(
    execSync("npm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
  );
} catch (err) {
  // npm audit exits non-zero when it finds vulns; the JSON is still on stdout.
  if (err.stdout) {
    try {
      report = JSON.parse(err.stdout);
    } catch {
      console.error("npm audit produced unparseable output");
      process.exit(2);
    }
  } else {
    console.error("npm audit failed to run:", err.message);
    process.exit(2);
  }
}

const vulns = Object.values(report.vulnerabilities ?? {});
const severities = { low: 0, moderate: 1, high: 2, critical: 3 };

let blocking = 0;
const accepted = [];
const reportable = [];
for (const v of vulns) {
  const via = (v.via ?? []).filter((x) => typeof x === "object");
  const ids = via.map((x) => x.source).filter(Boolean);
  const isDirect = v.fixAvailable !== false && ids.some((id) => !allowlist.has(String(id)));
  if (allowlist.has(String(v.name)) || ids.every((id) => allowlist.has(String(id)))) {
    accepted.push(`${v.name} (${v.severity}, advisory ${ids.join(",")}) — accepted risk`);
    continue;
  }
  if (severities[v.severity] >= failLevel) {
    blocking++;
    console.error(
      `  ✗ ${v.name}: ${v.severity} (via ${ids.join(", ") || "direct"})` +
        (isDirect && v.fixAvailable ? " — fix available" : " — NO direct fix"),
    );
  } else {
    reportable.push(`${v.name}: ${v.severity} (advisory ${ids.join(",")})`);
  }
}

for (const line of reportable) console.log(`  • ${line} (below gate, reported)`);
for (const line of accepted) console.log(`  ✓ ${line}`);

if (blocking > 0) {
  console.error(`\nnpm-audit gate: ${blocking} vulnerable package(s) at ${FAIL_ON}+ severity.`);
  console.error("Update them, or add the advisory ID to NPM_AUDIT_ALLOWLIST with a reason in docs/security-review.md.");
  process.exit(1);
}
console.log("\nnpm-audit gate: clean.");
