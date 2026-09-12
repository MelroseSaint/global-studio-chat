# Backup & restore

PureWire's source of truth is the Convex production deployment
`jovial-axolotl-209`. This doc is the verified runbook for keeping a
restorable copy of it and for actually restoring. **The restore procedure
below was executed end-to-end on 2026-09-12** — the steps are not
theoretical.

## What exists today

| Layer | Mechanism | Retention | Owner |
|---|---|---|---|
| CI snapshot backups | `.github/workflows/backup.yml` → `convex export --include-file-storage` uploaded as a workflow artifact | 90 days | automatic (needs rotated `CONVEX_DEPLOY_KEY`) |
| Convex dashboard snapshots | manual `convex export` (dashboard → Settings → Snapshots) also lists each export server-side | dashboard-managed | owner |
| Local archive | `../.freebuff/backups/purewire-prod-2026-09-12.zip` (3.4 MB, SHA-256 `c112921882c1718fff4c2f28816f44587b0750cde05036c8f4875e43a3d63e6a`) | local disk | this machine |

Cadence: **weekly** (CI, Sundays 04:30 UTC) plus **before any risky
operation** (schema push, mass moderation, deploy of destructive migrations)
— run the export command below by hand first.

## Take a backup (verified command)

```bash
cd <repo>
mkdir -p backups
CONVEX_DEPLOYMENT=jovial-axolotl-209 \
  npx convex export --include-file-storage \
  --path backups/purewire-prod-$(date -u +%Y-%m-%d).zip
```

- `--include-file-storage` matters: post/avatar/banner media on the
  fallback (Convex storage) path lives in `_storage`; without the flag the
  snapshot has document references whose bytes are gone.
- Note the printed snapshot timestamp; it also appears in the dashboard's
  snapshot-export list.
- Record the archive's SHA-256 next to it (`sha256sum <file>`), as done for
  the 2026-09-12 archive above.

## Verify a backup's integrity (verified command)

A snapshot ZIP contains `<table>/documents.jsonl` per table. Sanity-check
it against the live sitemap counts:

```bash
python - <<'PY'
import zipfile, json
from collections import defaultdict
z = zipfile.ZipFile('backups/<archive>.zip')
counts = defaultdict(int)
for n in z.namelist():
    if n.endswith('/documents.jsonl'):
        counts[n.split('/')[0]] = sum(1 for _ in z.open(n))
print('posts:', counts['posts'], 'users:', counts['users'])
PY
```

Cross-check: `curl -s https://purewire.vercel.app/sitemap.xml | grep -c post/`
must equal the snapshot's `posts` count (as of 2026-09-12: **5**). A backup
whose counts disagree with the live surface is a red flag — re-export.

## Restore (verified end-to-end on 2026-09-12)

Target choice: **always restore into a dev deployment first** (`dev
polished-pig-610` today), verify, and only then point users at it or copy
forward. Never `--replace-all` a production deployment directly unless the
incident doc explicitly calls for it.

1. **Import the snapshot** (documents + `_storage` files):

   ```bash
   CONVEX_DEPLOYMENT=polished-pig-610 \
     npx convex import --replace-all backups/<archive>.zip
   ```

   `--replace-all` wipes the target's tables and replaces them with the
   snapshot's — the honest "restore" semantics. Expect the import to print
   per-table progress and a final `✔ Added N documents`.

2. **Push the CURRENT function bundle to the restored target.** The
   snapshot restores data only — the deployment's code stays whatever it
   was, and stale functions are the first thing to bite (public queries
   report `Could not find public function for …`):

   ```bash
   CONVEX_DEPLOYMENT=polished-pig-610 npx convex dev --once
   ```

   (`convex deploy` is production-gated and will try to prompt for a prod
   push — `dev --once` is the right tool for a dev target.)

3. **Verify the restore** with the app's own read paths, not raw table
   dumps:

   ```bash
   curl -s https://polished-pig-610.convex.site/sitemap.xml | grep -cE "post/|u/melroseadmin"
   # expect: 6 (5 post URLs + the admin profile) — must match production's sitemap
   ```

   Also spot-check profile parity (header count == rendered rows) as in
   `npm run qa:admin-responsive`. On 2026-09-12 the restored dev
   deployment served the identical sitemap from the imported snapshot.

4. **Promote only after verification**: re-point the frontend
   (`VITE_CONVEX_URL` in `.env.local` / Vercel env) at the restored
   deployment, or replicate the data forward to production via the same
   import path following an incident-specific plan. Note auth env vars
   (`JWT_PRIVATE_KEY`, `JWKS`, `EMAIL_*`, `SITE_URL`, salts) are NOT in the
   snapshot — they live in the deployment's env settings; `scripts/ensure-jwt-keys.mjs`
   re-provisions the JWT pair idempotently if the target lacks them.

## Gotchas learned during the drill (2026-09-12)

- `npx convex dev --once` REWRITES `.env.local` to point `VITE_CONVEX_URL`
  at the dev deployment. Restore it to production afterwards
  (`https://jovial-axolotl-209.convex.cloud`) or the local preview boots
  against dev.
- The first query after a fresh import can throw a transient
  `Server Error` while the HTTP entrypoint warms; retry before diagnosing.
- The restored dev deployment serves production canonical URLs
  (`https://purewire.vercel.app/...`) in its sitemap — that's the
  `SITE_URL` env baked into the bundle, expected for a drill, not a bug.
- Snapshot exports include internal tables (`_components`, `_storage`,
  `_tables`); leave them untouched on import — `--replace-all` handles the
  component remount.
