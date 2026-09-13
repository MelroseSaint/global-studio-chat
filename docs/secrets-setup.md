# GitHub secrets — one-time setup checklist

Every workflow is already wired; nothing in the YAML needs editing. The
steps below only configure the **repository** so CI can authenticate. Do
them once, in this order, and push to `main` to see the pipelines go
green end to end.

Where: GitHub → repository → **Settings → Secrets and variables →
Actions**. Secrets go under *Secrets*; `SITE_URL` / `CONVEX_URL` go under
*Variables* (they are not sensitive).

## 1. `VERCEL_TOKEN` — deploys the frontend

Create a Vercel token:

1. vercel.com → account menu → **Account Settings → Tokens**.
2. **Add**, name it `purewire-github-ci`, scope it to the
   `melrosesaints-projects` team (the project `purewire` lives there —
   `.vercel/project.json` is the source of truth), expiry 1 year.
3. Copy the value → add as the repo secret `VERCEL_TOKEN`.

Consumers: `deploy.yml` (production deploy), `redeploy-drift.yml`
(nightly drift redeploy), `production-healthcheck.yml` (env guard +
build-log warning guard). No team/org IDs needed in the secret — the
workflows pass them explicitly.

## 2. `CONVEX_DEPLOY_KEY` — deploys the backend

Create a deploy key:

1. dashboard.convex.com → deployment `jovial-axolotl-209` →
   **Settings → Deploy Keys → Generate a deploy key** (give it the
   `deployment:deploy` permission; add env read/write if CI should also
   sync `CLOUDINARY_*`).
2. The key looks like `prod:jovial-axolotl-209|eyJ2…0=` — a real Convex
   deploy key always starts with a scope (`prod:`/`dev:`/`preview:`)
   followed by `<deployment>|<payload>`. Copy it → add as the repo
   secret `CONVEX_DEPLOY_KEY`.

   ⚠️ Don't mix it up with the Cloudinary API secret — this repo once
   had the two swapped, and every Convex workflow 401s with a misleading
   `MissingAccessToken`. The workflows now fail fast on a non-`prod:`
   value with a pointed error.
3. **Never add `--deployment` or `CONVEX_DEPLOYMENT` to a CLI call that
   runs under the key** — the key self-targets its deployment, and an
   explicit override routes through a user-token endpoint that 401s
   (`MissingAccessToken` / `team_and_project`).

Consumers: `migrations.yml` (deploys backend + runs migrations, runs
`scripts/ensure-jwt-keys.mjs` first so JWT_PRIVATE_KEY/JWKS can never be
missing — the fresh-deployment incident of 2026-09-11), the backend
deploy in `redeploy-drift.yml`, and the convex.site mirror sync in
`deploy.yml` (that job fails loudly, not skips, when the key is unset).

After setting it, run **Run Convex migrations** manually from the
Actions tab once — it deploys the current functions and records the
deployed commit for the drift check.

## 3. `TEST_HARNESS_SECRET` — the production QAs

The harness QAs are wired in CI but inert without this:

1. Pick a long random value
   (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).
2. Set it on the deployment **and** as the repo secret:
   ```bash
   npx convex env set --deployment jovial-axolotl-209 TEST_HARNESS_ENABLED 1
   npx convex env set --deployment jovial-axolotl-209 TEST_HARNESS_SECRET <value>
   ```
   `--deployment` must come before the value — see the CLI gotcha in
   `.freebuff/run.md` (values starting with `-` or `-----BEGIN` parse as
   flags otherwise).
3. Repo secret `TEST_HARNESS_SECRET` = the same value. That is the only
   credential the admin-path QAs need: the harness mints admin sessions
   for them (admin-ip, admin-responsive, pages-inflation all support
   this since 2026-09).

> ⚠️ **Do not (re-)add an `ADMIN_PASSWORD` repo secret.** It was
> deliberately retired: every CI consumer authenticates through the
> harness instead, and a real admin password has no business sitting in
> repo secrets where any workflow edit could read it. The QAs still
> accept a local `ADMIN_PASSWORD` env override for interactive runs
> (`.freebuff/.admin-password`), but CI never needs one. If a future QA
> genuinely needs the real password, gate it on a dedicated secret and
> justify it in review — don't resurrect this name.

## 4. `RESEND_API_KEY` — the auth-loop e2e

The nightly auth loop reads verification-code emails through Resend's
API. Use the same `re_…` key that is already set on the deployment.

## 5. Variables (not secrets)

- `CONVEX_URL` (var) = `https://jovial-axolotl-209.convex.cloud`
- `SITE_URL` (var) = `https://purewire.vercel.app`

Both have defaults in the workflows, so they only matter when the
default drifts from reality.

## 6. CLOUDINARY_* — flip media off Convex storage

The pipeline is already dual-mode and prefers Cloudinary the moment the
env exists, on BOTH sides:

- **Convex deployment** (runtime — the browser's upload tickets come
  from here):
  ```bash
  npx convex env set --deployment jovial-axolotl-209 CLOUDINARY_CLOUD_NAME saintscloud
  npx convex env set --deployment jovial-axolotl-209 CLOUDINARY_API_KEY <key>
  npx convex env set --deployment jovial-axolotl-209 CLOUDINARY_API_SECRET <secret>
  ```
  With the API key + secret set, `prepareUpload` mints **signed**
  upload credentials (no dashboard-created unsigned preset needed) and
  the client uploads straight to Cloudinary — bytes never pass through
  Convex storage, which keeps the file-storage quota untouched. Signed
  deletes and the video remux overwrite also start working.
- **GitHub secrets** `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` (+
  `CLOUDINARY_UPLOAD_PRESET` only if you keep the unsigned preset) so
  the nightly `cloudinary-health` probe and the signup e2e's
  signed-destroy verification run.

Verify with `npm run qa:cloudinary-health` (probe uploads + destroys a
tiny PNG), then `npm run qa:media-architecture` once the harness is
enabled (asserts zero invalid media references).

## 7. Verify

Push to `main` (or use workflow_dispatch) and expect:

- **Deploy to Vercel** — green deploy, then the mirror-sync job.
- **Run Convex migrations** — backend deploy + `ensure-jwt-keys` no-op.
- **Production Health Check** — the auth loop, admin IP binding,
  cloudinary probe, and the SEO guards all green.

One caution: the first green `deploy.yml` run enables the Vercel deploy
on every push to `main`. That is the intended behavior — the Vercel
project is connected by CLI token, not by a GitHub App, so CI is the
only deploy path.
