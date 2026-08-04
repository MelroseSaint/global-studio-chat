import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import type {
  BlockedDomainEntry,
  BlockedPatternEntry,
} from "./phishing";
import {
  BANNED_ADULT_HOSTS,
  STATIC_TO_DB_CATEGORY,
  extractUrls,
  matchBlockedHost,
  parseUrlHost,
  scanWithBlocklist,
} from "./phishing";

import { internal } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/**
 * PureWire's data-driven blocklist engine.
 *
 * The static adult list in phishing.ts is the always-on first line — it is
 * seeded into the `blockedDomains` table (see importCoreBlocklist) so the
 * SAME rules become manageable, auditable data: an admin can add, pause,
 * re-categorize, or delete a blocked domain without a deploy, and external
 * blocklist feeds can sync in through domainSources. Every public surface
 * (posts, comments, stories, bios, links, and pre-encryption DMs) checks
 * the DB entries alongside the static heuristics, and each verdict is
 * cached in linkScanResults so "why was this link blocked" is answerable.
 *
 * Privacy stance: blocked-domain matches are recorded as urlHash (an
 * FNV-1a hash, never the raw URL) — the audit trail can say "this hash was
 * blocked because of that domain" without storing people's links verbatim.
 */

/** FNV-1a hash — stable across server/client, no crypto needed. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Normalize a URL the way the scanner sees it, for cache keys. */
function normalizeForHash(raw: string): string {
  return raw.trim().toLowerCase().replace(/\/+$/, "");
}

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not authenticated");
  }
  const me = await ctx.db.get(userId);
  if (me?.role !== "admin") {
    throw new Error("Admins only");
  }
  return userId;
}

/** Active blockedDomain rows, bounded — the pure scan layer's input. */
async function activeEntries(
  ctx: QueryCtx | MutationCtx,
): Promise<BlockedDomainEntry[]> {
  const rows = await ctx.db
    .query("blockedDomains")
    .withIndex("by_active", (q) => q.eq("active", true))
    .take(2000);
  return rows.map((r) => ({
    domain: r.domain,
    category: r.category,
    action: r.action,
    blockSubdomains: r.blockSubdomains,
  }));
}

/** Active pattern rows, bounded. */
async function activePatterns(
  ctx: QueryCtx | MutationCtx,
): Promise<BlockedPatternEntry[]> {
  const rows = await ctx.db
    .query("blockedUrlPatterns")
    .withIndex("by_active", (q) => q.eq("active", true))
    .take(500);
  return rows.map((r) => ({ pattern: r.pattern, action: r.action }));
}

/**
 * Seed the static adult list from phishing.ts into the blockedDomains table
 * as DB entries (idempotent — re-running updates metadata but never
 * duplicates). Maps the static 9 categories onto the DB 12-taxonomy. Runs
 * on every deploy via the internal wrapper, and on demand from the admin UI.
 */
