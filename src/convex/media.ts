import { getAuthUserId } from "@convex-dev/auth/server";

import { enforceActive, enforceRateLimit } from "./security";

import { mutation } from "./_generated/server";

/**
 * Mint a signed upload URL. Requires a logged-in, active account and runs
 * against the per-account upload budget so automated scrapers can't use
 * the storage endpoint as an unbounded dumping ground.
 */
export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "upload");
    return await ctx.storage.generateUploadUrl();
  },
});
