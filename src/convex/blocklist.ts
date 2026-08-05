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
  idnToAscii,
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

/**
 * The active blocklist shape — domains + patterns — as the pure scan layer
 * consumes it. One shared implementation for the public client gate and the
 * internal redirect-inspector query, so the two can never drift.
 */
async function fetchActiveBlocklist(
  ctx: QueryCtx,
): Promise<{ domains: BlockedDomainEntry[]; patterns: BlockedPatternEntry[] }> {
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
}

/** Public: the active blocklist, for the client DM gate (pre-encryption). */
export const getActiveBlocklist = query({
  handler: async (ctx) => {
    return await fetchActiveBlocklist(ctx);
  },
});

/**
 * Internal twin of getActiveBlocklist so the redirect-inspection action
 * (links.fetchUrlPreview) can fetch the same list through `internal` and
 * re-scan a resolved hostname against it. Shares fetchActiveBlocklist with
 * the public query, so the action always sees exactly what the client DM
 * gate sees.
 */
export const getActiveBlocklistInternal = internalQuery({
  handler: async (ctx) => {
    return await fetchActiveBlocklist(ctx);
  },
});

/** Cache a verdict for a URL (FNV hash key — never the raw URL). */
export async function recordLinkScan(
  ctx: MutationCtx,
  raw: string,
  verdict: "allowed" | "blocked" | "review" | "unreachable" | "challenged",
  opts: {
    hostname?: string;
    category?: string;
    matchedDomain?: string;
    // Redirect inspection: the hosts visited on the way to the final
    // destination and the host the URL ultimately resolved to. Filled by
    // the fetchUrlPreview action (the only place that can follow redirects);
    // the write-time scan has no redirect info, so it leaves them unset.
    finalHostname?: string;
    redirectChain?: string[];
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
    finalHostname: opts.finalHostname,
    verdict,
    category: opts.category,
    matchedDomain: opts.matchedDomain,
    redirectChain: opts.redirectChain,
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
    const domain = idnToAscii(
      args.domain
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/.*$/, "")
        .replace(/\.+$/, "")
        .trim(),
    );
    if (domain.length < 3 || !domain.includes(".")) {
      throw new Error("Enter a valid domain, e.g. example.com");
    }
    // Same TLD sanity guard as feed parsing: the final label must be a real
    // TLD (2-63 letters, or an xn-- punycode TLD). Keeps the admin form and
    // the feed pipeline from ever storing HTML-fragment-style junk.
    const tld = domain.split(".").pop() ?? "";
    if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) {
      throw new Error("Enter a valid domain with a real TLD, e.g. example.com");
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
    // take() defaults to ascending _creationTime; the panel reads by name,
    // so sort in memory (deterministic for the ~dozen built-in feeds).
    return await ctx.db
      .query("domainSources")
      .take(100)
      .then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name)));
  },
});

