#!/usr/bin/env node
/**
 * PureWire Redis rate-limit layer QA.
 *
 * Verifies the distributed rate-limit HTTP action (src/convex/rateLimit.ts,
 * POST /rate-limit on the Convex site, see ADR-0007) is deployed and
 * behaves correctly:
 *
 *   1. GET returns 405 (method not allowed) — the route is wired.
 *   2. POST with an unknown action returns 400 — validation works.
 *   3. POST with a valid action behaves per the Redis configuration:
 *      - no UPSTASH_REDIS_REST_URL on the deployment → 503 + fail-open
 *        body ({ ok: true, degraded: true }) — the client must never be
 *        blocked when Redis is absent.
 *      - Redis configured → 200 with X-RateLimit-* headers (a token was
 *        consumed), or 429 with Retry-After when the shared bucket is
 *        exhausted (e.g. another run consumed the whole window).
 *      Both are correct states — the check is that the endpoint answers
 *      without crashing and the fail-open contract holds.
 *
 * Run:
 *   npm run qa:redis-rate-limit
 *
 * Overrides: CONVEX_SITE (default https://outgoing-seal-727.convex.site).
 * Exit codes: 0 all checks passed, 1 a check failed.
 */
// Minimal pass/fail reporter — deliberately NOT the shared one from
// ./lib/qa-browser.mjs, which loads Playwright/Chromium. This QA is pure
// HTTP (fetch against the Convex site) and should stay dependency-light.
function createReporter() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  return {
    check(name, ok, detail = "") {
      if (ok) {
        passed++;
        console.log(`  ✅ ${name}`);
      } else {
        failed++;
        failures.push(name);
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
      }
    },
    get failed() {
      return failed;
    },
    summary() {
      console.log(`\n${passed} passed, ${failed} failed`);
      if (failed > 0) {
        console.log("Failed checks:");
        for (const f of failures) console.log(`  - ${f}`);
      }
    },
  };
}

const CONVEX_SITE = (
  process.env.CONVEX_SITE ?? "https://outgoing-seal-727.convex.site"
).replace(/\/$/, "");
const ENDPOINT = `${CONVEX_SITE}/rate-limit`;

const reporter = createReporter();
const { check } = reporter;

async function post(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    // connection: close — this QA makes a handful of one-shot fetches and
    // exits; without it, some local Node builds (v25 on Windows) trip a
    // libuv async-handle assertion in teardown when the keep-alive socket
    // is still open (the checks themselves all pass). CI (Node 22, Ubuntu)
    // is unaffected either way, but closing keeps the QA portable.
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.json().catch(() => null),
  };
}

async function main() {
  // 1 — the route exists (not swallowed by the SPA shell).
  const get = await fetch(ENDPOINT, {
    method: "GET",
    headers: { connection: "close" },
  });
  check(
    "endpoint deployed (GET → 405)",
    get.status === 405,
    `got ${get.status}`,
  );

  // 2 — validation rejects unknown actions.
  const bad = await post({ action: "nope" });
  check("unknown action → 400", bad.status === 400, `got ${bad.status}`);

  // 3 — a real action behaves per Redis configuration (fail-open or live).
  const live = await post({ action: "like", userId: "qa-redis-layer" });
  const failOpen =
    live.status === 503 &&
    live.body?.ok === true &&
    live.body?.degraded === true;
  const liveOk =
    (live.status === 200 || live.status === 429) &&
    live.headers["x-ratelimit-limit"] !== undefined;
  check(
    "valid action → fail-open 503 OR live bucket (200/429 + headers)",
    failOpen || liveOk,
    `status=${live.status} headers=${JSON.stringify(live.headers["x-ratelimit-limit"])}`,
  );
  if (live.status === 429) {
    check("429 carries Retry-After", live.headers["retry-after"] !== undefined);
  }

  reporter.summary();
  // Explicitly close undici's global dispatcher so no keep-alive sockets
  // are open at teardown — on some local Node builds (v25 on Windows) an
  // open fetch agent trips a libuv async-handle assertion on exit. CI
  // (Node 22, Ubuntu) is unaffected either way, but closing keeps the QA
  // portable.
  try {
    const { getGlobalDispatcher } = await import("undici");
    await getGlobalDispatcher().close();
  } catch {
    // undici is bundled into Node (no separate import needed); older
    // versions expose it differently — never let cleanup fail the QA.
  }
  process.exit(reporter.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("qa-redis-rate-limit failed:", err);
  process.exit(1);
});
