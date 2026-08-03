import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Internal cache helpers for the place-search actions in ./places.
 *
 * They live in their own module so the actions can call them through the
 * generated `internal` API without a circular type reference: an action in
 * ./places cannot call `internal.places.*` — the module is still being
 * initialized when TypeScript resolves that type, and the inference
 * collapses to `any`. By defining the helpers here and referencing
 * `internal.placesInternal.*` from ./places, the target module's type is
 * fully known the moment the action file loads. (Same pattern as the
 * media.ts → mediaStorage.ts split.)
 */

/** One cached place-search result: a clean label + coarsened coordinates. */
export const placeResult = v.object({
  label: v.string(),
  latitude: v.number(),
  longitude: v.number(),
});

/** The shape an action reads back from the cache (see ./places). */
export type PlaceCacheEntry = {
  results: { label: string; latitude: number; longitude: number }[];
  fetchedAt: number;
};

/** Internal cache reader — actions can't query ctx.db directly. */
export const getPlaceCache = internalQuery({
  args: { query: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      results: v.array(placeResult),
      fetchedAt: v.number(),
    }),
  ),
  handler: async (ctx, { query }) => {
    const row = await ctx.db
      .query("placeCache")
      .withIndex("by_query", (q) => q.eq("query", query))
      .first();
    if (row === null) {
      return null;
    }
    return { results: row.results, fetchedAt: row.fetchedAt };
  },
});

/** Internal cache writer — actions can't touch ctx.db directly. */
export const putPlaceCache = internalMutation({
  args: {
    query: v.string(),
    results: v.array(placeResult),
    fetchedAt: v.number(),
  },
  handler: async (ctx, { query, results, fetchedAt }) => {
    const existing = await ctx.db
      .query("placeCache")
      .withIndex("by_query", (q) => q.eq("query", query))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { results, fetchedAt });
    } else {
      await ctx.db.insert("placeCache", { query, results, fetchedAt });
    }
  },
});