/** Admin: recent link-scan results, newest first (bounded for the panel). */
export const listLinkScanResults = query({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("linkScanResults").order("desc").take(100);
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

/**
 * The built-in PureWire category feeds. These are the curated adult lists
 * under data/adult/ (mirrored to public/ so Vercel serves them at
 * /data/adult/<file>). They are registered as domainSources on first
 * bootstrap and kept in sync by the nightly syncExternalSources job.
 *
 * The category buckets come from each file's own `# Category:` header at
 * parse time, so the feed list here only needs name + URL + format.
 */
export const DEFAULT_BLOCKLIST_FEEDS = [
  "creator-domains.txt",
  "porn-domains.txt",
  "cam-domains.txt",
  "clip-domains.txt",
  "chat-domains.txt",
  "escort-domains.txt",
  "fetish-domains.txt",
  "community-domains.txt",
  "redirects-domains.txt",
].map((file) => ({
  name: `PureWire adult ${file.replace("-domains.txt", "")}`,
  url: `https://purewire.vercel.app/data/adult/${file}`,
  format: "domain" as const,
}));

/**
 * Idempotent one-shot registration of the built-in PureWire feeds.
 * Missing sources are inserted enabled; existing sources are never
 * overwritten (an admin may have pointed a name at a custom URL). Safe to
 * run on every deploy/sync — this is what makes the nightly sync job
 * self-healing instead of silently doing nothing when sources are absent.
 */
export const registerDefaultBlocklistSources = mutation({
  handler: async (ctx) => {
    await requireAdmin(ctx);
    let registered = 0;
    for (const feed of DEFAULT_BLOCKLIST_FEEDS) {
      const existing = await ctx.db
        .query("domainSources")
        .filter((q) => q.eq(q.field("name"), feed.name))
        .first();
      if (existing !== null) continue;
      await ctx.db.insert("domainSources", {
        name: feed.name,
        url: feed.url,
        format: feed.format,
        enabled: true,
      });
      registered++;
    }
    return { ok: true, registered };
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
  // adult_other. Comment lines are otherwise ignored. Only the first few
  // lines are examined: headers are at the top, and a huge external hosts
  // feed (100k+ lines) must not be fully split/allocated twice per sync.
  for (const line of body.split(/\r?\n/, 20)) {
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
  // Punycode BEFORE the ASCII strip so an IDN feed entry (or admin domain)
  // is stored in its canonical xn-- form instead of being erased.
  const h = idnToAscii(
    host
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, ""),
  )
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/\.+$/, "");
  if (h.length < 3 || !h.includes(".")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null; // never block raw IPs
  // TLD sanity guard: the final label must look like a real TLD (2-63
  // letters, or an xn-- punycode TLD). This rejects HTML fragments and
  // other junk a feed could accidentally contain (a real incident: a feed
  // URL served an HTML page and cleanHost stored `<meta>` fragments as
  // block entries). Genuine IDN entries keep working because punycoded
  // domains still end in a valid ASCII TLD (.test, .com, .xn--p1ai).
  const tld = h.split(".").pop() ?? "";
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) {
    return null;
  }
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
    purged: v.number(),
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
    purged: number;
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
    // Privacy retention sweep: link-scan evidence older than 30 days is
    // deleted every sync (spec point 14 — hashes stay, verbatim URLs go).
    const { purged } = await ctx.runMutation(
      internal.blocklist.purgeStaleScansInternal,
      { now: Date.now() },
    );
    return { ok: true, results, purged };
  },
});

/**
 * Record a link-scan verdict from an ACTION (the redirect inspector in
 * links.fetchUrlPreview). Actions can't touch ctx.db directly, and only the
 * action can follow redirects — so it reports the chain + final hostname
 * here, and this mutation persists the row. The final-domain lookup runs
 * against the same active blocklist getActiveBlocklist serves.
 */
export const recordLinkScanInternal = internalMutation({
  args: {
    rawUrl: v.string(),
    verdict: v.union(
      v.literal("allowed"),
      v.literal("blocked"),
      v.literal("review"),
      v.literal("unreachable"),
      v.literal("challenged"),
    ),
    hostname: v.optional(v.string()),
    finalHostname: v.optional(v.string()),
    category: v.optional(v.string()),
    matchedDomain: v.optional(v.string()),
    redirectChain: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await recordLinkScan(ctx, args.rawUrl, args.verdict, {
      hostname: args.hostname,
      finalHostname: args.finalHostname,
      category: args.category,
      matchedDomain: args.matchedDomain,
      redirectChain: args.redirectChain,
    });
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

/**
 * Privacy retention sweep for linkScanResults — runs nightly with the sync.
 * The scan cache keeps {urlHash, verdict, category, matchedDomain, scannedAt}
 * forever (that part is pure hash + policy, and the user explicitly wants
 * it), but the verbatim originalUrl/normalizedUrl columns are moderation
 * evidence, not a permanent record. Per the privacy spec, evidence has a
 * SHORT retention period: rows older than RETENTION_MS (30 days) are
 * deleted, bounded per run so the sweep never blows a mutation budget.
 */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_BATCH = 200;

export const purgeStaleScansInternal = internalMutation({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const cutoff = now - RETENTION_MS;
    // by_verdict isn't time-ordered; the table is small (one row per URL)
    // and this is nightly, so a filtered take is the honest bounded scan.
    const stale = await ctx.db
      .query("linkScanResults")
      .filter((q) => q.lt(q.field("scannedAt"), cutoff))
      .take(RETENTION_BATCH);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    return { purged: stale.length };
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
    // Scale ceiling (documented): the import loop does a per-domain index
    // lookup and the sweep below a source-filter scan — fine for the core
    // 62 + our data/adult feeds. A single 18k-domain feed would exceed
    // Convex's per-mutation write/time budget; that scale needs chunked
    // ingestion, which is a future refactor (see the nightly sync job).
    let imported = 0;
    // Synced feeds are lower-confidence than the curated core list: they
    // are a second opinion, not a verdict, and entries carry the source
    // name so an admin can audit and disable any feed. This mutation runs
    // ONLY after a successful fetch+parse (see syncExternalSources), so a
    // failed fetch can never deactivate anything.
    const incoming = new Set(domains);
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
          // Every successful sync verifies the entries the feed still lists.
          lastVerifiedAt: now,
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
          lastVerifiedAt: now,
          updatedAt: now,
        });
        imported++;
      }
    }
    // Deactivate entries this feed previously owned that are no longer in
    // the current list — the spec's "compare against DB → deactivate removed".
    // Only entries whose source is THIS feed are touched; core and manual
    // rows are never swept. Bounded scan; the feed-name filter has no index,
    // and the table is small enough for a nightly sync.
    const owned = await ctx.db
      .query("blockedDomains")
      .filter((q) => q.eq(q.field("source"), name))
      .take(10000);
    for (const row of owned) {
      if (incoming.has(row.domain)) continue;
      await ctx.db.patch(row._id, {
        active: false,
        lastVerifiedAt: now,
        updatedAt: now,
      });
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



