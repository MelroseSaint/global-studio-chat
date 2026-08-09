#!/usr/bin/env node
/**
 * PureWire PWA build-output guard.
 *
 * The service worker is the whole reason refreshes are fast and the app
 * opens offline: main.tsx registers /sw.js in production, and the Vite
 * precacheManifest plugin (vite.config.ts) emits BOTH /sw.js (rendered from
 * sw-template.js with the build version baked into the cache name) and
 * /precache-manifest.json (every hashed chunk the SW precaches at install).
 * If either silently goes missing from the build — a deleted template, a
 * plugin removed, a build config change that stops emitting them — the
 * production app still registers /sw.js, gets a 404, and every refresh
 * falls back to the network while the PWA/offline story dies. This guard
 * fails the build instead of shipping that.
 *
 * Checks:
 *   1. dist/sw.js exists and is a RENDERED service worker — the template
 *      marker (__PUREWIRE_CACHE__) must be replaced with the build version.
 *   2. dist/precache-manifest.json exists, parses, and carries a version
 *      that EXACTLY matches the cache name baked into sw.js — a mismatch
 *      means the SW would precache under one version and purge another.
 *   3. Every asset the manifest lists exists on disk — the SW precaches
 *      them all at install, so a listed-but-missing chunk silently breaks
 *      offline + first-refresh fast loads.
 *
 * Usage: node scripts/check-pwa-output.mjs   (exit 0 ok, 1 broken dist)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(process.cwd(), "dist");
const SW_PATH = join(DIST, "sw.js");
const MANIFEST_PATH = join(DIST, "precache-manifest.json");

let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`  ❌ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log("PWA build-output guard:");

if (!existsSync(SW_PATH)) {
  fail("dist/sw.js is missing — main.tsx registers /sw.js in production, so the app 404s it on every load");
} else {
  const sw = readFileSync(SW_PATH, "utf8");
  const marker = sw.includes("__PUREWIRE_CACHE__");
  const cacheMatch = sw.match(/const CACHE = "([^"]+)"/);
  if (marker) {
    fail("dist/sw.js still contains the __PUREWIRE_CACHE__ template marker — the precacheManifest plugin did not render it");
  }
  if (!cacheMatch) {
    fail("dist/sw.js has no versioned cache name — the SW cannot version/purge its cache per deploy");
  } else {
    ok(`sw.js present with versioned cache name "${cacheMatch[1]}"`);
  }
}

let manifest = null;
if (!existsSync(MANIFEST_PATH)) {
  fail("dist/precache-manifest.json is missing — the SW precaches every chunk from it at install");
} else {
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    ok("precache-manifest.json present and parses");
  } catch {
    fail("dist/precache-manifest.json is not valid JSON");
  }
}

if (manifest) {
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    fail("precache-manifest.json has no version — the SW cache name cannot be validated");
  } else {
    ok(`manifest version "${manifest.version}"`);
  }
  if (!Array.isArray(manifest.assets)) {
    fail("precache-manifest.json has no assets array");
  } else {
    const missing = manifest.assets.filter((a) => !existsSync(join(DIST, a.replace(/^\//, ""))));
    if (missing.length > 0) {
      fail(
        `${missing.length} manifest asset${missing.length === 1 ? "" : "s"} missing on disk: ${missing
          .slice(0, 5)
          .join(", ")}${missing.length > 5 ? ` … (+${missing.length - 5})` : ""}`,
      );
    } else {
      ok(`${manifest.assets.length} manifest assets all present on disk`);
    }
  }
}

// Cross-check: the SW's cache name and the manifest version must agree —
// otherwise the SW precaches under one version and purges another on
// activate, defeating the per-deploy cache rotation.
const swCache = existsSync(SW_PATH)
  ? readFileSync(SW_PATH, "utf8").match(/const CACHE = "purewire-([^"]+)"/)
  : null;
if (manifest && swCache) {
  if (swCache[1] === manifest.version) {
    ok(`sw.js cache name and manifest version agree ("${manifest.version}")`);
  } else {
    fail(
      `cache name "${swCache[1]}" ≠ manifest version "${manifest.version}" — install would precache and purge different caches`,
    );
  }
}

console.log(failed ? "\nPWA build outputs BROKEN." : "\nPWA build outputs OK.");
process.exit(failed ? 1 : 0);
