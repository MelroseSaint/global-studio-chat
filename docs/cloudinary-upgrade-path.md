# Cloudinary upgrade path — when to leave the Free plan

> Researched 2026-09-13 from Cloudinary's own pricing pages
> (`cloudinary.com/pricing/compare-plans`, `cloudinary.com/documentation/billing_and_plans`)
> and the account's live usage endpoint. Verify current prices in the
> dashboard before purchasing — list prices move.

## Where PureWire stands today

Account `saintscloud`, **Free plan**: 25 credits/month, 10 GB storage.

One credit = 1 GB of storage-or-bandwidth mix or 1,000 transformations
(Cloudinary's billing unit — the dashboard's billing page shows the
exact breakdown). Critically, **the Free credit limit is a hard stop**:
at 100%, every upload fails until the cycle resets. The
`cloudinary-quota` CI job alarms at 80%.

Current usage (2026-09-13): **0.73 / 25 credits (2.9%)**, storage
~1.9 MB, bandwidth 0.50 GB/month, ~230 transformations. Effectively
empty — real users haven't arrived yet.

## The plan ladder (list prices, annual-billing discounts exist)

| Plan | Price | Credits/mo | Storage cap | Notable limits |
|---|---|---|---|---|
| Free | $0 | 25 | 10 GB | 10 MB images, **100 MB videos**, 500 Admin API req/h |
| Plus | ~$89–99/mo | 225 | higher | 20 MB images, **2 GB videos**, 2K Admin API req/h |
| Advanced | ~$224–249/mo | 600 | higher | 40 MB images, **4 GB videos**, strict transformations |
| Enterprise | custom | custom | custom | CNAME, S3 backup, expedited support |

For PureWire the two jumps that matter besides credits:

- **Video size**: Free caps a single upload at **100 MB**; Plus allows
  **2 GB**. The composer accepts audio/video today — a 3-minute phone
  video at 1080p can already brush the 100 MB line. This limit fails a
  *single user action*, visibly, before any quota alarm.
- **Admin API rate**: 500 req/h on Free. CI's media QAs (E2E, probe,
  quota guard, per-run deletes) plus real traffic could crowd this;
  the quota job's CI log is the place to watch for Admin API 420/429s.

## The recommendation: upgrade on TRIGGERS, not on a date

The `cloudinary-quota` job converts usage into a leading indicator, so
the upgrade decision is mechanical:

1. **Upgrade to Plus immediately** if any of these fires:
   - the `prod-cloudinary-quota` alert issue opens (credits ≥ 80% or
     the trend projects exhaustion inside 30 days);
   - the weekly ops digest shows credits > 50% two weeks running
     (compound growth of ~60%/month → exhaustion inside a quarter);
   - a user reports a failed upload with a Cloudinary 4xx (size cap or
     credits exhausted) — check `convex logs` for the error shape.
2. **Pre-upgrade mitigations** while on Free (all already in place or
   one-click):
   - the composer already re-encodes media client-side, which keeps
     storage small — keep it that way;
   - `docs/media-storage.md` documents deletion hygiene (no orphans —
     proven by the CI E2E), so storage only grows with real content;
   - if credits climb because of *delivery bandwidth* (hot posts),
     enabling Cloudinary's `fetch`-format auto (`f_auto,q_auto`) on
     delivered URLs cuts credit burn 30–70% with zero code risk.
3. **Choose Plus (not Advanced) first**: 225 credits ≈ 9× current burn
   at ~1/3 the Advanced price, and it lifts both failure-prone caps
   (2 GB video, 2K Admin API). Advanced's extra 375 credits only pay
   off once Plus runs the same 80% alarm.

## Watch items (automated already)

- `cloudinary-quota` (every CI run): credits %, storage %, days of
  headroom → alert issue at the thresholds above.
- `weekly-ops-digest` (Sundays 06:00 UTC): the trend table makes the
  burn rate visible week over week — the earliest human-readable
  signal of a growth phase that will need the upgrade.

The practical summary: at today's 2.9% usage nothing is needed. The
machinery now in place turns "surprise, uploads are down" into a
scheduled, triggered decision — expected roughly at the point where
real-user media makes credits compound past half the Free allowance
for two consecutive weeks.