export async function importCoreBlocklistImpl(ctx: MutationCtx): Promise<number> {
  const now = Date.now();
  let imported = 0;
  for (const [staticCategory, hosts] of Object.entries(BANNED_ADULT_HOSTS) as [
    keyof typeof STATIC_TO_DB_CATEGORY,
    readonly string[],
  ][]) {
    const category = STATIC_TO_DB_CATEGORY[staticCategory];
    for (const domain of hosts) {
      const existing = await ctx.db
        .query("blockedDomains")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .first();
      if (existing !== null) {
        await ctx.db.patch(existing._id, {
          category,
          blockSubdomains: true,
          active: true,
          source: "core",
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("blockedDomains", {
          domain,
          category,
          action: "block",
          source: "core",
          confidence: 1,
          blockSubdomains: true,
          active: true,
          addedAt: now,
          updatedAt: now,
        });
        imported++;
      }
    }
  }
  return imported;
}

/** Admin-triggerable re-seed of the core static list. */
export const importCoreBlocklist = mutation({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const imported = await importCoreBlocklistImpl(ctx);
    return { ok: true, imported };
  },
});

/** Public: the active blocklist, for the client DM gate (pre-encryption). */
export const getActiveBlocklist = query({
  handler: async (ctx) => {
    const [domains, patterns] = await Promise.all([
      ctx.db
        .query("blockedDomains")
        .withIndex("by_active", (q) => q.eq("active", true))
        .take(2000),
      ctx.db
        .query("blockedUrlPatterns")
        .withIndex("by_active", (q) => q.eq("active", true))
        .take(500),
    ]);
    return {
      domains: domains.map((d) => ({
        domain: d.domain,
        category: d.category,
        action: d.action,
        blockSubdomains: d.blockSubdomains,
      })),
      patterns: patterns.map((p) => ({
        pattern: p.pattern,
        action: p.action,
      })),
    };
  },
});

/** Cache a verdict for a URL (FNV hash key — never the raw URL). */
export async function recordLinkScan(
  ctx: MutationCtx,
  raw: string,
  verdict: "allowed" | "blocked" | "review" | "unreachable",
  opts: {
    hostname?: string;
    category?: string;
    matchedDomain?: string;
  } = {},
): Promise<void> {
  const normalized = normalizeForHash(raw);
  if (normalized.length === 0) return;
  const urlHash = fnv1a(normalized);
  const existing = await ctx.db
    .query("linkScanResults")
    .withIndex("by_url_hash", (q) => q.eq("urlHash", urlHash))
    .first();
  const row = {
    urlHash,
    originalUrl: raw,
    normalizedUrl: normalized,
    hostname: opts.hostname,
    finalHostname: opts.matchedDomain ?? opts.hostname,
    verdict,
    category: opts.category,
    matchedDomain: opts.matchedDomain,
    scannedAt: Date.now(),
  };
  if (existing !== null) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("linkScanResults", row);
  }
}

/**
 * The server-side scan: static heuristics + DB blocklist (domains and URL
 * patterns), with the verdict cached in linkScanResults. Call sites
 * (posts/stories/users) swap their `scanForPhishing(text)` call for this
 * and keep the same return shape. A text with no URLs at all skips the DB
 * read entirely — a plain-text post can't trip a domain or pattern rule.
 */
export async function scanBlockedContent(
  ctx: MutationCtx,
  text: string,
): Promise<ReturnType<typeof scanWithBlocklist>> {
  const urls = extractUrls(text);
  const entries =
    urls.length > 0 ? await activeEntries(ctx) : [];
  const patterns =
    urls.length > 0 ? await activePatterns(ctx) : [];
  const verdict = scanWithBlocklist(text, entries, patterns);
  // Cache each URL's verdict (hashed — never the raw link). Runs over the
  // same extractUrls the scan used, so what's scanned and what's cached
  // are exactly consistent (scheme-less bare links included).
  for (const raw of urls) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const hostname = parseUrlHost(withScheme) ?? undefined;
    const hit =
      hostname !== undefined
        ? matchBlockedHost(hostname, entries)
        : null;
    await recordLinkScan(
      ctx,
      withScheme,
      verdict.status === "blocked"
        ? "blocked"
        : verdict.status === "review"
          ? "review"
          : "allowed",
      {
        hostname,
        category: hit?.category,
        matchedDomain: hit?.domain,
      },
    );
  }
  return verdict;
}

// ─────────────────────────── Admin management ───────────────────────────

export const listBlockedDomains = query({
  args: {
    paginationOpts: paginationOptsValidator,
    category: v.optional(
      v.union(
        v.literal("all"),
        v.literal("adult_explicit"),
        v.literal("adult_creator"),
        v.literal("adult_porn"),
        v.literal("adult_cam"),
        v.literal("adult_clips"),
        v.literal("adult_chat"),
        v.literal("adult_escort"),
        v.literal("adult_dating"),
        v.literal("adult_fetish"),
        v.literal("adult_community"),
        v.literal("adult_redirect"),
        v.literal("adult_other"),
      ),
    ),
  },
  handler: async (ctx, { paginationOpts, category }) => {
    await requireAdmin(ctx);
    const withCategory = category !== undefined && category !== "all";
    const base = withCategory
      ? ctx.db
          .query("blockedDomains")
          .withIndex("by_category", (q) => q.eq("category", category))
      : ctx.db.query("blockedDomains");
    return await base.order("desc").paginate(paginationOpts);
  },
});

