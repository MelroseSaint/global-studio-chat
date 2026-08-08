# Setup

Straightforward path from a fresh clone to a running local app (and, when
you need it, to a deploy). The complete env-var reference lives in
`.env.example` — this page is the *sequence*, the other is the *dictionary*.

## Prerequisites

- **Node.js 22+** and npm (the CI runs Node 22). Use `nvm` / `nvm-windows` /
  `fnm` if you need a specific version.
- **Git**. No GitHub CLI is required for day-to-day work; `gh` is only used
  for some CI tooling.
- Optional: **Vercel CLI** (`npm i -g vercel`) for manual deploys, and
  **Playwright browsers** if you run the browser-session QA scripts.

## 1. Clone and install

```bash
git clone <repo-url> global-studio-chat
cd global-studio-chat
npm install
```

`npm install` runs a `postinstall` step that installs the `.githooks/pre-push`
hook into `.git/hooks/pre-push`. The hook blocks pushes whose commits are
not authored with the repo email — this is what keeps Vercel deploys
accepted, so don't disable it.

## 2. Environment

Configuration lives in two places (see `.env.example` for the annotated
reference):

**Frontend (Vite, build-time):**

```bash
cp .env.example .env.local
```

Then set the public values in `.env.local`:

| Variable | Local value |
| --- | --- |
| `VITE_CONVEX_URL` | your Convex deployment URL. The committed `.env.production` already points at production, so `npm run dev`/`build` work out of the box |
| `VITE_TURNSTILE_SITE_KEY` | optional; empty disables the human-check widget |

**Backend (Convex, runtime — secrets):**

```bash
npx convex env set NAME value   # per variable, on the deployment you use
```

| Variable | Purpose | Required? |
| --- | --- | --- |
| `RESEND_API_KEY` | Email delivery (signup/reset codes) | Required for emails to send |
| `EMAIL_FROM` | Verified sender address | Defaults to `PureWire <noreply@purewire.com>` |
| `EMAIL_HASH_SALT` | Salt for email hashing | Required in production |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile verify | Only if Turnstile is enabled |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_UPLOAD_PRESET` | Unsigned upload preset | Optional (media falls back to Convex storage) |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Signed deletes + video re-uploads | Optional |
| `TEST_HARNESS_ENABLED` / `TEST_HARNESS_SECRET` | QA harness | **Disabled in production on purpose** — see QA below |

**Vercel (project env, build-time):** `PUREWIRE_SITE_URL` should be set to
the canonical host (default `https://purewire.vercel.app`; set explicitly
so the dashboard self-documents it). `VITE_SITE_URL` is deprecated and
ignored — a CI guard fails if it is ever re-added.

## 3. Run

```bash
npx convex dev     # start a local Convex backend (or point at your deployment)
npm run dev        # Vite dev server
```

Two terminals, done. The app opens on the Vite port and talks to Convex.

## 4. Verify you're set up

```bash
npm run typecheck
npm run lint
npm run build
```

All three must pass — they are the same gates Static Audit runs on every PR.

## 5. Run the QA suite

Every `scripts/*.mjs` QA runs locally with `npm run qa:<name>` against the
live site. Harness-gated scripts need two things on the deployment you're
targeting:

1. `TEST_HARNESS_ENABLED=1` set on Convex, and
2. `TEST_HARNESS_SECRET` passed to the script (or set in the environment).

Without them the script exits 2 and refuses to run — by design. Never leave
the harness enabled on a production deployment outside a QA window.

A fast local sanity pass:

```bash
npm run qa:secrets      # no leaked secrets in the repo
npm run qa:racism       # 72 adversarial cases, deterministic, local
npm run qa:phishing     # scanner tiers, deterministic, local
npm run qa:blocklist    # domain engine (harness-gated)
```

Browser-session QAs need Playwright: `npx playwright install --with-deps chromium`.

## 6. Deploy

Pushes to `main` deploy automatically (frontend + backend + migrations).
Manual full deploy when you need it:

```bash
npm run deploy          # deploy:backend → upload:version → deploy:web
```

| Piece | Command | What it does |
| --- | --- | --- |
| Backend | `npm run deploy:backend` | `npx convex deploy` (functions + schema) |
| Static version | `npm run upload:version` | Build + sync the static version to Convex hosting |
| Web | `npm run deploy:web` | `npx vercel --prod` |

Before any push, confirm `git config user.email` matches the repo email —
the pre-push hook blocks the push otherwise (and Vercel would silently
reject the deploy).

## Troubleshooting

- **Push blocked: "wrong commit author email"** — reset authors in the
  range: `git rebase --exec 'git commit --amend --reset-author --no-edit' <base>`
- **Emails don't send locally** — `RESEND_API_KEY` missing or the sandbox
  sender can only reach your own inbox; verify a real domain in Resend.
- **Deploy cap "api-deployments-free-per-day"** — the Vercel free tier
  caps deployments/day; wait for the window or check whether the nightly
  drift-redeploy hit the same limit.
- **A QA script exits 2** — harness not enabled / secret missing on the
  target deployment (not a bug).
- **A QA script exits 1 once then passes** — that's the retry-once wrapper
  absorbing a transient flake; if it flaked twice, it's a real regression.

See also [`architecture.md`](architecture.md) and
[`ci-cd.md`](ci-cd.md) for how it all fits together.
