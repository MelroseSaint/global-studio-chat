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

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * True when a host is a literal address that must never be fetched: loopback,
 * private ranges, link-local, metadata endpoints, and multicast. The preview
 * fetcher runs on PureWire's servers, so an unfettered "follow" could be
 * steered into the deployment's own network — the classic SSRF that turns a
 * link card into a probe of internal services.
 *
 * Known residual gap: a HOSTNAME that resolves to a private address (e.g.
 * 169.254.169.254.nip.io) can't be caught pre-fetch without DNS resolution,
 * and resolving before fetch would itself be a leak. The literal-IP guard
 * plus the manual redirect loop (every hop re-checked) closes the easy
 * cases; the metadata-hostname class is a documented limitation.
 */
function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/\[|\]/g, "");
  if (
    h === "localhost" ||
    h === "::1" ||
    h === "::" ||
    h.startsWith("fe80:") ||
    h.startsWith("fc") ||
    h.startsWith("fd")
  ) {
    return true;
  }
  if (!IPV4_RE.test(h)) return false;
  const [a, b, c] = h.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Manual authority parse (host + path) — no URL constructor dependency. */
function hostOf(raw: string): string | null {
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const at = s.lastIndexOf("@");
  const slash = s.search(/[/?#]/);
  const authEnd = slash === -1 ? s.length : slash;
  let host = (at !== -1 ? s.slice(at + 1, authEnd) : s.slice(0, authEnd)).toLowerCase();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    host = close === -1 ? host : host.slice(0, close + 1);
  } else if (host.includes(":")) {
    host = host.slice(0, host.indexOf(":"));
  }
  return host.replace(/\.+$/, "");
}

/** A preview with no content — returned for refused, failed, or unsafe URLs. */
function emptyPreview(url: string): CachedPreview {
  return {
    url,
    title: undefined,
    description: undefined,
    image: undefined,
    domain: domainOf(url),
  };
}

/**
 * Fetch and cache an OpenGraph preview for a URL. An ACTION because Convex
 * mutations cannot make external network requests — the fetch must run
 * here, and the cache read/write goes through the internal helpers in
 * ./linksInternal (which actions touch the database with). The helpers live
 * in their own module so `internal.linksInternal.*` never creates a
 * circular type reference with this file's own functions.
 *
 * Hardened like every outbound fetch on the platform: only http(s) is ever
 * fetched, literal addresses that point into private/loopback space are
 * refused before the first request, redirects are followed manually so each
 * hop's host is re-checked, and the body read is capped so a hostile page
 * can't balloon the cache.
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
    if (!/^https?:\/\//i.test(url)) {
      return emptyPreview(url);
    }
    try {
      // Follow redirects manually, re-checking each hop's host against the
      // private-address guard — a legit-looking first hop must never steer
      // the server into the internal network on the second.
      let current = url;
      for (let hop = 0; hop < 5; hop++) {
        const host = hostOf(current);
        if (host === null || isPrivateAddress(host)) {
          return emptyPreview(url);
        }
        const res = await fetch(current, {
          signal: AbortSignal.timeout(6000),
          headers: {
            "user-agent":
              "Mozilla/5.0 (compatible; PureWireBot/1.0; +https://purewire.social)",
          },
          redirect: "manual",
        });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (location === null) return emptyPreview(url);
          current = new URL(location, current).toString();
          continue;
        }
        const text = (await res.text()).slice(0, 120_000);
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
      }
      return emptyPreview(url);
    } catch {
      return emptyPreview(url);
    }
  },
});