export const upsertBlockedDomain = mutation({
  args: {
    domain: v.string(),
    category: v.union(
      v.literal("adult_explicit"),
      v.literal("adult_creator"),
      v.literal("adult_porn"),
      v.literal("adult_cam"),
      v.literal("adult_clips"),
      v.literal("adult_chat"),
      v.literal("adult_escort"),
      v.literal("adult_dating"),
      v.literal("adult_fetish"),
      v.literal("adult_community"),
      v.literal("adult_redirect"),
      v.literal("adult_other"),
    ),
    action: v.union(v.literal("block"), v.literal("review")),
    blockSubdomains: v.boolean(),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const now = Date.now();
    const domain = args.domain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
      .replace(/\.+$/, "")
      .trim();
    if (domain.length < 3 || !domain.includes(".")) {
      throw new Error("Enter a valid domain, e.g. example.com");
    }
    const existing = await ctx.db
      .query("blockedDomains")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        category: args.category,
        action: args.action,
        blockSubdomains: args.blockSubdomains,
        active: args.active,
        source: existing.source === "core" ? "core" : "manual",
        confidence: existing.source === "core" ? existing.confidence : 1,
        updatedAt: now,
      });
      return { ok: true, domain };
    }
    await ctx.db.insert("blockedDomains", {
      domain,
      category: args.category,
      action: args.action,
      source: "manual",
      confidence: 1,
      blockSubdomains: args.blockSubdomains,
      active: args.active,
      addedAt: now,
      updatedAt: now,
    });
    return { ok: true, domain };
  },
});

export const setBlockedDomainActive = mutation({
  args: {
    domain: v.string(),
    active: v.boolean(),
  },
  handler: async (ctx, { domain, active }) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("blockedDomains")
      .withIndex("by_domain", (q) => q.eq("domain", domain.toLowerCase()))
      .first();
    if (row !== null) {
      await ctx.db.patch(row._id, { active, updatedAt: Date.now() });
    }
    return { ok: true };
  },
});

export const deleteBlockedDomain = mutation({
  args: { domain: v.string() },
  handler: async (ctx, { domain }) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("blockedDomains")
      .withIndex("by_domain", (q) => q.eq("domain", domain.toLowerCase()))
      .first();
    if (row !== null) {
      await ctx.db.delete(row._id);
    }
    return { ok: true };
  },
});

export const listBlockedPatterns = query({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("blockedUrlPatterns").order("desc").take(200);
  },
});

export const upsertBlockedPattern = mutation({
  args: {
    pattern: v.string(),
    category: v.string(),
    action: v.union(v.literal("block"), v.literal("review")),
  },
  handler: async (ctx, { pattern, category, action }) => {
    await requireAdmin(ctx);
    const p = pattern.trim();
    if (p.length < 2) {
      throw new Error("Enter a pattern of at least 2 characters.");
    }
    const existing = await ctx.db
      .query("blockedUrlPatterns")
      .filter((q) => q.eq(q.field("pattern"), p))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { category, action, active: true });
      return { ok: true };
    }
    await ctx.db.insert("blockedUrlPatterns", {
      pattern: p,
      category,
      action,
      active: true,
      source: "manual",
      addedAt: Date.now(),
    });
    return { ok: true };
  },
});

export const deleteBlockedPattern = mutation({
  args: { pattern: v.string() },
  handler: async (ctx, { pattern }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("blockedUrlPatterns")
      .filter((q) => q.eq(q.field("pattern"), pattern))
      .first();
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
    return { ok: true };
  },
});

// ─────────────────────────── External sources ───────────────────────────

export const listDomainSources = query({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("domainSources").order("desc").take(100);
  },
});

