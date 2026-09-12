/**
 * Shared helper for PureWire production QA scripts: sweep every dangling
 * notification row (one whose post, shared post, actor, or recipient no
 * longer exists) across the whole table.
 *
 * The sweep MUST run in bounded chunks: once real accounts accumulate
 * notifications, a single mutation scanning the entire table exceeds
 * Convex's per-function read limits (a full scan tripped "Too many
 * documents read in a single function execution"). So the sweep walks
 * pages via the harness's paginated listNotificationsForPurge query and
 * deletes each page through purgeNotificationChunk — every execution is
 * a small, bounded chunk, and cursor-based pagination guarantees each
 * row is examined exactly once no matter how large the table grows.
 *
 * Self-contained on purpose (no TS imports): the CI image runs Node 20,
 * which has no native TypeScript type-stripping.
 *
 *   import { purgeAllDanglingNotifications } from "./lib/qa-notifs.mjs";
 *   const { total, byReason } = await purgeAllDanglingNotifications(client, secret);
 */
import { api } from "../../src/convex/_generated/api.js";

/**
 * Walk the notifications table page-by-page and delete every dangling
 * row, returning the total purged and a reason breakdown. The caller
 * asserts total === 0 for the "no fake notifications" gate.
 */
export async function purgeAllDanglingNotifications(client, secret) {
  let total = 0;
  const byReason = {};
  // undefined (not null) so the first page passes the validator's
  // v.optional(v.string()); the backend turns it into paginate's null.
  let cursor;
  for (;;) {
    const page = await client.query(api.testHarness.listNotificationsForPurge, {
      secret,
      cursor,
    });
    if (page.page.length === 0) break;
    const r = await client.mutation(api.testHarness.purgeNotificationChunk, {
      secret,
      ids: page.page.map((n) => n._id),
    });
    total += r.purgedCount;
    for (const n of r.purged) {
      byReason[n.reason] = (byReason[n.reason] ?? 0) + 1;
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return { total, byReason };
}
