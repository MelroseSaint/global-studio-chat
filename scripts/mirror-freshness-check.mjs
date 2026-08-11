#!/usr/bin/env node
/**
 * PureWire mirror-freshness guard.
 *
 * Fetches the convex.site mirror's served Admin chunk and asserts it
 * carries the section-dropdown admin UI. The Admin page is route-split
 * (a lazy `import("./Admin-<hash>.js")` inside the entry chunk), so the
 * check walks: mirror `/` HTML → entry chunk name → Admin chunk name →
 * Admin chunk body, and fails if the marker strings that only exist in
 * the dropdown-era admin code are absent.
 *
 * The mirror (outgoing-seal-727.convex.site) serves the same app via
 * Convex static hosting and used to silently lag the main host (the
 * admin-dropdown incident: /admin there showed the old tab row while the
 * main host had the dropdown). deploy.yml now syncs it on every deploy;
 * this guard makes staleness a hard CI failure instead of a silent
 * regression — it runs as the final verification step right after the
 * sync publishes, and again on every push/PR via static-audit.yml.
 *
 * Marker choice: `purewire_admin_section` (the localStorage key from the
 * section-persistence work) and `Shortcuts` (the keyboard-shortcuts
 * button label) are string literals that survive minification and exist
 * in the Admin chunk only after the dropdown UI shipped. If either is
 * renamed deliberately, update MARKERS and re-baseline.
 *
 * Usage: node scripts/mirror-freshness-check.mjs
 * Env:   MIRROR_URL            (default https://outgoing-seal-727.convex.site)
 *        MIRROR_POLL_TRIES     (default 6  — publish propagation can lag a
 *                               few seconds; each try re-fetches everything)
 *        MIRROR_POLL_INTERVAL_MS (default 5000)
 * Exit codes: 0 = mirror current, 1 = stale or unreachable.
 */
const MIRROR_URL = (
  process.env.MIRROR_URL ?? "https://outgoing-seal-727.convex.site"
).replace(/\/+$/, "");
const MARKERS = ["purewire_admin_section", "Shortcuts"];
const POLL_TRIES = Number(process.env.MIRROR_POLL_TRIES ?? 6);
const POLL_INTERVAL_MS = Number(process.env.MIRROR_POLL_INTERVAL_MS ?? 5000);

const CHUNK_RE = /[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js/g;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function fetchText(url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "purewire-mirror-freshness-check/1.0" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < tries) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`\nMirror freshness guard — ${MIRROR_URL}\n`);
  let html;
  try {
    html = await fetchText(`${MIRROR_URL}/`);
  } catch (err) {
    check("mirror / reachable", false, err.message);
    process.exit(1);
  }
  check("mirror / reachable", true);

  const entryMatch = html.match(/index-[A-Za-z0-9_-]{8}\.js/);
  if (!entryMatch) {
    check("entry chunk found in mirror HTML", false, "no index-<hash>.js in served HTML");
    process.exit(1);
  }
  const entryName = entryMatch[0];
  check("entry chunk found in mirror HTML", true, entryName);

  let entryJs;
  try {
    entryJs = await fetchText(`${MIRROR_URL}/assets/${entryName}`);
  } catch (err) {
    check("entry chunk fetched", false, err.message);
    process.exit(1);
  }
  check("entry chunk fetched", true);

  const adminMatch = entryJs.match(/Admin-[A-Za-z0-9_-]{8}\.js/);
  if (!adminMatch) {
    check("Admin chunk referenced by entry", false, "no Admin-<hash>.js in the entry chunk — the mirror is serving a pre-dropdown build");
    process.exit(1);
  }
  const adminName = adminMatch[0];
  check("Admin chunk referenced by entry", true, adminName);

  // The publish step completes atomically, but edge caches / propagation
  // can lag a few seconds — poll the Admin chunk until the markers land.
  let adminJs = "";
  let lastDetail = "";
  for (let t = 1; t <= POLL_TRIES; t++) {
    try {
      adminJs = await fetchText(`${MIRROR_URL}/assets/${adminName}`);
    } catch (err) {
      lastDetail = err.message;
      adminJs = "";
    }
    const missing = MARKERS.filter((m) => !adminJs.includes(m));
    if (missing.length === 0) break;
    lastDetail = `missing markers: ${missing.join(", ")}`;
    if (t < POLL_TRIES) {
      console.log(`  (try ${t}/${POLL_TRIES}: ${lastDetail} — retrying in ${POLL_INTERVAL_MS / 1000}s)`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  check("Admin chunk fetched", adminJs.length > 0, adminJs.length ? `${(adminJs.length / 1024).toFixed(1)} kB` : lastDetail);
  for (const marker of MARKERS) {
    check(`Admin chunk carries ${JSON.stringify(marker)}`, adminJs.includes(marker));
  }

  console.log("");
  if (failures > 0) {
    console.error(
      `::error::Mirror is STALE — ${MIRROR_URL} serves ${entryName} / ${adminName} without the section-dropdown admin UI. ` +
        "The deploy-time sync either did not run, published stale dist, or was skipped. " +
        "Re-run the Deploy workflow or sync manually: `npm run build && node scripts/upload-static-sync.mjs --prod`."
    );
    process.exit(1);
  }
  console.log(`Mirror is current — ${entryName} → ${adminName} carries the dropdown admin UI.`);
}

main().catch((err) => {
  console.error(`::error::Mirror freshness guard crashed: ${err.message}`);
  process.exit(1);
});
