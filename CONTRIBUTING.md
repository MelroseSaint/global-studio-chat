# Contributing to PureWire

PureWire is a social platform built around expression, connection, and
freedom. The engineering bar is set by the product promise: verified
original, human-made only, no adult platforms, no scams, no hate, and real
people. Contributions are held to that standard.

- [Before you start](#before-you-start)
- [Setup](#setup)
- [Branches](#branches)
- [Commit conventions](#commit-conventions)
- [Pull requests](#pull-requests)
- [Testing expectations](#testing-expectations)
- [Documentation & ADRs](#documentation--adrs)
- [Deploying](#deploying)

## Before you start

- Read [`README.md`](README.md) — it is the source of truth for features,
  architecture, privacy, and QA.
- Read [`docs/architecture.md`](docs/architecture.md) for how the pieces
  fit together, and [`docs/adr/`](docs/adr/) for the decisions that shaped
  the system. If your change reverses or extends one of those decisions,
  say so in the PR and update the ADR.
- Check open issues/PRs so you don't duplicate work.

## Setup

Follow [`docs/setup.md`](docs/setup.md): clone, `npm install`, copy
`.env.example` → `.env.local`, and `npm run dev`. The install's
`postinstall` step installs the `.githooks/pre-push` hook automatically —
**do not skip it**; it is what keeps pushes deployable.

## Branches

Branch names describe the work, not the author:

| Prefix | Purpose | Example |
| --- | --- | --- |
| `feat/` | New user-facing capability | `feat/comment-likes` |
| `fix/` | Bug fix | `fix/empty-avatar-crash` |
| `docs/` | Documentation, ADRs, templates | `docs/adr-log` |
| `qa/` | QA scripts, CI hardening, guards | `qa/sitemap-url-health` |
| `chore/` | Tooling, deps, refactors with no behavior change | `chore/dep-audit` |

Work directly on `main` is fine for tiny changes; anything that touches
behavior, CI, or docs benefits from a branch + PR so Static Audit runs.

## Commit conventions

- **Subject line**: lowercase, imperative, ≤ ~72 chars — `feat: comment
  likes with plain-language counts`, `fix: resolve sitemap host drift`,
  `docs: add ADR-0004 for harness-gated QA`.
- Conventional-commit prefixes: `feat`, `fix`, `docs`, `refactor`, `test`,
  `chore`, `ci`, `perf`. A scope is optional (`ci(healthcheck): …`).
- **Author email**: every commit must be authored with the repo email so
  the `.githooks/pre-push` hook passes and Vercel accepts the deploy.
  Fix a bad range with:
  `git rebase --exec 'git commit --amend --reset-author --no-edit' <base>`
- **History**: prefer a handful of meaningful commits over one giant dump —
  but never rewrite history that has already been pushed to `main`.

## Pull requests

1. Open the PR from your branch against `main`. The template
   (`.github/PULL_REQUEST_TEMPLATE.md`) scaffolds the description — fill
   every section.
2. **Static Audit runs automatically** on the PR: typecheck, lint, build,
   secrets scan, sitemap/SEO guards, and the parallel QA jobs. It must be
   green before review. The production-facing harness QAs retry once on
   transient failure (`scripts/retry-once.sh`) — a red run that stays red
   after the retry is a real regression, not a flake.
3. Review is human-first: small PRs, concrete test plans, screenshots for
   UI. Address comments with new commits; the branch is **squash-merged**
   into `main` so the PR lands as one clean commit.4. Never merge a PR with failing Static Audit unless the failure is
explicitly unrelated and documented in the PR body.

**Merge style:** this repo's convention is **squash-and-merge** — the PR
lands as one clean conventional commit on `main`. If branch settings ever
offer a merge commit instead, prefer squashing to keep the history linear.

**Clean history, in practice:** one focused PR → one squashed commit on
`main` with a conventional-commit message that references the issue or ADR.
That is what makes `git log --oneline main` read like a changelog.

## Testing expectations

- Always run `npm run typecheck && npm run lint && npm run build` before
  opening a PR.
- New behavior gets a QA script (`scripts/*.mjs`) following the existing
  convention, wired into a workflow so it runs nightly/on push — see
  [`docs/ci-cd.md`](docs/ci-cd.md) for where each suite lives.
- Harness-gated scripts need `TEST_HARNESS_SECRET` (+ `TEST_HARNESS_ENABLED`
  on the deployment) and exit 2 without it — never run them against a
  production deployment that has the harness enabled outside a QA window.
- The retry-once wrapper (`scripts/retry-once.sh`) absorbs transient
  failures in CI. If a QA flaked only once, don't paper over it — find the
  flake or document why it is genuinely transient.

## Documentation & ADRs

- **Docs live with the code.** Behavior, setup, env vars, or CI changes
  update `README.md` and the matching page in `docs/` in the same PR.
- **Consequential decisions get an ADR.** If a change is hard to reverse
  (schema, security posture, delivery topology, a new external service) or
  shapes how future work happens, add one to `docs/adr/` using the template
  in [`docs/adr/README.md`](docs/adr/README.md). Number it, mark it
  Accepted, and reference it from the PR.

## Deploying

- Pushes to `main` deploy automatically (Vercel frontend + Convex backend +
  migrations — see [`docs/ci-cd.md`](docs/ci-cd.md)). You normally never
  deploy by hand.
- Manual full deploy: `npm run deploy` (backend → version upload → web).
- Before pushing, confirm `git config user.email` matches the repo email —
  the pre-push hook will block you otherwise, by design.

---

© PureWire. Say it anyway — no ads, ever.
