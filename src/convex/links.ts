import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { internal } from "./_generated/api";
import { action, query } from "./_generated/server";

function extractMeta(html: string) {
  const pick = (patterns: RegExp[]) => {
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) {
        return m[1]
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
      }
    }
    return undefined;
  };
  const title =
    pick([/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i]) ??
    pick([/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i]) ??
    pick([/<title[^>]*>([^<]+)<\/title>/i]);
  const description =
    pick([
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    ]) ?? undefined;
  const image =
    pick([
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    ]) ?? undefined;
  return { title, description, image };
}

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The preview shape the client (LinkCard) renders. */
type CachedPreview = {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  domain: string;
};

/** Public cache reader for the client (LinkCard) — shows a cached preview instantly. */
export const getUrlPreview = query({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    return await ctx.db
      .query("urlPreviews")
      .withIndex("by_url", (q) => q.eq("url", url))
      .first();
  },
});

/**
 * Fetch and cache an OpenGraph preview for a URL. An ACTION because Convex
 * mutations cannot make external network requests — the fetch must run
 * here, and the cache read/write goes through the internal helpers in
 * ./linksInternal (which actions touch the database with). The helpers live
 * in their own module so `internal.linksInternal.*` never creates a
 * circular type reference with this file's own functions.
 */
export const fetchUrlPreview = action({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    await getAuthUserId(ctx); // require a session
    // Explicitly shaped (like media.ts): the action's return type must not
    // flow through the generated `internal` namespace, or its inference
    // resolves back through `typeof links` into its own initializer
    // (TS7022).
    const cached = (await ctx.runQuery(internal.linksInternal.getUrlPreview, {
      url,
    })) as unknown as CachedPreview | null;
    if (cached !== null) {
      return cached;
    }
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; PureWireBot/1.0; +https://purewire.social)",
        },
        redirect: "follow",
      });
      const text = await res.text();
      const meta = extractMeta(text);
      const preview = {
        url,
        title: meta.title?.slice(0, 200),
        description: meta.description?.slice(0, 400),
        image: meta.image,
        domain: domainOf(url),
      };
      await ctx.runMutation(internal.linksInternal.putUrlPreview, { preview });
      return preview;
    } catch {
      return {
        url,
        title: undefined,
        description: undefined,
        image: undefined,
        domain: domainOf(url),
      };
    }
  },
});
