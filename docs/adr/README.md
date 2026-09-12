# Architectural Decision Records

An Architectural Decision Record (ADR) captures a consequential decision —
its context, the decision, and its consequences — so future changes start
from *why* the system is the way it is, not from re-deriving it.

## Current records

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-repo-owned-canonical-host.md) | Repo-owned canonical host | Accepted |
| [0002](0002-dynamic-rendering-for-seo.md) | Dynamic rendering for SEO | Accepted |
| [0003](0003-dynamic-sitemap-and-health-gates.md) | Dynamic sitemap + health gates | Accepted |
| [0004](0004-harness-gated-production-qa.md) | Harness-gated production QA | Accepted |
| [0005](0005-comment-engagement-model.md) | Comment engagement model | Accepted |
| [0006](0006-backend-verified-admin-ip-binding.md) | Backend-verified admin IP binding | Accepted |
| [0007](0007-redis-free-scaling.md) | Redis-free scaling to 1M+ users | Accepted |

## When to write one

Write an ADR when the decision is:

- **Hard to reverse** — schema changes, migrations, security posture,
  delivery topology, a new external service.
- **Architecture-shaping** — how future work happens (a pipeline, a
  convention, a gate).
- **Expensive to rediscover** — anything a future contributor would
  otherwise have to reverse-engineer or re-litigate.

Small, easily-changed choices do **not** need an ADR — that's what PR
descriptions and code comments are for. When in doubt, write it: a
half-page ADR is cheap; re-deriving a decision is not.

## Statuses

| Status | Meaning |
| --- | --- |
| Proposed | Under discussion; not yet binding |
| Accepted | The decision stands; the system implements it |
| Superseded | A later ADR replaced this one (the later ADR references it) |
| Deprecated | No longer relevant; kept for history |

Accepted ADRs are **append-only**: never edit the decision of an accepted
record. If reality changes, write a new ADR that supersedes it and update
the old record's status line.

## Format

Each record lives in `docs/adr/NNNN-short-title.md` and follows the
template below. Keep them short: context, decision, consequences. The
consequences section is the part that earns its keep.

## Template

```markdown
# ADR-NNNN: <Short title>

- **Status:** Proposed | Accepted | Superseded | Deprecated
- **Date:** YYYY-MM-DD
- **Related:** ADR-XXXX (link)

## Context

What problem or pressure forced this decision? What was considered?

## Decision

The decision, stated plainly — one or two sentences.

## Consequences

### Positive
- ...

### Negative
- ...

### Trade-offs / notes
- Anything a future reader must know: what was deliberately not done,
  what to revisit, how to detect drift.
```
