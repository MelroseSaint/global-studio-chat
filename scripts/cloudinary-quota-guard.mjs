/**
 * Cloudinary quota & growth guard — the alarm BEFORE uploads break.
 *
 * On the Free plan the monthly credit limit is a hard stop: once credits
 * run out, EVERY user upload fails until the cycle resets or the plan is
 * upgraded. This guard reads Cloudinary's own usage endpoint and:
 *
 *   1. Fails when credits.used_percent crosses QUOTA_FAIL_PERCENT
 *      (default 80) — the "upgrade now" alarm. Warns at 60.
 *   2. Fails when storage passes QUOTA_STORAGE_FAIL_PERCENT (default 80)
 *      of the plan's storage cap (CLOUDINARY_STORAGE_CAP_GB, default 10
 *      for Free).
 *   3. Projects growth: compares storage usage against a baseline cached
 *      by CI (actions/cache) and fails when the trend exhausts the
 *      remaining headroom within QUOTA_HORIZON_DAYS (default 30) — the
 *      "uploads will start failing this month" alarm, before it happens.
 *
 * The credits number already folds in bandwidth and transformations, so
 * those are reported (with their own trends) but never separately fatal.
 *
 * Env:
 *   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
 *   QUOTA_FAIL_PERCENT        (default 80)  credits alarm threshold
 *   QUOTA_WARN_PERCENT        (default 60)  credits warn threshold
 *   QUOTA_STORAGE_FAIL_PERCENT (default 80) of the storage cap
 *   CLOUDINARY_STORAGE_CAP_GB (default 10 — the Free plan's storage cap)
 *   QUOTA_HORIZON_DAYS        (default 30)  trend alarm horizon
 *   QUOTA_BASELINE_FILE       (default .quota-baseline.json; CI caches it)
 *
 * Exit codes: 0 = healthy, 1 = alarm (fail the build), 2 = misconfigured.
 */
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";

const CLOUD = process.env.CLOUDINARY_CLOUD_NAME ?? "saintscloud";
const API_KEY = process.env.CLOUDINARY_API_KEY ?? "";
const API_SECRET = process.env.CLOUDINARY_API_SECRET ?? "";
const FAIL_PCT = Number(process.env.QUOTA_FAIL_PERCENT ?? 80);
const WARN_PCT = Number(process.env.QUOTA_WARN_PERCENT ?? 60);
const STORAGE_FAIL_PCT = Number(process.env.QUOTA_STORAGE_FAIL_PERCENT ?? 80);
const STORAGE_CAP_GB = Number(process.env.CLOUDINARY_STORAGE_CAP_GB ?? 10);
const HORIZON_DAYS = Number(process.env.QUOTA_HORIZON_DAYS ?? 30);
const BASELINE_FILE = process.env.QUOTA_BASELINE_FILE ?? ".quota-baseline.json";

if (!CLOUD || !API_KEY || !API_SECRET) {
  console.error(
    "Cloudinary quota guard: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and " +
      "CLOUDINARY_API_SECRET are required.",
  );
  process.exit(2);
}

const gb = (bytes) => bytes / 1024 ** 3;
const fmtGB = (bytes) => `${gb(bytes).toFixed(3)} GB`;
const DAY_MS = 24 * 60 * 60_000;

const failures = [];
const warns = [];
const report = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warns.push(msg);
const say = (msg) => report.push(msg);