export const upsertDomainSource = mutation({
  args: {
    name: v.string(),
    url: v.string(),
    format: v.union(
      v.literal("domain"),
      v.literal("hosts"),
      v.literal("adguard"),
      v.literal("json"),
      v.literal("custom"),
    ),
    enabled: v.boolean(),
  },
  handler: async (ctx, { name, url, format, enabled }) => {
    await requireAdmin(ctx);
    const n = name.trim();
    const u = url.trim();
    if (n.length === 0) {
      throw new Error("Give the source a name.");
    }
    if (!/^https:\/\//i.test(u)) {
      throw new Error("Source URLs must be https://");
    }
    const existing = await ctx.db
      .query("domainSources")
      .filter((q) => q.eq(q.field("name"), n))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { url: u, format, enabled });
      return { ok: true };
    }
    await ctx.db.insert("domainSources", {
      name: n,
      url: u,
      format,
      enabled,
    });
    return { ok: true };
  },
});

export const setDomainSourceEnabled = mutation({
  args: { name: v.string(), enabled: v.boolean() },
  handler: async (ctx, { name, enabled }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("domainSources")
      .filter((q) => q.eq(q.field("name"), name))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { enabled });
    }
    return { ok: true };
  },
});

export const deleteDomainSource = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("domainSources")
      .filter((q) => q.eq(q.field("name"), name))
      .first();
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
    return { ok: true };
  },
});

/** Parse a fetched feed into domain entries, by format. */
function parseFeed(
  format: string,
  body: string,
): { domains: string[]; category: string } {
  const domains = new Set<string>();
  let category = "adult_other";
  // A `# Category: adult_creator` header line (used by PureWire's own
  // data/adult feeds) tells us the bucket every entry belongs to, so a
  // synced feed lands in its real category instead of defaulting to
  // adult_other. Comment lines are otherwise ignored.
  for (const line of body.split(/\r?\n/)) {
    const m = /^#\s*category\s*:\s*([a-z_]+)\s*$/i.exec(line.trim());
    if (m !== null && validCategory(m[1])) {
      category = m[1];
      break;
    }
  }
  if (format === "json") {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") {
            const host = cleanHost(item);
            if (host) domains.add(host);
          } else if (item && typeof item.domain === "string") {
            const host = cleanHost(item.domain);
            if (host) domains.add(host);
            if (typeof item.category === "string") category = item.category;
          }
        }
      }
    } catch {
      // Not JSON — treat the body as plain domain lines below.
    }
    if (domains.size > 0) return { domains: [...domains], category };
  }
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      continue;
    }
    let host: string | null = null;
    if (format === "hosts") {
      const parts = trimmed.split(/\s+/);
      const ip = parts[0] ?? "";
      if (ip === "0.0.0.0" || ip === "127.0.0.1") host = parts[1] ?? null;
    } else if (format === "adguard") {
      const m = /^\|\|([^/^]+)\^/.exec(trimmed);
      host = m?.[1] ?? null;
    } else {
      // "domain" and "custom": one host per line (custom allows labels).
      host = trimmed;
    }
    if (host !== null) {
      const clean = cleanHost(host);
      if (clean) domains.add(clean);
    }
  }
  return { domains: [...domains], category };
}

function cleanHost(host: string): string | null {
  const h = host
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/\.+$/, "");
  if (h.length < 3 || !h.includes(".")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null; // never block raw IPs
  return h;
}

/**
 * Sync every enabled external source into blockedDomains. Admins add feeds
 * through the admin UI; nothing runs without an explicit enabled source.
 * Runs on demand (admin) and nightly via the health-check workflow.
 */
