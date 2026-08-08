# ADR-0005: Comment engagement model

- **Status:** Accepted
- **Date:** 2026-08-05
- **Related:** [ADR-0004](0004-harness-gated-production-qa.md)

## Context

Commenting is the primary conversation surface. Three pressures shaped the
design:

1. **Flow** — commenting from a post card should not rip the user out of
   their feed; a redirect to a separate page breaks the moment.
2. **Quality** — with many comments, the thread must surface the *best*
   replies, not just the newest, and the preview must show what the thread
   is worth reading.
3. **Consistency** — engagement counters must obey the same discipline as
   post likes (denormalized on the parent, audited for drift), or the
   numbers lie.

## Decision

- **Comment popup over the post** — commenting opens an in-place popup on
  any post card (composer + preview of the thread's best replies + the
  post's own like and comment counts), with a **View comments** link next
  to the comment count for the full post page. No redirect for the common
  case; the post page remains the whole-thread surface.
- **Top sort by like count** — comments rank by like count (highest first)
  with a deterministic tiebreak; **Newest** is one tap away. The like tally
  is denormalized per comment (same counter discipline as posts) and kept
  consistent by an automated backfill migration.
- **Full engagement** — like/unlike any comment (rendered in plain
  language: "3 likes" / "Like"), threaded **replies** hanging one level
  deep under the top-level comment, edit/delete for your own comments, and
  reply counts kept in sync.
- The comment pipeline runs through the same moderation gates as posts
  (phishing, prohibited domains, racism, PoW, automation signals).

## Consequences

### Positive
- Best replies surface first in both the popup preview and the thread;
  engagement is first-class and language-readable.
- Counter consistency is migration-backed and nightly-audited
  (`qa:top-sort`, `qa:count-drift`), so Top ordering stays deterministic.

### Negative
- Two surfaces (popup + post page) must render the same thread state —
  duplication risk if one is extended without the other.
- Denormalized counters need migrations on backfills (the like-count
  backfill) — a one-time operational step now automated by the CI
  migrations workflow.

### Trade-offs / notes
- Replies are deliberately one level deep under top-level comments —
  infinite nesting adds UX complexity without proportional conversational
  value. Revisit only with a clear product reason.
- The like-count denormalization mirrors post likes so a single counter
  discipline applies platform-wide.