/** Read the usage endpoint with HTTP Basic auth (no signature needed). */
async function fetchUsage() {
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/usage`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64")}`,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`FAIL: usage endpoint returned HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    process.exit(1);
  }
  return json;
}

/** Load + validate the cached baseline (written by the previous run). */
function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    const b = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
    if (typeof b.date !== "number" || typeof b.storageUsage !== "number") return null;
    return b;
  } catch {
    return null;
  }
}

function saveBaseline(usage) {
  const b = {
    date: Date.now(),
    storageUsage: usage.storage?.usage ?? 0,
    transformationsUsage: usage.transformations?.usage ?? 0,
    creditsUsage: usage.credits?.usage ?? 0,
  };
  try {
    writeFileSync(BASELINE_FILE, JSON.stringify(b));
  } catch {
    // A cache write failure must never fail the guard.
  }
}

async function main() {
  console.log(`\nPureWire Cloudinary quota guard (cloud ${CLOUD})\n`);
  const u = await fetchUsage();

  const creditsPct = u.credits?.used_percent ?? 0;
  const creditsLimit = u.credits?.limit ?? 0;
  say(
    `plan: ${u.plan} | credits: ${(u.credits?.usage ?? 0).toFixed(2)} / ${creditsLimit} ` +
      `(${creditsPct.toFixed(1)}%) | bandwidth: ${fmtGB(u.bandwidth?.usage ?? 0)} | ` +
      `transformations: ${u.transformations?.usage ?? 0} | storage: ${fmtGB(u.storage?.usage ?? 0)}`,
  );

  // 1. Credits — the hard stop on Free.
  if (creditsPct >= FAIL_PCT) {
    fail(
      `credits at ${creditsPct.toFixed(1)}% (>= ${FAIL_PCT}%): uploads STOP when it hits 100% — ` +
        `upgrade the Cloudinary plan or prune assets now.`,
    );
  } else if (creditsPct >= WARN_PCT) {
    warn(`credits at ${creditsPct.toFixed(1)}% (>= ${WARN_PCT}% warn line)`);
  }

  // 2. Absolute storage level.
  const storageBytes = u.storage?.usage ?? 0;
  const storagePct = (gb(storageBytes) / STORAGE_CAP_GB) * 100;
  if (storagePct >= STORAGE_FAIL_PCT) {
    fail(
      `storage ${fmtGB(storageBytes)} is ${storagePct.toFixed(1)}% of the ` +
        `${STORAGE_CAP_GB} GB cap (>= ${STORAGE_FAIL_PCT}%)`,
    );
  } else {
    say(`storage at ${storagePct.toFixed(1)}% of the ${STORAGE_CAP_GB} GB cap`);
  }

  // 3. Growth trend — fails BEFORE the horizon point is reached.
  const baseline = loadBaseline();
  const baselineAgeDays = baseline ? (Date.now() - baseline.date) / DAY_MS : null;
  const freshBaseline =
    baseline && baselineAgeDays >= 1 && baseline.storageUsage <= storageBytes ? baseline : null;
  if (freshBaseline) {
    const growthBytesPerDay = (storageBytes - freshBaseline.storageUsage) / baselineAgeDays;
    const headroomBytes = STORAGE_CAP_GB * 1024 ** 3 - storageBytes;
    const daysToCap = growthBytesPerDay > 0 ? headroomBytes / growthBytesPerDay : Infinity;
    const growthPerDayGB = gb(growthBytesPerDay);
    say(
      `trend: ${growthPerDayGB >= 0.001 ? growthPerDayGB.toFixed(3) : growthPerDayGB.toExponential(1)} GB/day ` +
        `over ${baselineAgeDays.toFixed(1)}d — ${Number.isFinite(daysToCap) ? daysToCap.toFixed(0) : "∞"} days of headroom`,
    );
    if (daysToCap < HORIZON_DAYS) {
      fail(
        `at the current rate storage exhausts the ${STORAGE_CAP_GB} GB cap in ` +
          `${daysToCap.toFixed(0)} days (< ${HORIZON_DAYS}-day horizon) — plan an upgrade or cleanup now.`,
      );
    }
    // Transformations trend: informational — credits already gate them.
    if (typeof freshBaseline.transformationsUsage === "number") {
      const tPerDay = (u.transformations.usage - freshBaseline.transformationsUsage) / baselineAgeDays;
      say(`transformations trend: ${tPerDay.toFixed(1)}/day (counted inside credits)`);
    }
  } else if (baseline) {
    say(
      baselineAgeDays < 1
        ? "baseline younger than a day — trend alarm arms itself on the next run"
        : "baseline newer than current usage (cycle reset?) — re-establishing",
    );
  } else {
    say("no baseline yet — trend alarm arms itself on the next run");
  }
  saveBaseline(u);

  // Emit the alarm set.
  for (const note of report) console.log(`ℹ️  ${note}`);
  for (const w of warns) console.log(`⚠️  ${w}`);
  if (failures.length > 0) {
    console.error("\nQUOTA ALARM:");
    for (const f of failures) console.error(`  ❌ ${f}`);
    process.exit(1);
  }
  console.log("✅ quota healthy");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err?.message ?? err);
  process.exit(2);
});
