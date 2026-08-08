<!--
  One PR, one purpose. Small, reviewable, squash-merged — that's what keeps
  `main` history clean. If this PR does more than one thing, split it.
  Fill in the sections below and delete the comments.
-->

## What

<!-- One or two sentences: what does this PR change for the user/platform? -->

## Why

<!-- The problem this solves. Reference an issue or ADR when one exists:
  "Implements ADR-0004" or "Fixes #123". -->

## How

<!-- The approach, at a glance. What moved, what was added, what was deleted.
  If a decision was made here that will outlive the PR, it belongs in
  docs/adr/ — link it. -->

## Test plan

<!-- Exactly how a reviewer verifies this. Prefer commands from docs/setup.md
  and the QA suite. Static Audit runs automatically on this PR — say what
  else was run locally:
    - [ ] `npm run typecheck`
    - [ ] `npm run lint`
    - [ ] `npm run build`
    - [ ] targeted QA (e.g. `npm run qa:blocklist`) with TEST_HARNESS_SECRET
-->

## Screenshots / evidence

<!-- Before/after for UI changes. CLI output or log excerpts for backend. -->

## Checklist

- [ ] Changes are focused on a single purpose (no unrelated edits)
- [ ] Typecheck, lint, and build pass locally
- [ ] New behavior is covered by a `scripts/*-qa.mjs` script or an existing one was updated
- [ ] README / `docs/` updated where behavior, setup, or CI changed
- [ ] A consequential or irreversible decision is captured as an ADR in `docs/adr/`
- [ ] Commits are authored with the repo email so the pre-push hook and Vercel deploys accept them

## Notes for the reviewer

<!-- Anything unusual: a known flake the retry-once wrapper may absorb,
  a migration that needs a deploy order, an env var that must be set first. -->
