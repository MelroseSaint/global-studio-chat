# Incident response

## What counts as an incident

- Real members see wrong behavior (data leak between accounts, broken
  auth, content moderation failure, media loss).
- A healthcheck alert issue fires **twice in a row** (a single red run
  after a push may be a transient/coinflip — two consecutive reds on
  unchanged code is a production regression).
- Moderation QAs fail against prod (the pipeline is not doing its job).
- Anything that touches the auth stack misbehaving (sign-in, sessions,
  JWTs, email codes).

## Severity ladder

| Level | Example | Response |
| --- | --- | --- |
| S1 | Auth broken for real users; data visible cross-account | Drop everything. Mitigate, then root-cause. |
| S2 | Moderation/privacy guard failing; media pipeline degraded | Same-day fix; fall back to documented safe mode if needed |
| S3 | Single QA failing, no user-facing symptom | Schedule; never let it rot more than a week |

## S1/S2 playbook

1. **Confirm scope from the alert issue body** — it links the failing
   run, the job, and the log artifact. Reproduce locally with the same
   QA script before touching anything (every failure mode in this
   repo's history reproduced locally first).
2. **Stop the bleeding.** Options, least destructive first:
   - Revert the suspect commit (`git revert`, push) — deploys rerun
     automatically.
   - Roll back the backend: `git checkout <last-green-sha> &&
     CONVEX_DEPLOYMENT=jovial-axolotl-209 npm run deploy:backend`.
   - Disable a surface via env (e.g. remove `CLOUDINARY_*` to fall back
     to Convex storage; the pipeline is dual-mode by design).
   - Disable one CI check only if it is provably wrong, never to hide a
     real failure (add a dated comment in the workflow).
3. **Preserve evidence** before mutating: `npx convex logs` output,
   failing QA artifact, relevant DB reads via harness queries.
4. **Fix forward**, re-run the failing QA locally until green, push,
   and confirm the CI run closes the alert issue.
5. **Post-incident note** in the alert issue: root cause, blast radius,
   fix commit, and any follow-ups opened.

## Known fast paths (from real incidents here)

- **"Server Error" on a mutation** → stream `convex logs`, trigger once,
  read the uncaught error with file:line. Never debug blind.
- **Sign-in failures across the board** → `status:authPreflight` names
  the missing env var (`SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`).
- **Wrong password "Server Error"** → the auth stack is fine;
  `InvalidSecret` in the logs means the password is wrong (check which
  secret store you are using).
- **Media QA failures after a deploy** → prod may be running stale
  functions; realign with `CONVEX_DEPLOYMENT=jovial-axolotl-209 npm run
  deploy:backend` before assuming a code bug.
- **CI red but locally green** → check for concurrent QA runs sharing
  the admin account (the push-burst gate serializes them for a reason).

## Data loss / recovery

See docs/backup-restore.md. In short: Convex deployment history covers
function code; document-level recovery comes from the deployment
snapshots + `sweepDataOrphans`-style audits. Practice the restore path
quarterly (the backup doc's checklist) so an S1 never becomes the first
time anyone runs it.
