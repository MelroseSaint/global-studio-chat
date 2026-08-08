#!/usr/bin/env node
/**
 * Vercel build-log warning guard — production and preview.
 *
 * The env guard (vercel-env-guard.mjs) proves the stale VITE_SITE_URL var
 * is absent from the dashboard — but a dashboard edit between runs can
 * re-add it, and the only place its damage shows up is the Vercel BUILD
 * LOG, where vite.config.ts's siteUrl() plugin prints
 *
 *   [purewire-site-url] VITE_SITE_URL is set but ignored — ...
 *
 * This guard is the log-level twin of the env guard: it watches the
 * actual deployment for the current commit (found by git SHA, or the
 * newest deployment of the last 20 minutes), waits for the build to
 * finish, fetches the deployment's build events, and fails if
 * `VITE_SITE_URL is set but ignored` or ANY other `[purewire-site-url]`
 * warning appears. A warning in the build log means the shipped bundle
 * carries the wrong canonical host — the exact defect that originally
 * shipped the Convex host in the OG tags.
 *
 * Which target to inspect is set with VERCEL_TARGET: `production`
 * (default) or `preview`. Preview builds share vite.config.ts and the
 * dashboard env — a stale VITE_SITE_URL var sitting in the preview
 * environment prints the same warning there, so the healthcheck runs this
 * guard once per target.
 *
 * Zero dependencies (global fetch, Node 18+). Needs VERCEL_TOKEN (the
 * same secret the Deploy workflow uses). Project/team come from
 * .vercel/project.json unless overridden. GITHUB_SHA (set by Actions)
 * selects the deployment to inspect. Exit 0 = build log is warning-free.
 */
import { readFileSync } from "node:fs";
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

const TARGET = (process.env.VERCEL_TARGET ?? "production").toLowerCase();
if (TARGET !== "production" && TARGET !== "preview") {
  console.error(
    `::error::VERCEL_TARGET must be "production" or "preview", got "${TARGET}"`,
  );
  process.exit(1);
}

const SHA = (process.env.GITHUB_SHA ?? "").toLowerCase();
const RECENT_WINDOW_MS = 20 * 60 * 1000; // fallback: only inspect a fresh deploy
// Production: a push is followed by a deploy within seconds, so a 2-min wait
// covers the race. Preview: a push to main never creates a preview deploy,
// so a long SHA wait would just burn CI time before SKIPping — 45s bounds
// the cost while still catching a preview deploy that is mid-creation.
const FIND_POLL_MS = TARGET === "production" ? 2 * 60 * 1000 : 45 * 1000;
const READY_POLL_MS = 10 * 60 * 1000; // how long to wait for the build to finish
const POLL_INTERVAL_MS = 15 * 1000;

