#!/usr/bin/env node
/**
 * Vercel drift check — production.
 *
 * Nightly job (redeploy-drift.yml): compare the commit currently LIVE on
 * production — the newest READY production deployment's githubCommitSha —
 * against the repo's main HEAD (GITHUB_SHA). If they match, the repo and
 * the live site are in sync and nothing happens. If they drift — a manual
 * dashboard redeploy of an older commit, a push deploy that silently
 * failed, or a deploy that never happened — this prints `drifted=true`
 * and the workflow redeploys from the repo, so the canonical host + env
 * state can never silently lag the repo.
 *
 * Prints `drifted=true|false` and, when $GITHUB_OUTPUT is set (CI), also
 * appends the same key so the workflow can gate a conditional redeploy
 * step. Zero dependencies. Needs VERCEL_TOKEN (the same secret the Deploy
 * workflow uses); project/team come from .vercel/project.json unless
 * overridden. MAIN_SHA overrides GITHUB_SHA for local runs.
 *
 * Exit 0 in BOTH sync and drift states (drift is an action, not a
 * failure); exits nonzero only when the check itself errors, so an API
 * outage can never trigger an accidental redeploy.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = process.env.VERCEL_TOKEN;
if (!TOKEN) {
  console.error("::error::VERCEL_TOKEN is not set");
  process.exit(1);
}

let projectId = process.env.VERCEL_PROJECT_ID;
let teamId = process.env.VERCEL_TEAM_ID;
if (!projectId || !teamId) {
  const cfg = JSON.parse(
    readFileSync(join(process.cwd(), ".vercel", "project.json"), "utf8"),
  );
  projectId = projectId ?? cfg.projectId;
  teamId = teamId ?? cfg.orgId;
}

const mainSha = (process.env.GITHUB_SHA ?? process.env.MAIN_SHA ?? "").toLowerCase();
if (!mainSha) {
  console.error("::error::GITHUB_SHA is not set — nothing to compare against");
  process.exit(1);
}

const emitDrifted = (drifted) => {
  console.log(`drifted=${drifted}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `drifted=${drifted}\n`);
  }
};

const api = async (path) => {
  const res = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Vercel API ${res.status} for ${path}`);
  }
  return res.json();
};

const main = async () => {
  const body = await api(
    `/v6/deployments?projectId=${projectId}&teamId=${teamId}` +
      "&target=production&limit=20",
  );
  const deployments = (body.deployments ?? [])
    .slice()
    .sort((a, b) => b.created - a.created);

  // The LIVE commit is the newest deployment that actually finished
  // building (what's serving traffic), not the newest-created one, which
  // could still be mid-build.
  const live = deployments.find((d) => d.readyState === "READY") ?? deployments[0];

  if (!live) {
    console.log(
      "No production deployment found — the site has never been deployed.",
    );
    emitDrifted(true);
    return;
  }

  const liveSha = (live.meta?.githubCommitSha ?? "").toLowerCase();
  // Full-SHA equality with a prefix fallback (both sides are normally the
  // full 40-char SHA; prefix tolerance keeps a truncated meta safe).
  const inSync =
    liveSha !== "" &&
    (liveSha === mainSha ||
      mainSha.startsWith(liveSha) ||
      liveSha.startsWith(mainSha));

  console.log(`main HEAD:     ${mainSha}`);
  console.log(
    `live commit:   ${liveSha || "(unknown — no githubCommitSha meta)"}`,
  );
  console.log(
    `deployment:    ${live.uid} (${live.url ?? ""}) readyState=${live.readyState}`,
  );

  if (inSync) {
    console.log("Production is in sync with main — no redeploy needed.");
    emitDrifted(false);
    return;
  }
  if (liveSha === "") {
    // Conservative by design: an unverifiable deployment (e.g. deployed
    // from the dashboard without git metadata) is treated as drift and
    // redeployed so the repo state always wins. Called out explicitly so
    // an operator isn't confused by a redeploy when the SHAs "look" fine.
    console.log(
      "DRIFT: the live deployment has no githubCommitSha meta, so its commit " +
        "cannot be verified — redeploying to force the repo state.",
    );
  } else {
    console.log(
      "DRIFT: the live production commit differs from main HEAD — redeploying.",
    );
  }
  emitDrifted(true);
};

main().catch((err) => {
  console.error("Vercel drift check crashed:", err);
  process.exitCode = 1;
});
