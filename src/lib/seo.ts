import { useEffect } from "react";

/**
 * Per-route metadata for the SPA.
 *
 * index.html carries the site-wide tags (brand title, description, OG,
 * WebSite JSON-LD) baked at build time. Crawlers that render JavaScript —
 * and any social unfurl that executes the app — should see tags that match
 * the SPECIFIC post or profile being viewed, plus page-level JSON-LD
 * (Article / ProfilePage). This module applies those overrides at runtime
 * and restores the static defaults on cleanup, so the homepage and every
 * other route keep the build-time tags.
 *
 * Non-JS crawlers (WhatsApp, Discord, X, Slack, iMessage…) never run this:
 * they get the server-rendered OG pages from src/convex/og.ts, served by
 * middleware.ts for /post/:id and /u/:handle. Both surfaces stay in sync —
 * same title/description/image conventions.
 */

/** Fallback origin if the canonical link can't be read (non-DOM contexts). */
const DEFAULT_HOST = "https://purewire.vercel.app";

/** The meta tags this module may override (all present in index.html). */
const MANAGED_TAGS = [
  { attr: "name", key: "description" },
  { attr: "property", key: "og:title" },
  { attr: "property", key: "og:description" },
  { attr: "property", key: "og:url" },
  { attr: "property", key: "og:image" },
  { attr: "property", key: "og:type" },
  { attr: "property", key: "og:image:width" },
  { attr: "property", key: "og:image:height" },
  { attr: "name", key: "twitter:title" },
  { attr: "name", key: "twitter:description" },
  { attr: "name", key: "twitter:image" },
] as const;

type ManagedTag = (typeof MANAGED_TAGS)[number];

const JSONLD_ID = "pw-page-jsonld";

interface Snapshot {
  title: string;
  tags: Record<string, string | null>;
  canonical: string | null;
}

let snapshot: Snapshot | null = null;

/** The canonical origin, read once from the build-time canonical link. */
export function canonicalBase(): string {
  if (typeof document === "undefined") return DEFAULT_HOST;
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (link?.href) {
    try {
      return new URL(link.href).origin;
    } catch {
      // fall through
    }
  }
  return typeof window !== "undefined" ? window.location.origin : DEFAULT_HOST;
}

/** Collapse whitespace and cap a string for meta descriptions. */
export function seoExcerpt(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

function readTag(t: ManagedTag): string | null {
  const el = document.head.querySelector<HTMLMetaElement>(
    `meta[${t.attr}="${t.key}"]`,
  );
  return el?.getAttribute("content") ?? null;
}

function writeTag(t: ManagedTag, value: string | null): void {
  const selector = `meta[${t.attr}="${t.key}"]`;
  const el = document.head.querySelector<HTMLMetaElement>(selector);
  if (value === null) {
    el?.remove();
    return;
  }
  if (el === null) {
    const fresh = document.createElement("meta");
    fresh.setAttribute(t.attr, t.key);
    document.head.appendChild(fresh);
    fresh.setAttribute("content", value);
    return;
  }
  el.setAttribute("content", value);
}

function setCanonical(href: string | null): void {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (href === null) {
    link?.remove();
    return;
  }
  if (link === null) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", href);
}

function setJsonLd(data: Record<string, unknown> | null): void {
  const existing = document.getElementById(JSONLD_ID);
  if (data === null) {
    existing?.remove();
    return;
  }
  if (existing === null) {
    const script = document.createElement("script");
    script.id = JSONLD_ID;
    script.type = "application/ld+json";
    document.head.appendChild(script);
    // JSON inside a <script> must not contain "</script>": escape every "<"
    // so user content (post bodies, bios) can never break out of the tag.
    script.textContent = JSON.stringify(data).replace(/</g, "\\u003c");
    return;
  }
  existing.textContent = JSON.stringify(data).replace(/</g, "\\u003c");
}

function takeSnapshot(): void {
  if (snapshot !== null) return;
  snapshot = {
    title: document.title,
    tags: Object.fromEntries(MANAGED_TAGS.map((t) => [t.key, readTag(t)])),
    canonical:
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute("href") ??
      null,
  };
}

function restoreDefaults(): void {
  if (snapshot === null) return;
  document.title = snapshot.title;
  for (const t of MANAGED_TAGS) {
    writeTag(t, snapshot.tags[t.key] ?? null);
  }
  setCanonical(snapshot.canonical);
  setJsonLd(null);
}

export interface PageMeta {
  /** <title> and og:title / twitter:title. */
  title: string;
  /** meta description + og/twitter descriptions. */
  description: string;
  /** Path portion of the canonical URL, e.g. "/post/abc" or "/u/handle". */
  path: string;
  /** og:type — "article" / "profile" override the default "website". */
  type?: "website" | "article" | "profile";
  /**
   * Absolute image URL. Null/omitted → the brand og-image.png (and the
   * static 1200×630 image dimensions are kept). When a real image is set,
   * the fixed dimensions are dropped since they no longer apply.
   */
  image?: string | null;
  /** Page-level JSON-LD (Article / ProfilePage). Replaces any previous. */
  jsonLd?: Record<string, unknown> | null;
}

/**
 * Apply per-route metadata, or pass null to restore the build-time defaults.
 * Idempotent — safe to call repeatedly and on unmount.
 */
export function applyPageMeta(meta: PageMeta | null): void {
  if (typeof document === "undefined") return;
  takeSnapshot();

  if (meta === null) {
    restoreDefaults();
    return;
  }

  const base = canonicalBase();
  const url = `${base}${meta.path.startsWith("/") ? "" : "/"}${meta.path}`;
  const image = meta.image ?? `${base}/og-image.png`;

  document.title = meta.title;
  writeTag({ attr: "name", key: "description" }, meta.description);
  writeTag({ attr: "property", key: "og:title" }, meta.title);
  writeTag({ attr: "property", key: "og:description" }, meta.description);
  writeTag({ attr: "property", key: "og:url" }, url);
  writeTag({ attr: "property", key: "og:image" }, image);
  writeTag({ attr: "property", key: "og:type" }, meta.type ?? "website");
  // Custom images don't carry the brand card's fixed 1200×630 dimensions;
  // scrapers accept missing dimensions, but stale wrong ones are worse.
  if (meta.image) {
    writeTag({ attr: "property", key: "og:image:width" }, null);
    writeTag({ attr: "property", key: "og:image:height" }, null);
  } else {
    writeTag(
      { attr: "property", key: "og:image:width" },
      snapshot?.tags["og:image:width"] ?? null,
    );
    writeTag(
      { attr: "property", key: "og:image:height" },
      snapshot?.tags["og:image:height"] ?? null,
    );
  }
  writeTag({ attr: "name", key: "twitter:title" }, meta.title);
  writeTag({ attr: "name", key: "twitter:description" }, meta.description);
  writeTag({ attr: "name", key: "twitter:image" }, image);

  setCanonical(url);
  setJsonLd(meta.jsonLd ?? null);
}

/**
 * React binding: applies the metadata while the component is mounted and
 * restores the static defaults when it unmounts or the meta changes. Callers
 * should memoize `meta` (useMemo keyed on the loaded data) so the effect
 * only re-runs when the page content actually changes.
 */
export function usePageMeta(meta: PageMeta | null): void {
  useEffect(() => {
    applyPageMeta(meta);
    return () => applyPageMeta(null);
  }, [meta]);
}
