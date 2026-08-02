#!/usr/bin/env node
/**
 * PureWire — arm the Cloudflare Turnstile bot gate in one shot.
 *
 * Reads the two keys from the ENVIRONMENT (never argv, so the values you
 * type don't sit in this script's own args). They are then passed to the
 * CLI tools as arguments — the documented Convex/Vercel pattern — which
 * briefly exposes them in the child process's command line, and typing
 * them inline on the run line will put them in your shell history. Use a
 * history-safe shell or a temp env file if that matters on your machine.
 *
 *   TURNSTILE_SITE_KEY     public site key   (starts with "0x…")
 *   TURNSTILE_SECRET_KEY   private secret    (starts with "0x…")
 *   VERCEL_TOKEN           optional — mirrors the site key into the Vercel
 *                          project env when set
 *
 * Writes:
 *   1. .env.production  -> VITE_TURNSTILE_SITE_KEY (public; baked into the
 *      client bundle, so committing it is safe — the comment in that file
 *      explains why).
 *   2. Convex env       -> TURNSTILE_SECRET_KEY via `npx convex env set`
 *      (targets whatever deployment .env.local's CONVEX_DEPLOYMENT selects).
 *   3. Vercel env       -> VITE_TURNSTILE_SITE_KEY (Production) so Vercel
 *      builds bake the key in too.
 *
 * The secret key is never written to any file — it goes straight to Convex.
 *
 * Run:
 *   TURNSTILE_SITE_KEY=0x… TURNSTILE_SECRET_KEY=0x… npm run turnstile:keys
 *
 * Then deploy the rebuild:
 *   npm run upload:version   (rebuild + push the frontend to static hosting)
 *   npx vercel --prod        (rebuild + deploy the Vercel frontend)
 *
 * Exit codes: 0 done, 1 a missing/invalid key or a failed step.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.production");

const SITE_KEY = process.env.TURNSTILE_SITE_KEY ?? "";
const SECRET_KEY = process.env.TURNSTILE_SECRET_KEY ?? "";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? "";

const looksLikeKey = (k) => /^0x[0-9a-fA-F]{16,}$/.test(k);

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

if (!SITE_KEY) fail("TURNSTILE_SITE_KEY is not set");
if (!SECRET_KEY) fail("TURNSTILE_SECRET_KEY is not set");
if (!looksLikeKey(SITE_KEY)) fail("TURNSTILE_SITE_KEY does not look like a Turnstile key (0x…)");
if (!looksLikeKey(SECRET_KEY)) fail("TURNSTILE_SECRET_KEY does not look like a Turnstile key (0x…)");

console.log("\nPureWire — arming the Turnstile bot gate\n");

// ── 1. .env.production: bake the PUBLIC site key into the client build ─────
{
  const env = readFileSync(ENV_FILE, "utf8");
  const line = "VITE_TURNSTILE_SITE_KEY=";
  if (!env.includes(line)) fail(`${ENV_FILE} is missing the VITE_TURNSTILE_SITE_KEY= line`);
  const next = env.replace(
    /^(VITE_TURNSTILE_SITE_KEY=)[^\r]*$/m,
    (_all, prefix) => `${prefix}${SITE_KEY}`,
  );
  writeFileSync(ENV_FILE, next);
  console.log(`  ✅ .env.production: VITE_TURNSTILE_SITE_KEY set (public key)`);
}

// ── 2. Convex env: the SECRET key (server-side verify) ─────────────────────
{
  try {
    execSync(`npx convex env set TURNSTILE_SECRET_KEY ${SECRET_KEY}`, {
      cwd: ROOT,
      stdio: "inherit",
    });
    console.log(`  ✅ Convex env: TURNSTILE_SECRET_KEY set (secret key)`);
  } catch {
    fail("convex env set failed — see output above");
  }
}

// ── 3. Vercel env: mirror the site key so Vercel builds bake it in too ─────
if (VERCEL_TOKEN) {
  try {
    execSync(
      `echo "${SITE_KEY}" | npx vercel env add VITE_TURNSTILE_SITE_KEY production --token ${VERCEL_TOKEN}`,
      { cwd: ROOT, stdio: "inherit" },
    );
    console.log(`  ✅ Vercel env: VITE_TURNSTILE_SITE_KEY (Production) set`);
  } catch {
    fail("vercel env add failed — see output above (or set the key in the Vercel dashboard)");
  }
} else {
  console.log(
    `  ⏭️  VERCEL_TOKEN not set — add VITE_TURNSTILE_SITE_KEY manually in the Vercel dashboard (Settings → Environment Variables → Production)`,
  );
}

console.log("\nKeys are set. Deploy the rebuild so the widget goes live:\n");
console.log("  npm run upload:version");
console.log("  npx vercel --prod");
console.log("\nThen confirm the gate engages (QA detects active vs inactive):");
console.log("  npm run qa:signup-e2e");
console.log("");
