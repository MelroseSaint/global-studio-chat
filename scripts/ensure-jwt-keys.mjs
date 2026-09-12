#!/usr/bin/env node
/**
 * Ensure the @convex-dev/auth JWT keys exist on the target deployment.
 *
 * A FRESH Convex deployment has no JWT_PRIVATE_KEY / JWKS. The auth library
 * normally provisions them through its interactive CLI wizard, which never
 * runs in `convex deploy` — so a newly created deployment silently rejects
 * every sign-in with a masked "Missing environment variable `JWT_PRIVATE_KEY`
 * → Server Error" (this actually happened when the production deployment was
 * recreated on 2026-09-11). This script closes that hole: run it before any
 * `convex deploy` and the deployment is guaranteed to be able to mint
 * sessions.
 *
 * Behaviour per state:
 *   both keys present                  → no-op (never rotates: rotation
 *                                        invalidates issued access tokens)
 *   private key missing, JWKS present  → FAILS. A private key cannot be
 *                                        derived from a public one; an
 *                                        operator must deliberately rotate
 *                                        (remove JWKS, re-run this script).
 *   private key present, JWKS missing  → self-heals: derives the public JWK
 *                                        from the existing private key, so
 *                                        no rotation is needed.
 *   both missing                       → generates an RS256 keypair and sets
 *                                        both vars — byte-identical to what
 *                                        @convex-dev/auth's own generateKeys
 *                                        produces (PKCS8 with newlines
 *                                        collapsed to spaces + a JWKS doc).
 *
 * Deployment targeting (first match wins):
 *   --deployment <name>   explicit deployment name
 *   --env-file <path>     file with CONVEX_DEPLOYMENT=<name>
 *   CONVEX_DEPLOYMENT     environment variable
 *   (nothing)             the CLI's default selection — how CI authenticates
 *                         with CONVEX_DEPLOY_KEY.
 *
 * Usage:
 *   node scripts/ensure-jwt-keys.mjs [--deployment <name>] [--env-file <path>]
 *
 * The CLI is driven through SYNCHRONOUS spawns of the local convex binary —
 * the same pattern as scripts/upload-static-sync.mjs, which works around the
 * Windows + Node 25 libuv teardown crash (UV_HANDLE_CLOSING) in the CLI's
 * async execFile path.
 *
 * Exit codes: 0 = keys present or provisioned, 1 = failure.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const requireFromCwd = createRequire(join(process.cwd(), "package.json"));

function convexBinPath() {
  const packageJsonPath = requireFromCwd.resolve("convex/package.json");
  return join(dirname(packageJsonPath), "bin", "main.js");
}

/** Parse --deployment / --env-file flags and the env fallback. */
function deploymentArgs() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const deployment = get("--deployment") ?? process.env.CONVEX_DEPLOYMENT;
  const envFile = get("--env-file");
  if (deployment) return ["--deployment", deployment];
  if (envFile) {
    if (existsSync(envFile)) {
      const line = readFileSync(envFile, "utf8")
        .split("\n")
        .find((l) => l.startsWith("CONVEX_DEPLOYMENT="));
      if (line) return ["--deployment", line.split("=")[1].trim()];
    }
    return ["--env-file", envFile];
  }
  // Default to the production deployment explicitly: implicit targeting is
  // rejected outright by a deployment-scoped deploy key ("Please set
  // CONVEX_DEPLOY_KEY…") and would otherwise fall back to a local dev
  // deployment, which is never what an operator run means.
  return ["--deployment", "jovial-axolotl-209"];
}

