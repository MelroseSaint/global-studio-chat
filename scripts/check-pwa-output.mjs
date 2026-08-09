#!/usr/bin/env node
/**
 * PureWire PWA build/live output guard.
 *
 * The service worker is the whole reason refreshes are fast and the app
 * opens offline: main.tsx registers /sw.js in production, and the Vite
 * precacheManifest plugin (vite.config.ts) emits BOTH /sw.js (rendered from
 * sw-template.js with the build version baked into the cache name) and
 * /precache-manifest.json (every hashed chunk the SW precaches at install).
 * If either silently goes missing — a deleted template, a plugin removed, a
 * deploy that fails to serve them — production 404s the SW and every refresh
 * falls back to the network while the PWA/offline story dies.
 *
 * Two modes:
 *   default     — check the BUILD OUTPUT (dist/): sw.js exists and is
 *                 rendered (no template marker), the manifest parses, the
 *                 sw.js cache name and manifest version agree, and every
 *                 manifest asset exists on disk.
 *   --live      — check the LIVE SITE (SITE_URL, default
 *                 https://purewire.vercel.app): /sw.js serves 200 real
 *                 JavaScript with a versioned cache name, the manifest is
 *                 valid with a matching version, and every manifest asset
 *                 serves its REAL content type — never the SPA shell (the
 *                 vercel.json catch-all used to mask missing /assets/* as
 *                 200 HTML, which would let the SW cache HTML under a JS URL).
 *
 * Usage:
 *   node scripts/check-pwa-output.mjs             # build output
 *   node scripts/check-pwa-output.mjs --live      # live site (SITE_URL env)
 * Exit codes: 0 = ok, 1 = broken.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(process.cwd(), "dist");
const SW_PATH = join(DIST, "sw.js");
const MANIFEST_PATH = join(DIST, "precache-manifest.json");
const LIVE = process.argv.includes("--live");
const SITE_URL = (process.env.SITE_URL ?? "https://purewire.vercel.app").replace(/\/+$/, "");

let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`  ❌ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

/** The version baked into a rendered sw.js cache name ("purewire-<version>"). */
function cacheVersion(swText) {
  return swText.match(/const CACHE = "purewire-([^"]+)"/)?.[1] ?? null;
}

async function runLiveChecks() {
  console.log(`PWA live-site guard (${SITE_URL}):`);
  const get = async (path) => {
    const res = await fetch(SITE_URL + path);
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      text: await res.text(),
    };
  };

  const sw = await get("/sw.js");
  if (sw.status !== 200) {
    fail(`/sw.js returned ${sw.status} — production registers /sw.js, so every load 404s it`);
  } else if (!sw.type.includes("javascript")) {
    fail(`/sw.js served as "${sw.type}", not JavaScript`);
  } else {
    ok("/sw.js serves 200 application/javascript");
  }
  if (sw.text.includes("__PUREWIRE_CACHE__")) {
    fail("live /sw.js still contains the __PUREWIRE_CACHE__ template marker — an unrendered template was deployed");
  }
  const swVersion = cacheVersion(sw.text);
  if (swVersion === null) {
    fail("live /sw.js has no versioned cache name — the SW cannot version/purge its cache per deploy");
  } else {
    ok(`live sw.js cache name "purewire-${swVersion}"`);
  }

  const man = await get("/precache-manifest.json");
  let manifest = null;
  if (man.status !== 200) {
    fail(`/precache-manifest.json returned ${man.status}`);
  } else {
    ok("/precache-manifest.json serves 200");
    try {
      manifest = JSON.parse(man.text);
      ok("manifest parses");
    } catch {
      fail("manifest is not valid JSON");
    }
  }

  if (manifest && swVersion !== null) {
    if (manifest.version === swVersion) {
      ok(`sw.js cache name and manifest version agree ("${swVersion}")`);
    } else {
      fail(
        `cache name "${swVersion}" ≠ manifest version "${manifest.version}" — install would precache and purge different caches`,
      );
    }
  }

  // Every manifest asset must come back as REAL JS/CSS. The vercel.json
  // catch-all used to rewrite missing /assets/* to the SPA shell (200
  // HTML), which a stale lazy import would try to parse and the SW would
  // cache under a JS URL — this asserts the 404-hardening holds live.
  if (manifest && Array.isArray(manifest.assets)) {
    const bad = [];
    const batch = manifest.assets.length;
    for (let i = 0; i < manifest.assets.length; i += 10) {
      const slice = manifest.assets.slice(i, i + 10);
      const results = await Promise.all(
        slice.map(async (a) => {
          const res = await fetch(SITE_URL + a, { method: "HEAD" });
          const ct = res.headers.get("content-type") ?? "";
          const realType = a.endsWith(".css")
            ? ct.includes("css")
            : ct.includes("javascript");
          return res.status === 200 && realType ? null : `${a} -> ${res.status} ${ct}`;
        }),
      );
      for (const r of results) if (r) bad.push(r);
    }
    if (bad.length > 0) {
      fail(
        `${bad.length}/${batch} manifest assets not served as real content: ${bad
          .slice(0, 5)
          .join(", ")}${bad.length > 5 ? ` … (+${bad.length - 5})` : ""}`,
      );
    } else {
      ok(`all ${batch} manifest assets serve real JS/CSS (no SPA-shell fallback)`);
    }
  }
}

function runLocalChecks() {
  console.log("PWA build-output guard:");

  if (!existsSync(SW_PATH)) {
    fail("dist/sw.js is missing — main.tsx registers /sw.js in production, so the app 404s it on every load");
  } else {
    const sw = readFileSync(SW_PATH, "utf8");
    if (sw.includes("__PUREWIRE_CACHE__")) {
      fail("dist/sw.js still contains the __PUREWIRE_CACHE__ template marker — the precacheManifest plugin did not render it");
    }
    const swVersion = cacheVersion(sw);
    if (swVersion === null) {
      fail("dist/sw.js has no versioned cache name — the SW cannot version/purge its cache per deploy");
    } else {
      ok(`sw.js present with versioned cache name "purewire-${swVersion}"`);
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

  const swVersion = existsSync(SW_PATH) ? cacheVersion(readFileSync(SW_PATH, "utf8")) : null;
  if (manifest && swVersion !== null) {
    if (swVersion === manifest.version) {
      ok(`sw.js cache name and manifest version agree ("${swVersion}")`);
    } else {
      fail(
        `cache name "${swVersion}" ≠ manifest version "${manifest.version}" — install would precache and purge different caches`,
      );
    }
  }
}

if (LIVE) {
  await runLiveChecks();
  // Undici's global dispatcher holds keep-alive sockets after the fetches;
  // close them so the process can exit on its own. process.exit() while
  // those sockets are tearing down can trip a libuv assertion on Windows
  // and mask the real exit code.
  try {
    const dispatcher = globalThis[Symbol.for("undici.globalDispatcher.1")];
    if (dispatcher && typeof dispatcher.close === "function") {
      await dispatcher.close();
    }
  } catch {
    /* best-effort — the process still exits with the right code */
  }
} else {
  runLocalChecks();
}

console.log(failed ? "\nPWA outputs BROKEN." : "\nPWA outputs OK.");
process.exitCode = failed ? 1 : 0;
