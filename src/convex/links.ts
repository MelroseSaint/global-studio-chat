import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { mutation, query } from "./_generated/server";

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

export const getUrlPreview = query({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    return await ctx.db
      .query("urlPreviews")
      .withIndex("by_url", (q) => q.eq("url", url))
      .first();
  },
});

export const fetchUrlPreview = mutation({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    await getAuthUserId(ctx); // require a session
    const cached = await ctx.db
      .query("urlPreviews")
      .withIndex("by_url", (q) => q.eq("url", url))
      .first();
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
      await ctx.db.insert("urlPreviews", preview);
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