/** Run the local convex CLI synchronously; returns { ok, stdout, stderr }. */
function runCli(args, { timeoutMs = 120_000 } = {}) {
  const res = spawnSync(
    process.execPath,
    [convexBinPath(), ...args],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs },
  );
  // The Windows libuv teardown crash can abort the child AFTER it produced
  // usable output — trust stdout when it looks complete.
  const crashed = res.status === null || res.status === 3221226505;
  if (res.stdout && res.stdout.trim().length > 0 && crashed) {
    return { ok: true, stdout: res.stdout, stderr: res.stderr ?? "" };
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Read one deployment env var via `convex env get`.
 *
 * CLI contract (verified): the VALUE goes to stdout; a missing variable is
 * reported as "✖ Environment variable \"NAME\" not found" on STDERR with
 * EXIT CODE 0. So exit status alone cannot distinguish present from absent —
 * classify on the output instead: non-empty stdout = present (returns the
 * value), "not found" on stderr = absent, anything else = a real failure
 * (auth, network) that must not be mistaken for absence.
 */
function envGet(deployment, name) {
  const res = runCli(["env", "get", ...deployment, name]);
  const out = (res.stdout ?? "").trim();
  const err = (res.stderr ?? "").trim();
  if (out.length > 0) return { exists: true, value: out };
  if (/not found/i.test(err)) return { exists: false };
  if (!res.ok) {
    throw new Error(`convex env get ${name} failed: ${err || "no output"}`);
  }
  // Exit 0, empty stdout, no "not found" — treat as absent but surface the
  // stderr in case the CLI changes shape again.
  console.warn(`ensure-jwt-keys: ${name} lookup returned nothing (${err || "empty"}) — treating as absent.`);
  return { exists: false };
}

async function envSet(deployment, name, value) {
  // The value ordering matters: option flags FIRST, then `--`, then
  // name value — a PKCS8 PEM starts with "-----BEGIN" and commander
  // would otherwise parse it as an unknown option.
  const res = runCli([
    "env",
    "set",
    ...deployment,
    "--",
    name,
    value,
  ]);
  if (!res.ok) {
    throw new Error(`convex env set ${name} failed: ${res.stderr || res.stdout}`);
  }
}

/** The deployment-scoped-key refusal shape for env metadata reads. */
function authMetadataBlocked(err) {
  return /MissingAccessToken|team_and_project/i.test(String(err?.message ?? err));
}

/**
 * Presence of JWT_PRIVATE_KEY / JWKS. Normally read via `env get`, but a
 * deployment-scoped deploy key can be refused on that endpoint in some
 * environments ("team_and_project … MissingAccessToken") even though `env
 * set`, `run`, and `deploy` all work with the same key. Fall back to the
 * PUBLIC status:authPreflight query, which reports exactly these two vars.
 */
async function keyPresence(deployment) {
  try {
    return {
      priv: envGet(deployment, "JWT_PRIVATE_KEY"),
      jwks: envGet(deployment, "JWKS"),
    };
  } catch (err) {
    if (!authMetadataBlocked(err)) throw err;
    console.warn(
      "ensure-jwt-keys: env get refused for this key (metadata endpoint needs " +
        "a user token) — falling back to the public auth preflight.",
    );
    const res = runCli(["run", "status:authPreflight", ...deployment]);
    if (!res.ok) {
      throw new Error(`status:authPreflight failed: ${res.stderr || res.stdout}`);
    }
    const lastLine = (res.stdout ?? "").split(/\r?\n/).filter((l) => l.trim()).pop() ?? "";
    let parsed;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      throw new Error(`auth preflight returned unparseable output: ${lastLine.slice(0, 200)}`);
    }
    const missing = new Set(parsed?.missing ?? []);
    return {
      priv: { exists: !missing.has("JWT_PRIVATE_KEY") },
      jwks: { exists: !missing.has("JWKS") },
    };
  }
}

async function main() {
  const deployment = deploymentArgs();
  const where = deployment.includes("--deployment")
    ? deployment[1]
    : "default deployment";
  console.log(`ensure-jwt-keys: targeting ${where}`);

  const { priv, jwks: jwksExisting } = await keyPresence(deployment);
  const hasPriv = priv.exists;
  const hasJwks = jwksExisting.exists;

  if (hasPriv && hasJwks) {
    console.log("ensure-jwt-keys: JWT_PRIVATE_KEY and JWKS are set — nothing to do.");
    return;
  }

  if (!hasPriv && hasJwks) {
    console.error(
      "ensure-jwt-keys: REFUSING to proceed — JWKS exists but JWT_PRIVATE_KEY is\n" +
        "missing. A private key cannot be derived from its public half. If you\n" +
        "deliberately want to ROTATE the key pair, remove JWKS first:\n" +
        "  npx convex env remove JWKS --deployment <name>\n" +
        "then re-run this script to provision a fresh pair.",
    );
    process.exit(1);
  }

  const { generateKeyPair, exportPKCS8, exportJWK, importPKCS8 } = await import(
    "jose"
  );

  if (hasPriv && !hasJwks) {
    // Self-heal: derive the matching JWKS from the private key we already
    // fetched, so no rotation is needed. The stored value is a single line
    // (newlines became spaces), where header-word spaces and line-separator
    // spaces are indistinguishable — so rebuild a canonical PEM instead of
    // trying to reconstruct the original line breaks: strip the armor,
    // drop all whitespace from the base64 body, re-wrap at 64 chars.
    // Armor literals only — structural markers, not key material
    // (secrets-scan:ignore on each line for exactly that reason).
    const body = priv.value
      .replace(/-----BEGIN PRIVATE KEY-----/, "") // secrets-scan:ignore
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, "");
    const wrapped = (body.match(/.{1,64}/g) ?? []).join("\n");
    // secrets-scan:ignore — armor template, no key material
    const pem = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`; // secrets-scan:ignore
    const privKey = await importPKCS8(pem, "RS256");
    const jwk = await exportJWK(privKey);
    const jwks = JSON.stringify({ keys: [{ use: "sig", ...jwk }] });
    await envSet(deployment, "JWKS", jwks);
    console.log("ensure-jwt-keys: derived and set JWKS from the existing JWT_PRIVATE_KEY.");
    return;
  }

  // Both missing — provision a fresh pair, byte-identical in shape to
  // @convex-dev/auth's own generateKeys().
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pem = (await exportPKCS8(privateKey)).trimEnd().replace(/\n/g, " ");
  const jwk = await exportJWK(publicKey);
  const jwks = JSON.stringify({ keys: [{ use: "sig", ...jwk }] });
  await envSet(deployment, "JWT_PRIVATE_KEY", pem);
  await envSet(deployment, "JWKS", jwks);
  console.log(
    "ensure-jwt-keys: provisioned JWT_PRIVATE_KEY + JWKS — sign-in can mint sessions.",
  );
}

main().catch((err) => {
  console.error(`ensure-jwt-keys: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
