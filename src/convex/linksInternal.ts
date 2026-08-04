import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Internal cache helpers for the URL-preview action in ./links.
 *
 * They live in their own module so the action can call them through the
 * generated `internal` API without a circular type reference: an action in
 * ./links cannot call `internal.links.*` — the module is still being
 * initialized when TypeScript resolves that type, and the inference
 * collapses to `any`. By defining the helpers here and referencing
 * `internal.linksInternal.*` from ./links, the target module's type is
 * fully known the moment the action file loads. (Same pattern as the
 * media.ts → mediaStorage.ts split.)
 */

/** Internal cache reader — actions can't query ctx.db directly. */
export const getUrlPreview = internalQuery({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    return await ctx.db
      .query("urlPreviews")
      .withIndex("by_url", (q) => q.eq("url", url))
      .first();
  },
});

/** Internal cache writer — actions can't touch ctx.db directly. */
export const putUrlPreview = internalMutation({
  args: {
    preview: v.object({
      url: v.string(),
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      image: v.optional(v.string()),
      domain: v.string(),
    }),
  },
  handler: async (ctx, { preview }) => {
    // fetchedAt is stamped here (never accepted from the action) so every
    // write — first cache or refresh — advances the freshness clock that
    // the periodic re-scan keys off.
    const row = { ...preview, fetchedAt: Date.now() };
    const existing = await ctx.db
      .query("urlPreviews")
      .withIndex("by_url", (q) => q.eq("url", preview.url))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("urlPreviews", row);
    }
  },
});

/**
 * Internal cache remover — used when a periodic re-scan finds a cached
 * URL now blocked: the stale card must disappear, not keep rendering.
 */
export const clearUrlPreview = internalMutation({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const existing = await ctx.db
      .query("urlPreviews")
      .withIndex("by_url", (q) => q.eq("url", url))
      .first();
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
  },
});

/**
 * Internal cache clock reset — used when a stale card's URL is currently
 * unreachable: keep the last-known content in the DB (a later allowed
 * re-scan restores the card) but reset fetchedAt so the periodic re-scan
 * fires at most once per 24h per URL instead of on every view of a dead
 * link. Content is deliberately untouched.
 */
export const touchUrlPreview = internalMutation({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const existing = await ctx.db
      .query("urlPreviews")
      .withIndex("by_url", (q) => q.eq("url", url))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { fetchedAt: Date.now() });
    }
  },
});
