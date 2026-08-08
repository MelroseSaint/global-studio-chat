# PureWire documentation

Structured knowledge for the PureWire platform. The `README.md` at the repo
root is the product-facing overview; these pages go deeper.

## Index

| Page | Contents | Read it when… |
| --- | --- | --- |
| [`architecture.md`](architecture.md) | Layers, source map, content pipeline, deployment topology, invariants | You need to know how the pieces fit before changing one |
| [`setup.md`](setup.md) | Clone → install → env → run → QA → deploy, end to end | You are setting up a dev environment or a fresh deployment |
| [`ci-cd.md`](ci-cd.md) | The six GitHub Actions workflows, the alert model, required secrets/vars | You changed CI, added a QA script, or need to know what runs where |
| [`adr/`](adr/) | Architectural decision records — every consequential decision and why | You are about to make (or question) an architectural decision |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | PR workflow, commit conventions, clean-history rules | You are opening a PR |
| [`../README.md`](../README.md) | Product features, moderation pipeline, privacy, QA suite | You need the product overview or the full env-var reference |

## Reading paths

- **New contributor** → `setup.md`, then `architecture.md`, then the ADR
  log for context on why things are the way they are.
- **Platform owner / CI** → `ci-cd.md`, plus `setup.md` for the deploy
  path and secrets.
- **Making a decision** → check `adr/` first for a superseding or related
  decision; if none exists and the change is consequential, write one
  (template in `adr/README.md`).

## Conventions

- Facts here are verified against the live repo (README, workflows,
  scripts, env examples). If a page drifts from the code, the page is
  wrong — fix it in the same PR that changes the behavior.
- URLs, hosts, and env-var names are written exactly as they appear in
  `.env.example`, `vite.config.ts`, and the workflows.
- ADRs are append-only; never edit the *decision* of an accepted ADR — add
  a new ADR that supersedes it.
