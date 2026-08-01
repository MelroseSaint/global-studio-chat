import { escalateSilently } from "./security";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Silent farm-network detection.
 *
 * Farms and follow-train networks boost each other's counts with instant
 * reciprocal follows — A follows B and B follows A moments apart — and with
 * follow/unfollow churn meant to look active without ever forming real
 * connections. Both shapes leave a timestamp trail on the follows table, so
 * the follow and unfollow mutations can spot them and quietly escalate points
 * toward a shadowban using the same silent mechanism as every other abuse
 * signal — with the same decay, so an occasional follow-back or changed mind
 * never sticks. Nothing errors, nothing is visible to the account; only a
 * human review at the threshold changes anything.
 */

/** A reciprocal pair counts as "instant" when both sides are this fresh. */
const RECIPROCAL_WINDOW_MS = 10 * 60_000; // 10 minutes
/**
 * Following back is the most ordinary action on a network — a farm's
 * signature is volume, not any single pair. The first couple of instant
 * mutuals an account forms in the window are free; a burst only escalates
 * once, the moment it first crosses that allowance, so a one-off social
 * burst can never shadow anyone while repeated farm bursts accumulate.
 */
const RECIPROCAL_FREE_MUTUALS = 2;
/** Points escalated when an instant-mutual burst first exceeds the allowance. */
const RECIPROCAL_POINTS = 2;
/** Scan bound for counting an account's recent follows. */
const RECIPROCAL_SCAN_LIMIT = 50;

/** A follow deleted this quickly looks like churn, not a real connection. */
const CHURN_WINDOW_MS = 10 * 60_000; // 10 minutes
/** Points escalated per churn window (not per unfollow). */
const CHURN_POINTS = 1;

/**
 * Called right after a follow is inserted. If the target already followed the
 * follower within the window, the pair formed instantly in both directions —
 * the signature shape of network-boosting. The follower's own recent follows
 * are counted; when that burst first exceeds the free allowance, points
 * escalate ONCE on the follower's account. A creator who simply follows back
 * a bot scores zero (their mutual count is one), and one busy social burst
 * contributes a fixed small amount — only repeated bursts across the decay
 * window add up to a shadowban.
 */
export async function detectReciprocalFollow(
  ctx: MutationCtx,
  followerId: Id<"users">,
  followingId: Id<"users">,
): Promise<void> {
  const reverse = await ctx.db
    .query("follows")
    .withIndex("by_pair", (q) =>
      q.eq("followerId", followingId).eq("followingId", followerId),
    )
    .first();
  if (reverse === null || reverse.createdAt === undefined) return;
  if (Date.now() - reverse.createdAt > RECIPROCAL_WINDOW_MS) return;

  // Count every instant mutual the follower has formed within the window
  // (including the pair just inserted). Two are ordinary follow-backs.
  const since = Date.now() - RECIPROCAL_WINDOW_MS;
  const recentFollows = await ctx.db
    .query("follows")
    .withIndex("by_follower", (q) => q.eq("followerId", followerId))
    .take(RECIPROCAL_SCAN_LIMIT);
  let mutuals = 0;
  for (const follow of recentFollows) {
    if (follow.createdAt === undefined || follow.createdAt < since) continue;
    const back = await ctx.db
      .query("follows")
      .withIndex("by_pair", (q) =>
        q.eq("followerId", follow.followingId).eq("followingId", followerId),
      )
      .first();
    if (
      back !== null &&
      back.createdAt !== undefined &&
      back.createdAt >= since
    ) {
      mutuals += 1;
    }
  }
  // Escalate only at the moment the burst first crosses the free allowance.
  // Within one burst the count climbs 3, 4, 5… — only the crossing event
  // fires, so a single burst contributes exactly RECIPROCAL_POINTS no matter
  // how large it is.
  if (mutuals === RECIPROCAL_FREE_MUTUALS + 1) {
    await escalateSilently(ctx, followerId, RECIPROCAL_POINTS, "farm-reciprocal");
  }
}

/**
 * Called when a follow is deleted. If the follow is younger than the churn
 * window, the account followed and immediately unfollowed — activity churn
 * farms use to look engaged without building real connections. Points
 * escalate at most once per window per account, so a real user cleaning up
 * several mis-clicks in one session counts once, while a farm cycling
 * follow/unfollow across sessions accumulates toward the threshold.
 */
export async function detectFollowChurn(
  ctx: MutationCtx,
  followerId: Id<"users">,
  followCreatedAt: number | undefined,
): Promise<void> {
  if (followCreatedAt === undefined) return;
  if (Date.now() - followCreatedAt > CHURN_WINDOW_MS) return;
  const user = await ctx.db.get(followerId);
  if (user === null) return;
  const lastChurn = user.lastFollowChurnAt;
  if (lastChurn !== undefined && Date.now() - lastChurn < CHURN_WINDOW_MS) {
    return;
  }
  await ctx.db.patch(followerId, { lastFollowChurnAt: Date.now() });
  await escalateSilently(ctx, followerId, CHURN_POINTS, "farm-churn");
}