export const syncExternalSources = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    results: v.array(
      v.object({
        name: v.string(),
        imported: v.number(),
        error: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx): Promise<{
    ok: boolean;
    results: { name: string; imported: number; error?: string }[];
  }> => {
    const sources = await ctx.runQuery(internal.blocklist.listEnabledSourcesInternal);
    const results: {
      name: string;
      imported: number;
      error?: string;
    }[] = [];
    for (const source of sources) {
      const now = Date.now();
      try {
        await ctx.runMutation(internal.blocklist.markSourceFetchingInternal, {
          name: source.name,
          now,
        });
        const res = await fetch(source.url, {
          headers: { "User-Agent": "PureWire-Blocklist-Sync/1.0" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = await res.text();
        const { domains, category } = parseFeed(source.format, body);
        const { imported } = await ctx.runMutation(
          internal.blocklist.applySyncedDomainsInternal,
          { name: source.name, domains, category, now },
        );
        await ctx.runMutation(internal.blocklist.markSourceSyncedInternal, {
          name: source.name,
          now,
        });
        results.push({ name: source.name, imported });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.runMutation(internal.blocklist.markSourceErrorInternal, {
          name: source.name,
          now,
          error: message.slice(0, 300),
        });
        results.push({ name: source.name, imported: 0, error: message });
      }
    }
    return { ok: true, results };
  },
});

export const listEnabledSourcesInternal = internalQuery({
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("domainSources")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(100);
    return rows.map((r) => ({ name: r.name, url: r.url, format: r.format }));
  },
});

export const markSourceFetchingInternal = internalMutation({
  args: { name: v.string(), now: v.number() },
  handler: async (ctx, { name, now }) => {
    const existing = await ctx.db
      .query("domainSources")
      .filter((q) => q.eq(q.field("name"), name))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { lastFetchedAt: now });
    }
  },
});

export const markSourceSyncedInternal = internalMutation({
  args: { name: v.string(), now: v.number() },
  handler: async (ctx, { name, now }) => {
    const existing = await ctx.db
      .query("domainSources")
      .filter((q) => q.eq(q.field("name"), name))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        lastSuccessfulSyncAt: now,
        lastFetchedAt: now,
        lastError: undefined,
      });
    }
  },
});

export const markSourceErrorInternal = internalMutation({
  args: { name: v.string(), now: v.number(), error: v.string() },
  handler: async (ctx, { name, now, error }) => {
    const existing = await ctx.db
      .query("domainSources")
      .filter((q) => q.eq(q.field("name"), name))
      .first();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { lastError: error, lastFetchedAt: now });
    }
  },
});

export const applySyncedDomainsInternal = internalMutation({
  args: {
    name: v.string(),
    domains: v.array(v.string()),
    category: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { name, domains, category, now }) => {
    let imported = 0;
    // Synced feeds are lower-confidence than the curated core list: they
    // are a second opinion, not a verdict, and entries carry the source
    // name so an admin can audit and disable any feed.
    for (const domain of domains) {
      const existing = await ctx.db
        .query("blockedDomains")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .first();
      if (existing !== null) {
        // Never downgrade a core entry; a synced feed only adds.
        if (existing.source === "core") continue;
        await ctx.db.patch(existing._id, {
          category: validCategory(category) ? category : existing.category,
          blockSubdomains: true,
          active: true,
          source: name,
          confidence: Math.max(existing.confidence, 0.6),
          updatedAt: now,
        });
        imported++;
      } else {
        await ctx.db.insert("blockedDomains", {
          domain,
          category: validCategory(category) ? category : "adult_other",
          action: "block",
          source: name,
          confidence: 0.6,
          blockSubdomains: true,
          active: true,
          addedAt: now,
          updatedAt: now,
        });
        imported++;
      }
    }
    return { imported };
  },
});

const BLOCK_CATEGORIES = {
  adult_explicit: true,
  adult_creator: true,
  adult_porn: true,
  adult_cam: true,
  adult_clips: true,
  adult_chat: true,
  adult_escort: true,
  adult_dating: true,
  adult_fetish: true,
  adult_community: true,
  adult_redirect: true,
  adult_other: true,
} as const;

type BlockCategoryList = keyof typeof BLOCK_CATEGORIES;

function validCategory(category: string): category is BlockCategoryList {
  return Object.prototype.hasOwnProperty.call(BLOCK_CATEGORIES, category);
}



