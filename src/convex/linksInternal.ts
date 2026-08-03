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
    const existing = await ctx.db
      .query("urlPreviews")
      .withIndex("by_url", (q) => q.eq("url", preview.url))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, preview);
    } else {
      await ctx.db.insert("urlPreviews", preview);
    }
  },
});
