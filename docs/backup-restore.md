# Backup and restore

## What needs backing up (and what doesn't)

| Data | Where | Backed up how |
| --- | --- | --- |
| Convex documents (users, posts, comments, …) | Convex deployment | Convex deployment snapshots + the export procedure below |
| Function code + schema | git (this repo) | git itself; deployment history on Convex |
| Media bytes (post the Cloudinary flip) | Cloudinary | Cloudinary account (auto-backup addon) |
| Media bytes (legacy, pre-flip items) | Convex file storage | covered by the export below |
| Secrets | Convex env / GitHub / Vercel vaults | recovery paths below — never stored in git |
| DM message bodies | Convex (ciphertext only) | export covers ciphertext; keys are device-only and are NOT recoverable |

## One-time sanity checks (quarterly drill)

1. **Restore rehearsal (document-level).** Export a few tables and prove
   the data is readable and complete:
   ```bash
   npx convex export --deployment jovial-axolotl-209 --include-storage \
     --path /tmp/purewire-export   # Convex CLI export (prod; free-plan size is fine)
   ls /tmp/purewire-export          # snapshot_manifest.json + <table>/ JSONL files
   node -e "const l=require('fs').readFileSync('/tmp/purewire-export/users/documents.jsonl','utf8').trim().split('\n');console.log('users rows:',l.length);JSON.parse(l[0])"
   ```
   Success = row counts look sane and the first row of each critical
   table parses. (The export is a zip/snapshot directory — shape may vary
   slightly by CLI version; the manifest lists every included table.)
2. **Point-in-time awareness.** Note the deployment's snapshot list in
   the Convex dashboard (Settings → Snapshots) — production snapshots
   are taken automatically; know where they live before you need them.
3. **Secrets recoverability.** Walk through the secret inventory below
   and confirm you can actually retrieve each value.

## Secret inventory & recovery paths

| Secret | Lives in | Recovery |
| --- | --- | --- |
| `JWT_PRIVATE_KEY` / `JWKS` | Convex env (prod + dev) | `ensure-jwt-keys.mjs` refuses to rotate a half-present pair by design; dashboard shows the stored value. Losing BOTH is recoverable only via re-login of every session — never rotate without reading docs/secrets-setup.md |
| `RESEND_API_KEY` | Convex env | Resend dashboard → API keys |
| `CLOUDINARY_API_SECRET` | Convex env (after flip), GitHub secrets | Cloudinary dashboard → Settings → Access Keys |
| `CONVEX_DEPLOY_KEY` | GitHub secrets | Convex dashboard → Access Keys → create new |
| `VERCEL_TOKEN` | GitHub secrets | Vercel dashboard → Account Settings → Tokens |
| `TEST_HARNESS_SECRET` | Convex env + GitHub secrets | regenerate both sides together (run doc has the procedure) |
| `ADMIN_PASSWORD` | GitHub secrets (human-known) | known only to the owner — store in a password manager |

## Restore procedures

### Bad deploy (code/schema) — most common

```bash
git checkout <last-green-sha>
CONVEX_DEPLOYMENT=jovial-axolotl-209 npm run deploy:backend
```

Function deploys are transactional — this always restores a known state.

### Data corruption in one table

1. Export as above; extract the affected table's JSONL.
2. Reconcile, don't overwrite: the harness has purpose-built repair
   mutations (`reconcilePostsCounts`, `reconcileEngagementCounts`,
   `reconcileFollowCounts`) for count drift — prefer them over row-level
   rewrites.
3. For genuine row loss, write a one-off mutation from the exported rows
   and run it against prod only after the same mutation ran against the
   dev deployment.

### Full restore to a snapshot

Convex dashboard → deployment → Settings → Snapshots → restore into a
NEW deployment, then repoint the frontend (`VITE_CONVEX_URL` in
`.env.production`, redeploy Vercel) and update the CI variables
(`CONVEX_URL`, the deploy target in workflows). Treat the old
deployment as read-only evidence until the incident closes.

## Media (Cloudinary) after the flip

Enable Cloudinary's automatic backup (Settings → Backup) so original
uploads are retained. Restoration = re-upload from backup by
`public_id` (stored in Convex as the media item's `key`, which is what
makes the restore path exact). Convex holds only the reference — if
Cloudinary data is lost, the reference survives and points at re-covered
assets unchanged.
