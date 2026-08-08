#!/usr/bin/env node
/**
 * PureWire Redis rate-limit layer QA.
 *
 * Verifies the distributed rate-limit endpoint (api/rate-limit.ts, see
 * ADR-0007) is deployed and behaves correctly on the live host:
 *
 *   1. GET returns 405 (method not allowed) — the route is wired and not
 *      swallowed by the SPA fallback.
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
 * Overrides: SITE_URL (default https://purewire.vercel.app).
 * Exit codes: 0 all checks passed, 1 a check failed.
 */
import { createReporter } from "./lib/qa-browser.mjs";

const SITE_URL = (process.env.SITE_URL ?? "https://purewire.vercel.app").replace(/\/$/, "");
const ENDPOINT = `${SITE_URL}/api/rate-limit`;

const reporter = createReporter();
const { check } = reporter;

async function post(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  const get = await fetch(ENDPOINT, { method: "GET" });
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
  process.exit(reporter.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("qa-redis-rate-limit failed:", err);
  process.exit(1);
});
