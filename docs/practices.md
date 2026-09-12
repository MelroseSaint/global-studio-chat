# Operations & engineering practices — doc index

PureWire's platform engineering docs, one concern per file:

| Doc | Concern |
| --- | --- |
| [code-review.md](code-review.md) | How changes land, review checklist, CI gates table |
| [security-review.md](security-review.md) | Security invariants, dependency/supply-chain policy, accepted risks |
| [staging.md](staging.md) | Staging environment (Convex dev + Vercel previews) |
| [observability.md](observability.md) | Monitoring via CI, deployment probes, alert issues |
| [incident-response.md](incident-response.md) | Severity ladder, S1/S2 playbook, known fast paths |
| [backup-restore.md](backup-restore.md) | What needs backup, quarterly drill, restore procedures |
| [media-storage.md](media-storage.md) | Media architecture invariant + the Cloudinary flip runbook |
| [ci-cd.md](ci-cd.md) | Pipeline overview and the deploy paths |
| [secrets-setup.md](secrets-setup.md) | One-time GitHub secrets/variables checklist |

The single sentence version: every change passes typecheck, lint, unit
tests, build, secret scan, and dependency audit; production is verified
end to end by the healthcheck workflow whose failures open deduplicated
issues; incidents have a rehearsed playbook; media bytes live in
Cloudinary while Convex stores references; restores have been practiced.
