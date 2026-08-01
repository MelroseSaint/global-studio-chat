import { normalizeEmailIdentity } from "@/lib/format";

import {
  currentEmailHashVersion,
  emailHashSaltForVersion,
  saltedEmailHash,
} from "./privacy";

import { internalMutation } from "./_generated/server";

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