// The siteUrl() plugin prefixes every warning with `[purewire-site-url]`;
// the stale-var text is matched explicitly so a format drift in the prefix
// can never silently disable the guard.
const WARN_PATTERNS = [
  "VITE_SITE_URL is set but ignored",
  "[purewire-site-url]",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const api = async (path) => {
  const res = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Vercel API ${res.status} for ${path}`);
  }
  return res.json();
};

const listDeployments = async () => {
  const body = await api(
    `/v6/deployments?projectId=${projectId}&teamId=${teamId}` +
      `&target=${TARGET}&limit=20`,
  );
  return body.deployments ?? [];
};

const getDeployment = async (uid) => {
  const body = await api(`/v13/deployments/${uid}?teamId=${teamId}`);
  return body;
};

const fetchEvents = async (uid) => {
  // The build log streams as events whose text lives in `payload.text`
  // (the events endpoint returns a bare array, not an object wrapper).
  // One page of 1000 is more than any of this app's builds emit (~80
  // events) — a multi-page loop would add an unverified pagination path
  // that could only crash the scan on a longer build.
  const body = await api(`/v2/deployments/${uid}/events?limit=1000&direction=forward`);
  return Array.isArray(body) ? body : body.events ?? [];
};

const findDeployment = async () => {
  const deadline = Date.now() + FIND_POLL_MS;
  let recentFallback = null;
  while (Date.now() < deadline) {
    const list = listDeploymentsSortedByCreatedDesc(await listDeployments());
    if (SHA) {
      const bySha = list.find(
        (d) => (d.meta?.githubCommitSha ?? "").toLowerCase().startsWith(SHA),
      );
      if (bySha) return bySha;
    }
    // Remember the newest deploy within the recent window as a fallback
    // for the nightly/manual runs, where GITHUB_SHA may not be deployed.
    recentFallback =
      recentFallback ??
      list.find((d) => Date.now() - d.created < RECENT_WINDOW_MS) ??
      null;
    // Without a SHA there is nothing to wait for — take the fallback as
    // soon as a fresh deploy shows up instead of polling out the window.
    if (!SHA && recentFallback) return recentFallback;
    await sleep(POLL_INTERVAL_MS);
  }
  return recentFallback;
};

const listDeploymentsSortedByCreatedDesc = (list) =>
  [...list].sort((a, b) => b.created - a.created);

const main = async () => {
  const deployment = await findDeployment();
  if (!deployment) {
    console.log(
      `SKIP no ${TARGET} deployment for this SHA or within the last 20 minutes ` +
        "(nothing new to inspect) — nothing to check.",
    );
    return;
  }

  console.log(
    `Deployment ${deployment.uid} (${deployment.url ?? ""}) for commit ` +
      `${deployment.meta?.githubCommitSha ?? "?"} — ` +
      `waiting for the build to finish (readyState=${deployment.readyState})…`,
  );

  // Wait for the build to reach a terminal state so the log is complete.
  let readyState = deployment.readyState;
  const readyDeadline = Date.now() + READY_POLL_MS;
  while (!["READY", "ERROR", "CANCELED", "ERRORED"].includes(readyState)) {
    if (Date.now() > readyDeadline) {
      console.error(
        `::error::deployment ${deployment.uid} never reached a terminal state ` +
          `(still ${readyState} after ${Math.round(READY_POLL_MS / 60000)} min)`,
      );
      process.exitCode = 1;
      return;
    }
    await sleep(POLL_INTERVAL_MS);
    readyState = (await getDeployment(deployment.uid)).readyState;
  }

  if (readyState !== "READY") {
    // Production: a failed build ships nothing and is itself alarming, so
    // keep failing loudly. Preview: builds get canceled/errored routinely
    // (WIP branches, forced cancels) with no relation to the canonical
    // host — treat that as a skip, not a warning-alert, so preview noise
    // can't masquerade as a VITE_SITE_URL regression.
    if (TARGET === "preview") {
      console.log(
        `SKIP preview deployment ${deployment.uid} ended ${readyState} ` +
          "(canceled/failed build, nothing to scan) — nothing to check.",
      );
      return;
    }
    console.error(
      `::error::deployment ${deployment.uid} build failed (readyState=${readyState})`,
    );
    process.exitCode = 1;
    return;
  }

  // Scan the build log for the siteUrl() plugin's warnings.
  const events = await fetchEvents(deployment.uid);
  const hits = events
    .map((e) => e.payload?.text ?? e.text ?? "")
    .filter((text) => WARN_PATTERNS.some((p) => text.includes(p)));

  console.log(`Build log scanned: ${events.length} events, ${hits.length} warning(s).`);
  if (hits.length > 0) {
    for (const hit of hits) {
      console.error(`::error::[purewire-site-url] warning in ${TARGET} build log:`);
      console.error(hit.trim().slice(0, 500));
    }
    console.error(
      "::error::a purewire-site-url warning means the stale VITE_SITE_URL var " +
        "reappeared or the canonical-host plugin is misconfigured — check the " +
        "Vercel project env and remove VITE_SITE_URL from every environment.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS ${TARGET} build log is free of purewire-site-url warnings ` +
      `(deployment ${deployment.uid}).`,
  );
};

main().catch((err) => {
  console.error("Vercel build-warning guard crashed:", err);
  process.exitCode = 1;
});
