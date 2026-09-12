#!/usr/bin/env node
/**
 * PureWire static-site uploader (synchronous).
 *
 * Mirrors `npx @convex-dev/static-hosting upload` exactly — getUrls →
 * generateUploadUrls → POST each file → stageAssets → publishDeployment —
 * but drives the Convex CLI through *synchronous* child processes
 * (spawnSync). The published CLI's async execFile path crashes on Windows
 * with Node v25 (libuv `UV_HANDLE_CLOSING` assertion, exit 0xC0000409),
 * while sync spawns are rock solid.
 *
 * Usage (from the repo root, after `npm run build`):
 *
 *   node scripts/upload-static-sync.mjs [--dist dist] [--prod]
 *
 * Flags: --dist <path> (default ./dist), --prod (deploy to production),
 * --component <name> (default staticHosting), --no-spa (disable SPA
 * fallback).
 * Exit codes: 0 = published, 1 = failure.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromCwd = createRequire(join(process.cwd(), "package.json"));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
};

const MAX_CONVEX_ARGUMENT_BYTES = 20 * 1024;
const UPLOAD_URL_BATCH_SIZE = 100;

function convexBinPath() {
  const packageJsonPath = requireFromCwd.resolve("convex/package.json");
  return join(dirname(packageJsonPath), "bin", "main.js");
}

// Windows + Node 25 libuv teardown race: the child process sometimes aborts
// with 0xC0000409 (3221226505) AFTER producing its output (an
// `UV_HANDLE_CLOSING` assertion during exit). The call itself succeeded —
// the JSON is usually in stdout — so the wrapper tries stdout first and
// only retries when it was truncated. stage/publish are safe to retry: the
// component reconciles on the same deploymentId.
const UV_RACE_EXIT_CODES = new Set([0xc0000409]);

/** Run `convex run ...` synchronously and return parsed stdout. */
function convexRun(componentName, fn, args = {}, prod = false) {
  const argv = [
    convexBinPath(),
    "run",
    "--component",
    componentName,
    fn,
    JSON.stringify(args),
    "--typecheck=disable",
    "--codegen=disable",
  ];
  if (prod) argv.push("--prod");
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = spawnSync(process.execPath, argv, {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) {
      return JSON.parse((result.stdout || "").trim());
    }
    const detail = (result.stderr || "").trim() || (result.stdout || "").trim();
    if (UV_RACE_EXIT_CODES.has(result.status)) {
      // The child aborted at teardown; its stdout is often complete anyway.
      const raw = (result.stdout || "").trim();
      try {
        return JSON.parse(raw);
      } catch {
        // stdout was truncated — retry the idempotent call.
      }
      lastErr = new Error(
        `convex run ${fn} hit the Windows teardown race (attempt ${attempt}): ${detail.slice(0, 200)}`,
      );
      continue;
    }
    throw new Error(`convex run ${fn} failed (${result.status}): ${detail.slice(0, 500)}`);
  }
  throw lastErr ?? new Error(`convex run ${fn} exhausted retries`);
}

function collectFiles(dir, baseDir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push({
        path: "/" + relative(baseDir, fullPath).replace(/\\/g, "/"),
        localPath: fullPath,
        contentType:
          MIME_TYPES[extname(fullPath).toLowerCase()] ||
          "application/octet-stream",
      });
    }
  }
  return files;
}

function chunkBySerializedArgument(items, makeArgs) {
  const chunks = [];
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    const bytes = Buffer.byteLength(JSON.stringify(makeArgs(candidate)));
    if (bytes <= MAX_CONVEX_ARGUMENT_BYTES) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error("Single asset record exceeds the CLI argument limit");
    }
    chunks.push(current);
    current = [item];
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (name) => argv.includes(name);
  const distDir = resolve(flag("--dist") ?? "./dist");
  const componentName = flag("--component") ?? "staticHosting";
  const prod = has("--prod");
  const spaFallback = !has("--no-spa");

  // 1. Reachability + site URL (same probe the CLI uses).
  const { siteUrl } = convexRun(componentName, "lib:getUrls", {}, prod);
  console.log(`🚀 Deploying static site to ${siteUrl} (component ${componentName})`);

  if (!existsSync(distDir)) {
    console.error(`Error: dist directory not found: ${distDir}`);
    process.exit(1);
  }
  const files = collectFiles(distDir, distDir);
  if (files.length === 0) {
    console.error("Error: dist directory is empty");
    process.exit(1);
  }
  if (!files.some((f) => f.path === "/index.html")) {
    console.error("Error: dist has no index.html");
    process.exit(1);
  }
  console.log(`Uploading ${files.length} files with deployment ID …`);

  const deploymentId = randomUUID();
  const storageIds = new Array(files.length);
  let completed = 0;

  // 2. Mint upload URLs in batches, then POST each file.
  for (let offset = 0; offset < files.length; offset += UPLOAD_URL_BATCH_SIZE) {
    const count = Math.min(UPLOAD_URL_BATCH_SIZE, files.length - offset);
    const urls = convexRun(componentName, "lib:generateUploadUrls", { count }, prod);
    if (!Array.isArray(urls) || urls.length !== count) {
      throw new Error("Component returned invalid upload URLs");
    }
    // Upload the batch with bounded concurrency (sync loop; batches are
    // small enough that serial POSTs stay fast and race-free).
    for (let i = 0; i < count; i++) {
      const file = files[offset + i];
      const body = readFileSync(file.localPath);
      const res = await fetch(urls[i], {
        method: "POST",
        headers: { "Content-Type": file.contentType },
        body,
      });
      if (!res.ok) {
        throw new Error(`Storage upload failed for ${file.path}: ${res.status}`);
      }
      const { storageId } = await res.json();
      if (typeof storageId !== "string") {
        throw new Error(`No storageId returned for ${file.path}`);
      }
      storageIds[offset + i] = storageId;
      completed++;
      console.log(`  [${completed}/${files.length}] ${file.path}`);
    }
  }

  // 3. Stage the manifest in portable chunks.
  const assets = files.map((file, i) => ({
    path: file.path,
    storageId: storageIds[i],
    contentType: file.contentType,
    deploymentId,
  }));
  const chunks = chunkBySerializedArgument(assets, (c) => ({ assets: c }));
  for (let i = 0; i < chunks.length; i++) {
    console.log(`  Staging manifest chunk ${i + 1}/${chunks.length}…`);
    convexRun(componentName, "lib:stageAssets", { assets: chunks[i] }, prod);
  }

  // 4. Publish. If the response is lost to the teardown race, reconcile
  //    against the live deployment before retrying — publish is only
  //    re-run when this deployment did NOT become current.
  console.log("  Publishing deployment…");
  let result;
  try {
    result = convexRun(
      componentName,
      "lib:publishDeployment",
      {
        currentDeploymentId: deploymentId,
        expectedAssetCount: assets.length,
        spaFallback,
      },
      prod,
    );
  } catch (err) {
    const current = convexRun(componentName, "lib:getCurrentDeployment", {}, prod);
    if (current?.currentDeploymentId === deploymentId) {
      console.warn(
        "Publish committed but its response was lost to the teardown race; " +
          "the new deployment is live.",
      );
      result = { deleted: 0, pendingBlobCleanup: 0 };
    } else {
      throw err;
    }
  }
  console.log("✨ Upload complete!");
  console.log(`Your app is now available at: ${siteUrl}`);
  if (typeof result.deleted === "number" && result.deleted > 0) {
    console.log(`Cleaned up ${result.deleted} old storage file(s)`);
  }
}

main().catch((e) => {
  console.error("Upload failed:", e.message);
  process.exit(1);
});
