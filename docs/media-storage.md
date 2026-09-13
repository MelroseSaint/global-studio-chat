# Media storage — architecture and operations

## The invariant

**Cloudinary holds the media bytes. Convex stores only a reference.**

Every media item on a post, story, comment, or profile is one of exactly
two shapes:

| Mode | Shape | Bytes live |
| --- | --- | --- |
| `cloudinary` | `url` = `https://res.cloudinary.com/...` secure_url + `key` = public_id | Cloudinary (`saintscloud`) |
| `convex` (fallback) | `storageId` = Convex storage id | Convex file storage |

Never both on one item, never bytes embedded in the reference
(`blob:`/`data:`/`base64`), never a foreign host. Uploads are re-encoded
in the browser (EXIF/GPS/device metadata stripped) before leaving the
client, and the server-side video remux still overwrites pass-through
clips.

## Enforced where

- **`media.prepareUpload`** (`src/convex/media.ts`) mints the upload
  ticket: a Cloudinary upload URL (with signed delete/re-upload
  credentials server-side) when `CLOUDINARY_*` is configured, a Convex
  upload URL otherwise. Bytes never pass through Convex functions.
- **`auditMediaArchitecture`** (`src/convex/testHarness.ts`) scans every
  media reference on posts, stories, and comments for shape violations.
- **`scripts/media-architecture-qa.mjs`** (`npm run qa:media-architecture`,
  CI job *Media architecture guard*) runs that audit **and** probes the
  live pipeline: it mints an admin session, calls `prepareUpload`, and
  fails if the ticket mode disagrees with the declared mode
  (`MEDIA_MODE_EXPECTATION` repo variable, default `convex`).
- **Static grep gate**: `grep -rn "ctx.storage" src/convex` must only hit
  `mediaStorage.ts` (the upload gate) — see the Static Audit workflow's
  media-architecture step.

## Current state (2026-09-12)

Production deployment `jovial-axolotl-209` runs in **fallback mode**:
`CLOUDINARY_*` is not set on the deployment, so `prepareUpload` mints
Convex upload URLs. `MEDIA_MODE_EXPECTATION` = `convex` matches reality,
so the guard is green.

The Cloudinary credentials **already exist as GitHub repo secrets**
(`CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`
— CI's `cloudinary-upload` job passes with them). They have NOT been
transferred to the deployment because that needs one of:

1. a working `CONVEX_DEPLOY_KEY` repo secret (the current one is stale —
   it predates the deployment recreation), or
2. one manual command from the account owner (below).

## Flip procedure (fallback → cloudinary)

### Option A — rotate the deploy key, let CI do it (recommended)

> **Status 2026-09-12: the migration is COMPLETE via Option B.** All four
> `CLOUDINARY_*` env vars are on the deployment (preset `purewire_unsigned`
> created for the unsigned path; the signed key+secret path is primary and
> verified by `qa:cloudinary-health`), and `MEDIA_MODE_EXPECTATION` is
> `cloudinary` — the live pipeline mints cloudinary tickets. The repo's
> `CONVEX_DEPLOY_KEY` has since been replaced with a real production
> deploy key (format `prod:<deployment>|<payload>`); the workflows run
> all Convex CLI calls bare (the key self-targets — an explicit
> `--deployment`/`CONVEX_DEPLOYMENT` override 401s under key-only
> environments) and fail fast when the secret holds a non-`prod:` value.

1. Convex dashboard → team `monroedoses` → project PureWire →
   Settings → Access Keys → **Deploy key** → create.
2. GitHub → repo → Settings → Secrets and variables → Actions → update
   `CONVEX_DEPLOY_KEY`.
3. Push any commit to `main` (or re-run *Migrations*) and the
   "Sync Cloudinary env from repo secrets" step sets
   `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and
   `CLOUDINARY_API_SECRET` on the deployment (never printing them).
4. Flip the `MEDIA_MODE_EXPECTATION` repo **variable** to `cloudinary`
   (Settings → Secrets and variables → Actions → Variables). This stays
   a manual one-click step on purpose: a workflow can only mutate repo
   settings with `administration: write`, which GitHub rejects at
   startup for user-owned repositories. The expectation can never lead
   the capability — until you flip it, the Media architecture guard
   keeps asserting the honest current mode.

### Option B — one manual command

```bash
# from the repo root, CLI authenticated against the prod deployment
npx convex env set CLOUDINARY_CLOUD_NAME saintscloud
npx convex env set CLOUDINARY_API_KEY <api key — held privately; correct
# value is in the repo secret CLOUDINARY_API_KEY and .env.local (gitignored)>
npx convex env set CLOUDINARY_API_SECRET <secret>
npx convex env set CLOUDINARY_UPLOAD_PRESET <unsigned preset name>
```

Then flip the `MEDIA_MODE_EXPECTATION` repo **variable** to
`cloudinary` (Settings → Secrets and variables → Actions → Variables).
Without it the Media architecture guard keeps asserting `convex`, which
stays honest until the flip is intentional.

### Cloudinary dashboard prerequisites

- The API key must keep **Upload / create** permission (Settings →
  Access Keys → edit the key).
- An **unsigned upload preset** must exist (Settings → Upload →
  Upload presets → Signing mode: Unsigned) and its name set as
  `CLOUDINARY_UPLOAD_PRESET` (only used for the unsigned browser path;
  the signed path needs only key + secret).

## What changes at flip (and what doesn't)

- Zero downtime, no frontend redeploy: the client reads the ticket mode
  per upload. New uploads go straight to Cloudinary.
- Media created **before** the flip keeps its Convex `storageId` and
  keeps rendering — the bytes stay in Convex storage for history. The
  audit reports them as legacy rather than invalid.
- Deletes, the video remux, and cleanup already sign against Cloudinary
  via the server-held secret; they start deleting real Cloudinary assets
  (invalidation included) as soon as the env lands.
- Storage quota growth on Convex stops the moment the flip lands.

## Account hardening (applied 2026-09-13)

- `purewire_unsigned` is locked down: **folder-restricted to `purewire/`**
  (`asset_folder`), an allowed-formats allowlist matching the composer
  (`png,jpg,jpeg,webp,gif,mp4,webm,mov,mp3,wav,m4a,ogg`), unique
  filenames, and `overwrite: false` — so an unsigned upload can never
  plant files elsewhere or clobber existing assets. (The preset had been
  created with completely empty settings.)
- The signed path (primary) ignores presets entirely; its folder comes
  from the server-minted ticket (`folder: purewire`).
- Every QA that uploads through `prepareUpload` now discards rejected
  uploads (`media.discardUploads`) and the CI E2E requires the CDN to
  404 after deletion — a leaked asset fails the build instead of
  silently accumulating in the member's Cloudinary library.
- `qa:cloudinary-e2e` runs in the Production Health Check as
  `cloudinary-e2e` (harness-gated, own `prod-cloudinary-e2e` alert
  label) proving the URL-only invariant and zero orphans on every run.
