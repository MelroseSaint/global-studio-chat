#!/usr/bin/env node
/**
 * Convex backend drift check — production.
 *
 * The Vercel drift check (vercel-drift-check.mjs) pins the frontend to
 * main HEAD by comparing the live deployment's githubCommitSha. Convex
 * exposes no equivalent commit metadata to a deploy key, so the backend
 * records its own: `migrations.yml` runs `internal.deployStatus.recordDeploy`
 * with GITHUB_SHA right after every successful `convex deploy`, and this
 * script reads that back with `internal.deployStatus.getDeployedSha`
 * (via `npx convex run`, which a deploy key is allowed to do) and compares
 * it against main HEAD (GITHUB_SHA).
 *
 * If they match, the backend is in sync with the repo and nothing happens.
 * If they drift — a migrations deploy that silently failed, a dashboard
 * redeploy of an older commit, or a deploy that never happened — this
 * prints `drifted=true` and the workflow re-runs `convex deploy` (then
 * re-records the commit), so a silently failed migrations deploy can never
 * leave the backend behind the repo.
 *
 * No recorded commit yet (a backend that predates deployStatus, or a
 * manual deploy that bypassed migrations.yml) is treated as drift: the
 * commit cannot be verified, so the repo state wins by deploying.
 *
 * Prints `drifted=true|false` and, when $GITHUB_OUTPUT is set (CI), also
 * appends the same key so the workflow can gate a conditional deploy step.
 * Zero dependencies (global fetch, child_process, Node 18+). Needs
 * CONVEX_DEPLOY_KEY (the same secret the migrations workflow uses).
 * MAIN_SHA overrides GITHUB_SHA for local runs.
 *
 * Exit 0 in BOTH sync and drift states (drift is an action, not a
 * failure); exits nonzero only when the check itself errors, so an outage
 * can never trigger an accidental deploy.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY;
if (!DEPLOY_KEY) {
  console.error("::error::CONVEX_DEPLOY_KEY is not set");
  process.exit(1);
}
// Fail fast on a swapped secret — this repo once had a Cloudinary API
// secret stored here, which 401s identically to an outage and wastes a
// debugging cycle. A Convex deploy key is `<scope>:<deployment>|<payload>`.
if (!/^(prod|dev|preview):[a-z0-9-]+\|/.test(DEPLOY_KEY)) {
  console.error(
    "::error::CONVEX_DEPLOY_KEY does not look like a Convex deploy key (expected 'prod:<deployment>|<payload>'). It may be swapped with another service's secret. Generate one in the Convex dashboard: deployment settings → Deploy keys.",
  );
  process.exit(1);
}

// No explicit targeting: the deploy key self-targets its deployment, and a
// --deployment flag would override it and 401. An explicit flag is still
// honored for local, logged-in operator runs.
const deploymentFlagIndex = process.argv.indexOf("--deployment");
const DEPLOYMENT =
  deploymentFlagIndex >= 0 ? process.argv[deploymentFlagIndex + 1] : null;

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

/**
 * Read the recorded deploy commit from the live backend. Runs
 * `convex run internal.deployStatus.getDeployedSha` with the deploy key
 * and parses the JSON the CLI prints for the query result.
 *
 * Returns `{ sha }` on success, `{ unverifiable: true }` when the query
 * cannot be answered (function missing because the backend predates
 * deployStatus, or the CLI failed for a non-fatal reason) — callers treat
 * "cannot verify" as drift. Throws only on a hard failure (deploy key
 * rejected, CLI crash), which fails the check itself.
 */
const readDeployedSha = () => {
  try {
    // Spawn the CLI binary directly (not via npx): npx.cmd + execFileSync
    // hits EINVAL on Windows (spawn .cmd needs shell:true, which this must
    // not use). Same convexBinPath pattern as ensure-jwt-keys.mjs.
    const requireFromCwd = createRequire(join(process.cwd(), "package.json"));
    const packageJsonPath = requireFromCwd.resolve("convex/package.json");
    const convexBin = join(dirname(packageJsonPath), "bin", "main.js");
    const cliArgs = DEPLOYMENT
      ? [convexBin, "run", "internal.deployStatus.getDeployedSha", "--deployment", DEPLOYMENT]
      : [convexBin, "run", "internal.deployStatus.getDeployedSha"];
    const stdout = execFileSync(
      process.execPath,
      cliArgs,
      { env: { ...process.env, CONVEX_DEPLOY_KEY: DEPLOY_KEY }, encoding: "utf8" },
    );
    // Defensive extraction: take the last non-empty line, which is the
    // result JSON the CLI prints for a query. Ignore any earlier progress
    // or teardown noise a future CLI version might write to stdout, so a
    // cosmetic line can't fail the drift check.
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const out = lines[lines.length - 1] ?? "";
    // Null ledger: Linux prints the literal `null`; some Windows runs emit
    // nothing at all for it. Both mean "no deploy recorded" — drift.
    if (out === "null" || out === "") return { sha: null };
    const parsed = JSON.parse(out);
    // getDeployedSha returns a bare JSON string (the SHA), not an object
    // ({ sha }), so a string result IS the sha. A future shape change to
    // { sha } is also handled defensively.
    if (typeof parsed === "string") return { sha: parsed };
    if (parsed && typeof parsed === "object" && typeof parsed.sha === "string") {
      return { sha: parsed.sha };
    }
    return { sha: null };
  } catch (err) {
    const message = String(err?.stderr ?? err?.message ?? err);
    // "Could not find function" / "function ... not found" / "unknown
    // function" — the deployed backend predates deployStatus, so its
    // commit is unverifiable. That IS the drift signal this guard exists
    // for (a backend that was never deployed from the current code), so
    // treat it as drift and deploy to bring it to repo state — never as a
    // check error, which would silently skip the deploy.
    if (
      /could not find function|function.*not found|unknown function|no module named|unable to find|internal\.deployStatus/i.test(
        message,
      )
    ) {
      return { unverifiable: true, message: message.trim().slice(0, 300) };
    }
    throw new Error(`convex run failed: ${message.trim().slice(0, 500)}`);
  }
};

const main = () => {
  const { sha, unverifiable, message } = readDeployedSha();

  console.log(`main HEAD:      ${mainSha}`);
  if (unverifiable) {
    console.log(
      `live backend:   unverifiable (${message ?? "no deployStatus record"})`,
    );
    console.log(
      "DRIFT: the deployed backend commit cannot be verified — deploying to " +
        "force the repo state.",
    );
    emitDrifted(true);
    return;
  }
  console.log(`live backend:   ${sha ?? "(never recorded)"}`);

  // Full-SHA equality with a prefix fallback (both sides are normally the
  // full 40-char SHA; prefix tolerance keeps a truncated record safe).
  const inSync =
    sha !== null &&
    sha !== "" &&
    (sha === mainSha || mainSha.startsWith(sha) || sha.startsWith(mainSha));

  if (inSync) {
    console.log("Backend is in sync with main — no redeploy needed.");
    emitDrifted(false);
    return;
  }
  if (sha === null || sha === "") {
    console.log(
      "DRIFT: no recorded deploy commit (never recorded) — deploying to " +
        "establish the ledger.",
    );
  } else {
    console.log(
      "DRIFT: the deployed backend commit differs from main HEAD — deploying.",
    );
  }
  emitDrifted(true);
};

try {
  main();
} catch (err) {
  console.error("Convex drift check crashed:", err);
  process.exitCode = 1;
}
