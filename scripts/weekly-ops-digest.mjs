/**
 * Weekly ops digest — one issue summarizing repo health.
 *
 * Collects, via plain fetch (no deps):
 *   - CI trends: per-workflow success/failure counts over the last 7 days
 *   - Backup status: last successful "Backup snapshot" run + age
 *   - Open alert issues: every open issue labeled `prod-*`
 *   - Cloudinary quota: credits %, storage, bandwidth + the cached trend
 *     baseline (when the workflow restores the healthcheck's cache)
 *
 * Writes digest.md (workflow uploads it as an artifact and posts the
 * rendered digest to a deduplicated `weekly-ops-digest` issue, replacing
 * the previous week's body — one always-current health thread).
 *
 * Env:
 *   GITHUB_TOKEN / GITHUB_REPOSITORY  (CI-provided; repo API reads)
 *   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET (optional — quota section)
 *   QUOTA_BASELINE_FILE               (optional; trend section when present)
 *
 * Exit codes: 0 = digest written, 1 = API failure, 2 = misconfigured.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN ?? "";
const REPO = process.env.GITHUB_REPOSITORY ?? "";
if (!TOKEN || !REPO) {
  console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required (CI provides both).");
  process.exit(2);
}
const api = `https://api.github.com/repos/${REPO}`;
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
};
const DAY_MS = 24 * 60 * 60_000;
const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
const lines = [];
const md = (s) => lines.push(s);

async function gh(path) {
  const res = await fetch(`${api}${path}`, { headers: H });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

// ── 1. CI trends (last 7 days) ─────────────────────────────────────────
async function ciTrends() {
  const runs = await gh(`/actions/runs?created=>=${since}&per_page=100`);
  const per = new Map();
  let prFail = 0;
  let prOk = 0;
  for (const r of runs.workflow_runs ?? []) {
    // Dependabot's own workflow-update runs appear under the name
    // "github_actions in / for <action>" with head_branch "main" but are
    // manifest maintenance, not health signals — exclude them too.
    if (r.name.startsWith("github_actions")) continue;
    // Only main-branch runs reflect repo health: Dependabot PR runs get no
    // repo secrets and fail by design — they would poison the trend.
    if (r.head_branch !== "main") {
      if (r.conclusion === "success") prOk++;
      else if (["failure", "startup_failure", "timed_out"].includes(r.conclusion)) prFail++;
      continue;
    }
    const e = per.get(r.name) ?? { ok: 0, fail: 0, other: 0 };
    if (r.conclusion === "success") e.ok++;
    else if (["failure", "startup_failure", "timed_out", "cancelled"].includes(r.conclusion)) e.fail++;
    else e.other++;
    per.set(r.name, e);
  }
  md("## CI trends (last 7 days, main branch)\n");
  md("| Workflow | ✅ | ❌ | other |");
  md("|---|---|---|---|");
  for (const [name, e] of [...per.entries()].sort((a, b) => b[1].fail - a[1].fail || a[0].localeCompare(b[0]))) {
    md(`| ${name} | ${e.ok} | ${e.fail} | ${e.other} |`);
  }
  if (prOk + prFail > 0) {
    md("");
    md(`_Dependabot/PR runs excluded: ${prOk} passed, ${prFail} failed (PR runs get no repo secrets and fail by design)._`);
  }
  if (lines[lines.length - 1] !== "") {
    md("");
  }
}

// ── 2. Backup status ───────────────────────────────────────────────────
async function backupStatus() {
  const runs = await gh("/actions/runs?per_page=30");
  const last = (runs.workflow_runs ?? []).find(
    (r) => r.name === "Backup snapshot" && r.conclusion === "success",
  );
  md("## Backup status\n");
  if (!last) {
    md("⚠️ No successful **Backup snapshot** run found in the last 30 runs — verify the workflow is enabled.");
    return;
  }
  const ageDays = (Date.now() - new Date(last.created_at).getTime()) / DAY_MS;
  md(
    `- Last successful snapshot: **${new Date(last.created_at).toUTCString()}** (${ageDays.toFixed(1)} days ago)${ageDays > 8 ? " — ⚠️ OLDER THAN A WEEK, check the weekly schedule" : ""}`,
  );
  md("- Restore runbook: `docs/backup-restore.md` (drill-verified).");
  md("");
}

// ── 3. Open alert issues ───────────────────────────────────────────────
async function openAlerts() {
  const issues = await gh("/issues?state=open&per_page=100");
  const alerts = (issues ?? []).filter((i) => !i.pull_request && (i.labels ?? []).some((l) => String(l.name).startsWith("prod-")));
  md("## Open production alerts\n");
  if (alerts.length === 0) {
    md("None — all `prod-*` alert issues are closed. 🟢");
  } else {
    for (const a of alerts) md(`- #${a.number} ${a.title} (${(a.labels ?? []).map((l) => l.name).join(", ")})`);
  }
  md("");
}

// ── 4. Cloudinary quota ────────────────────────────────────────────────
async function quota() {
  const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
  const KEY = process.env.CLOUDINARY_API_KEY;
  const SECRET = process.env.CLOUDINARY_API_SECRET;
  md("## Cloudinary quota\n");
  if (!CLOUD || !KEY || !SECRET) {
    md("_(credentials not provided to this job)_");
    return;
  }
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/usage`, {
    headers: { Authorization: `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}` },
  });
  if (!res.ok) {
    md(`⚠️ usage endpoint returned HTTP ${res.status}`);
    return;
  }
  const u = await res.json();
  const gbb = (b) => (b / 1024 ** 3).toFixed(3);
  md(
    `- Plan **${u.plan}**: credits **${(u.credits?.usage ?? 0).toFixed(2)} / ${u.credits?.limit ?? "?"}** (${(u.credits?.used_percent ?? 0).toFixed(1)}%)${(u.credits?.used_percent ?? 0) >= 60 ? " — ⚠️ approaching the hard stop" : ""}`,
  );
  md(`- Storage **${gbb(u.storage?.usage ?? 0)} GB** · bandwidth **${gbb(u.bandwidth?.usage ?? 0)} GB** · transformations **${u.transformations?.usage ?? 0}**`);
  const f = process.env.QUOTA_BASELINE_FILE ?? ".quota-baseline.json";
  if (existsSync(f)) {
    try {
      const b = JSON.parse(readFileSync(f, "utf8"));
      const days = (Date.now() - b.date) / DAY_MS;
      if (days >= 1 && b.storageUsage <= (u.storage?.usage ?? 0)) {
        const perDay = (u.storage.usage - b.storageUsage) / days;
        const headroom = (Number(process.env.CLOUDINARY_STORAGE_CAP_GB ?? 10) * 1024 ** 3 - u.storage.usage) / perDay;
        md(`- Growth trend **${gbb(perDay)} GB/day** over ${days.toFixed(1)}d → ~${headroom.toFixed(0)} days of storage headroom`);
      }
    } catch {
      // baseline is informational only
    }
  }
  md("");
}

async function main() {
  console.log(`Weekly ops digest for ${REPO}\n`);
  md(`# Weekly ops digest — ${new Date().toUTCString().slice(5, 16)}`);
  md("");
  const steps = [
    ["CI trends", ciTrends],
    ["Backup status", backupStatus],
    ["Open alerts", openAlerts],
    ["Quota", quota],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      md(`## ${name}\n\n⚠️ section failed: ${String(e.message ?? e).slice(0, 200)}\n`);
      console.error(`section ${name} failed:`, e.message);
    }
  }
  writeFileSync("digest.md", lines.join("\n") + "\n");
  console.log(`digest.md written (${lines.length} lines)`);
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
