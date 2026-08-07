import { normalizeEmailIdentity } from "@/lib/format";

import {
  currentEmailHashVersion,
  emailHashSaltForVersion,
  saltedEmailHash,
} from "./privacy";

import { internalMutation } from "./_generated/server";

// NOTE FOR NEW MIGRATIONS: after defining a migration here, register it in
// the `steps` list of migrationsRunner.ts — the nightly CI job runs that
// runner, so an unregistered migration would never execute automatically.
// Each migration must stay idempotent (it runs on every push and nightly).

/**
 * One-pass email-hash re-salt migration.
 *
 * Rotating the salt (EMAIL_HASH_SALT_V2, EMAIL_HASH_VERSION=2, redeploy)
 * only affects *new* hashes unless every existing row is converged. This
 * mutation walks the whole users table and re-salts every hash with the
 * current active version, so no user ever waits for their next sign-in to
 * be re-salted.
 *
 * Idempotent and cheap: rows whose stored hash + version already match the
 * current salt are skipped, so re-running after a partial failure is safe.
 * Run it with:
 *
 *   npx convex run internal.migrations.rehashEmailHashes
 *
 * It returns how many rows were scanned and how many were rewritten.
 */
export const rehashEmailHashes = internalMutation({
  handler: async (ctx) => {
    const version = currentEmailHashVersion();
    // Pre-flight: refuse to run if the active version's salt is missing.
    // The hash function itself throws a user-safe message (it also runs on
    // the sign-in path); here the operator gets the exact fix. Re-salt only
    // with a real salt — never rewrite hashes to unsalted ones.
    if (version > 1 && emailHashSaltForVersion(version).length === 0) {
      throw new Error(
        `EMAIL_HASH_SALT_V${version} is not configured. Set it, then re-run this migration.`,
      );
    }
    let scanned = 0;
    let rewritten = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await ctx.db
        .query("users")
        .withIndex("by_creation_time")
        .paginate({ numItems: 100, cursor });
      for (const user of page.page) {
        scanned++;
        // Rows without a stored address (pre-auth library, or anonymous
        // leftovers) have nothing to hash — leave them untouched.
        if (user.email === undefined || user.email === null) {
          continue;
        }
        const canonicalEmail = normalizeEmailIdentity(user.email);
        const emailHash = await saltedEmailHash(canonicalEmail, version);
        if (user.emailHash !== emailHash || user.emailHashVersion !== version) {
          await ctx.db.patch(user._id, { emailHash, emailHashVersion: version });
          rewritten++;
        }
      }
      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }
    return { version, scanned, rewritten };
  },
});

/**
 * One-pass backfill of the private removal log.
 *
 * Before the dedicated removalLog table existed, permanent removals were
 * recorded as moderationLog rows with action "remove" (preserved by the
 * erasure sweep). This migration copies those legacy rows into removalLog
 * so the one-way audit trail — who was removed, when, by whom — stays
 * complete after the switch. Identity fields that were never snapshotted
 * under the old scheme (display name, email hash) simply stay absent on
 * the backfilled rows; the username is carried over from the old
 * targetUsername snapshot when it exists.
 *
 * Idempotent: rows whose userId + creation time already exist in
 * removalLog are skipped, so re-running after a partial failure is safe.
 * Once a legacy row is copied, it is deleted from moderationLog — the
 * copy is the source of truth, and leaving the old schema-orphaned row
 * behind would be permanent dead data. Run it with:
 *
 *   npx convex run internal.migrations.backfillRemovalLog
 *
 * It returns how many legacy rows were found and how many were copied.
 */
export const backfillRemovalLog = internalMutation({
  handler: async (ctx) => {
    let found = 0;
    let copied = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await ctx.db
        .query("moderationLog")
        .order("asc")
        .paginate({ numItems: 100, cursor });
      for (const row of page.page) {
        // The "remove" literal was dropped from the schema union when the
        // removalLog table replaced it — legacy rows still carry it at
        // runtime, so compare against the raw value.
        if ((row.action as string) !== "remove") {
          continue;
        }
        found++;
        // Idempotency: an already-backfilled row is skipped.
        const existing = await ctx.db
          .query("removalLog")
          .filter((q) =>
            q.and(
              q.eq(q.field("userId"), row.targetUserId),
              q.eq(q.field("_creationTime"), row._creationTime),
            ),
          )
          .first();
        if (existing !== null) {
          continue;
        }
        // The old snapshot field (targetUsername) no longer exists on the
        // typed moderationLog doc — read it off the raw row.
        const legacy = row as typeof row & { targetUsername?: string };
        await ctx.db.insert("removalLog", {
          userId: row.targetUserId,
          username: legacy.targetUsername ?? undefined,
          actorId: row.actorId ?? undefined,
          standardId: row.standardId ?? undefined,
          note: row.note ?? undefined,
        });
        // The copy is committed; the legacy row is now redundant and no
        // longer matches the schema union — remove it so no orphaned dead
        // data lingers in moderationLog.
        await ctx.db.delete(row._id);
        copied++;
      }
      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }
    return { found, copied };
  },
});

/**
 * One-pass backfill of comments.likeCount to 0.
 *
 * Comments created before the like feature keep likeCount undefined. The
 * "Top" comment sort's by_post_likes index handles that fine (missing
 * values sort last under order("desc")), but an explicit 0 makes ordering
 * fully deterministic and matches the docs-recommended practice of
 * defaulting indexed counters. Idempotent — rows that already carry a
 * number are skipped. Run it with:
 *
 *   npx convex run internal.migrations.backfillCommentLikeCounts
 *
 * It returns how many comments were scanned and how many were patched.
 */
export const backfillCommentLikeCounts = internalMutation({
  handler: async (ctx) => {
    let scanned = 0;
    let patched = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await ctx.db
        .query("comments")
        .order("asc")
        .paginate({ numItems: 100, cursor });
      for (const comment of page.page) {
        scanned++;
        if (comment.likeCount === undefined) {
          await ctx.db.patch(comment._id, { likeCount: 0 });
          patched++;
        }
      }
      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }
    return { scanned, patched };
  },
});
