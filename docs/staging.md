# Staging environment

## The shape

PureWire's staging is **Convex dev deployment `polished-pig-610`** plus a
Vercel preview deployment. Production (`jovial-axolotl-209` +
purewire.vercel.app) is never a test target except through the harness
QAs, which are designed to leave zero traces (qa_ accounts, fixture
posts, full cascade cleanup).

| | Production | Staging |
| --- | --- | --- |
| Convex | `jovial-axolotl-209` (prod) | `polished-pig-610` (dev) |
| Web | https://purewire.vercel.app | `vercel preview` URL |
| Test harness | enabled (CI nightly QAs need it) | enabled freely |
| Data | real members | disposable fixtures |

## Deploy the backend to staging

```bash
CONVEX_DEPLOYMENT=polished-pig-610 npm run deploy:backend
```

(`deploy:backend` runs `scripts/ensure-jwt-keys.mjs` first, so a fresh
dev deployment gets its JWT pair provisioned automatically.)

## Run the web app against staging

```bash
# .env.local
VITE_CONVEX_URL=https://polished-pig-610.convex.cloud
npm run dev
```

## Seed staging with realistic data

```bash
CONVEX_URL=https://polished-pig-610.convex.cloud \
TEST_HARNESS_SECRET=<dev harness secret> \
npm run seed:posts
```

## QA against staging

Most scripts accept `CONVEX_URL` / `SITE_URL` overrides:

```bash
CONVEX_URL=https://polished-pig-610.convex.cloud \
TEST_HARNESS_SECRET=<dev harness secret> \
npm run qa:media-architecture
```

## When to stage instead of prod

- Schema/data migrations with destructive potential (dry-run them against
  a copy of prod data patterns first; the migrations workflow targets prod
  and must never be a first-run experiment).
- Auth-stack or crypto changes (the full signup → verify → reset loop
  runs against staging first; on prod it runs as the harness E2E).
- New moderation models or thresholds (tune on staged fixtures).

## Verify staging parity

```bash
npx convex run status:ping --deployment polished-pig-610   # {"ok":true}
curl -s -o /dev/null -w "%{http_code}" "<preview-url>/auth"  # 200
```

The auth preflight (`status:authPreflight`) must report `ok: true` on
staging before any signup-flow testing — it names exactly which env var
is missing if not.
