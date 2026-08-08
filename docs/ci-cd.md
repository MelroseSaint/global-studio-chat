# CI/CD

Six GitHub Actions workflows, all gated on `main`, all deployable from the
repo (see [Setup](setup.md)). The alert model is the same everywhere: a
failing production check opens a **deduplicated alert issue** (one per
label, reopened/kept while red, closed automatically by the next passing
run) so a red nightly is visible on the repo and never lost — and never
spams one issue per night.

## The workflows

| Workflow | Triggers | What it does |
| --- | --- | --- |
| **Static Audit** (`static-audit.yml`) | push to `main` + `pull_request` | Typecheck, lint, build, secrets scan, static SEO file guard (robots/sitemap drift), sitemap URL health, and 15+ parallel QA jobs (racism, phishing, blocklist, AI scan, automation, shadowban, reinstate, salt, admin-responsive, count-drift, session-audit, cleanup) |
| **Deploy to Vercel** (`deploy.yml`) | push to `main` | `vercel --prod` for the frontend; shares a concurrency group with the drift redeploy so deploys never race |
| **Production Health Check** (`production-healthcheck.yml`) | push to `main` + nightly 03:00 UTC + manual | Live-site e2e probes (auth loop, phishing, blocklist sync, moderation reinstate, admin IP binding, story views, cloudinary upload), the Vercel env guard, the build-log warning guard, SEO basics + dynamic-render guards, and the sitemap URL health checks |
| **SEO Audit** (`seo-audit.yml`) | nightly 04:00 UTC + manual | claude-seo audit + sitemap-wide sweep against the live site; score regressions open a `prod-seo-audit` alert; a weekly step (Monday 05:00 UTC) posts the metrics to a deduplicated `seo-weekly-report` trend issue with accumulating score history |
| **Run Convex migrations** (`migrations.yml`) | push to `main` + nightly 04:00 UTC | Deploys the Convex backend and auto-runs schema migrations — backfills like the comment like-count never need a manual step |
| **Redeploy on drift** (`redeploy-drift.yml`) | nightly 03:47 UTC | Compares the commit live on Vercel production against `main` HEAD and redeploys only when they drift, so the canonical/env state never silently lags the repo; fails safe (a check error never triggers a deploy) |

## Where QA lives

- **Deterministic, local scanners** (racism, phishing, blocklist engine,
  AI scan, automation, evidence-no-resemble) run in **Static Audit** on
  every push and PR — they exercise the code in-process, no network.
- **Production harness QAs** (signup-e2e, phishing, blocklist, reinstate,
  admin-ip, story-views, shadowban, session-audit, count-drift,
  ai-scan-integration, cloudinary-health, cleanup-*) run in the health
  check (nightly + push) and/or Static Audit. They mint sessions through
  the harness gate (`TEST_HARNESS_SECRET` + `TEST_HARNESS_ENABLED` on the
  deployment) and assert behavior against the **live** site.
- **Retry-once** — production-facing harness QAs are invoked through
  `scripts/retry-once.sh`, which retries once when a run exits 1 (checks
  failed, plausibly transient) and never retries exit 2 (harness
  misconfiguration, deterministic). `qa:blocklist-sync` retries internally
  in the script for the same reason. A genuine regression still fails
  after the retry and still opens its alert issue.

## Required secrets & variables

Set in the repo (**Settings → Secrets and variables → Actions**) unless
noted:

| Name | Used by | Notes |
| --- | --- | --- |
| `TEST_HARNESS_SECRET` | All harness-gated QAs | Must match the Convex deployment env; `TEST_HARNESS_ENABLED=1` on the deployment |
| `ADMIN_PASSWORD` | admin-ip, admin-responsive, pages-inflation | |
| `RESEND_API_KEY` | auth-loop e2e | The script reads email OTPs from Resend's API |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_UPLOAD_PRESET` | cloudinary-health | Public; also set as `vars` in the healthcheck |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | cloudinary-health | Signed deletes of the probe asset |
| `SITE_URL` (var) | healthcheck | Defaults to the Convex static host |
| `CONVEX_URL` (var) | healthcheck + QA jobs | Defaults to the production deployment |
| `VERCEL_TOKEN` / Vercel project linkage | deploy + env guards | |
| `PUREWIRE_SITE_URL` | Vercel project env (all environments) | Canonical host; repo default in `vite.config.ts`; `VITE_SITE_URL` is deprecated and guarded |

## Guards worth knowing

- **`qa:vercel-env`** — `PUREWIRE_SITE_URL` still set; a stale
  `VITE_SITE_URL` fails CI.
- **`qa:vercel-build-warnings`** — the shipped deploy's build log contains
  no canonical-host warnings.
- **`qa:sitemap-urls`** — sampled sitemap URLs return 200 with real
  content, a same-host canonical **and** `og:url`, no redirect drift, and
  every `<loc>` (main host + mirror) carries the canonical host. `--all`
  for a full sweep; `SITEMAP_SAMPLE` for the sample size.
- **`qa:dynamic-render`** — a Googlebot fetch of `/u/:handle` +
  `/post/:id` returns server-rendered HTML, never the SPA shell.
- **`qa:seo-audit`** — absolute floor **and** a committed-score baseline;
  any drop > `CQ_DELTA` (default 5) fails even above the floor.
  `seo-audit:baseline` re-records the reference after intentional changes
  (refused in CI by design).

## Local equivalents

Every workflow check has a local twin — `npm run qa:<name>` from
[`docs/setup.md`](setup.md). When CI and local disagree, the difference is
almost always an env var (secrets/vars table above) or the
harness gate.

See also [`architecture.md`](architecture.md) for the deployment topology
and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the PR workflow that
feeds all of this.
