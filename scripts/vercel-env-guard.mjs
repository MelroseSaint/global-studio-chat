#!/usr/bin/env node
/**
 * Vercel env guard — production.
 *
 * The canonical host is repo-owned by construction: vite.config.ts defaults
 * to https://purewire.vercel.app and the dashboard self-documents it via
 * PUREWIRE_SITE_URL. The stale VITE_SITE_URL var was the original source of
 * the wrong-host bug, so this guard fails CI if it EVER reappears in any
 * Vercel environment (someone re-adding it would re-open the canonical-host
 * defect and re-emit the build warning), and asserts PUREWIRE_SITE_URL is
 * still set in production so the invariant can't silently drift.
 *
 * Zero dependencies. Needs VERCEL_TOKEN (a Vercel access token — the same
 * secret the Deploy workflow uses). Project/team come from
 * .vercel/project.json unless overridden. Exit 0 = invariant holds.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.VERCEL_TOKEN;
if (!TOKEN) {
  console.error("::error::VERCEL_TOKEN is not set");
  process.exit(1);
}

let projectId = process.env.VERCEL_PROJECT_ID;
let teamId = process.env.VERCEL_TEAM_ID;
if (!projectId || !teamId) {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), ".vercel", "project.json"), "utf8"));
  projectId = projectId ?? cfg.projectId;
  teamId = teamId ?? cfg.orgId;
}

const STALE_KEY = "VITE_SITE_URL";
const CANONICAL_KEY = "PUREWIRE_SITE_URL";

let checks = 0;
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  checks++;
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` (${detail})` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const main = async () => {
  const res = await fetch(
    `https://api.vercel.com/v9/projects/${projectId}/env?teamId=${teamId}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  const body = await res.json();
  if (!res.ok) {
    console.error(`::error::Vercel env API failed: HTTP ${res.status} ${body.error?.code ?? ""}`);
    process.exitCode = 1;
    return;
  }
  const envs = body.envs ?? body.env ?? [];

  // 1) The stale var must never exist in ANY environment.
  const stale = envs.filter((e) => e.key === STALE_KEY);
  check(
    `no ${STALE_KEY} in any environment`,
    stale.length === 0,
    stale.length
      ? stale.map((e) => `${(e.target ?? []).join(",") || "?"}`).join(", ")
      : "all clear",
  );

  // 2) The canonical host must stay self-documented in production.
  const canonical = envs.find((e) => e.key === CANONICAL_KEY && (e.target ?? []).includes("production"));
  check(
    `${CANONICAL_KEY} set in production`,
    canonical !== undefined,
    canonical ? "documented" : "MISSING",
  );

  console.log(`\n${passed}/${checks} checks passed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error("Vercel env guard crashed:", err);
  process.exitCode = 1;
});
