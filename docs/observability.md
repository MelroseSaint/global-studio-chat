# Observability

## What exists today

### CI as the production monitor

The **Production Healthcheck** workflow runs on every push to `main`
and nightly at 03:00 UTC. It is the primary observability surface: 30
jobs exercise the live deployment end to end (auth loop with real email
verification, media upload pipeline, moderation, SEO surfaces, sitemap
health, PWA, story ordering, admin workload guard). Any failure opens a
**deduplicated GitHub issue** labeled per check; the next passing run
closes it. GitHub issues therefore double as the alert history.

The **Static Audit** workflow (push + nightly 04:30 UTC) watches code
health: typecheck, lint, unit tests, build + critical-path size guard,
secret hygiene, dependency vulnerabilities, blocklist/racism/phishing
QA suites.

### Deployment-side

- `npx convex logs --deployment jovial-axolotl-209` — live function
  logs (streaming; run detached, capture to file, kill). Uncaught
  exceptions appear here with the throwing file:line.
- `status:ping` (`{"ok":true}`) and `status:authPreflight`
  (`{ ok, missing[] }`) — cheap public health probes.
- `auditMediaArchitecture`, `qaIsolationSnapshot`, `auditDataOrphans`,
  `auditSessionLifetimes`, `auditDuplicates` — harness-gated
  introspection queries over live data.

### External probes the QAs perform

- Sitemap freshness + URL health (`qa:sitemap-urls`, seo-live-guard).
- Dynamic render check (real headless browser against production).
- Media asset liveness (fetches a stored URL and requires HTTP 200).

## What to watch weekly

1. Open alert issues: `gh issue list --state open --label healthcheck`
   (or the GitHub issues page) — every open issue is a real production
   symptom, deduplicated.
2. `npm audit` gate drift (Dependabot PRs accumulate if ignored).
3. Convex usage dashboard: function invocations, bandwidth, storage —
   the media architecture exists specifically to keep storage flat.

## Adding a new probe

New production behavior should ship with a QA script wired into
`.github/workflows/production-healthcheck.yml` following the existing
pattern: run the script via `scripts/retry-once.sh`, upload the log
artifact on failure, and open a deduplicated issue named after the
check. Copy any existing job as the template.
