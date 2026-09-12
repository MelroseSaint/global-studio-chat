# Code review policy

## How changes land

- **Direct pushes to `main`** are reserved for the repository owner's
  solo workflow; every push still runs the full CI gauntlet (Static
  Audit + Production Healthcheck + Deploy) and failure opens a
  deduplicated alert issue. CI is the always-on reviewer.
- **Pull requests** (including Dependabot's) run Static Audit against
  the PR branch. A PR needs a green Static Audit before merge. When a
  second maintainer exists, add them to `CODEOWNERS` so review
  assignment is automatic — the file ships today with sensible defaults.

## What every change must satisfy (enforced by CI)

| Gate | Workflow | Job |
| --- | --- | --- |
| Typecheck (`tsc -b`) | Static Audit | Typecheck |
| Lint (`eslint .`) | Static Audit | ESLint |
| Unit tests (`vitest run`) | Static Audit | Unit tests |
| Production build + critical-path size guard | Static Audit | Vite build |
| Secret hygiene (no live credentials in the tree) | Static Audit | Secrets scan |
| Vulnerable dependencies (`npm audit` high+) | Static Audit | Dependency audit |
| Media architecture ("Cloudinary holds the bytes") | Healthcheck | Media architecture guard |
| Test isolation (QA fixtures invisible to members) | Healthcheck | Test isolation QA |
| Moderation / phishing / blocklist behavior | Healthcheck | respective QA jobs |
| SEO surfaces (sitemap, robots, dynamic render) | Healthcheck | seo-live-guard |

## Review checklist (for PRs and for self-review before push)

1. **Behavior**: does the change do what the commit message claims?
2. **Security**: any new external input parsed? (see docs/security-review.md)
3. **Privacy**: does the change move user data anywhere new? Media must
   follow docs/media-storage.md (Convex stores references, Cloudinary
   stores bytes).
4. **Isolation**: does the change add QA fixtures or test accounts?
   They must use the `qa_` namespace and clean up after themselves.
5. **Performance**: does the change add to the critical path? The build
   job's size guard fails regressions; check the diff it reports.
6. **Ops**: does the change need a new env var, secret, or dashboard
   setting? Update docs/secrets-setup.md in the same PR.

## Emergency exception

During an active incident (see docs/incident-response.md), fixes may
push directly to `main` while CI runs after the fact. The incident
report must note every commit that bypassed the green-gate order.
