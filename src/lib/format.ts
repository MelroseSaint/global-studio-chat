/** Format a unix timestamp as a friendly relative time string. */
export function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Compact count formatting: 1.2K, 3.4M */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${n}`;
}

/** Validate a username: 3-24 chars, lowercase alphanumeric + underscore. */
export function isValidUsername(username: string): boolean {
  return /^[a-z0-9_]{3,24}$/.test(username);
}

/**
 * Providers known to support `+tag` sub-addressing — everything after the
 * `+` in the local part routes to the same mailbox. Only these are
 * canonicalized for the tag, so a provider that treats `+` as a literal
 * local-part character never has two genuinely distinct inboxes merged.
 */
const SUBADDRESS_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.fr",
  "hotmail.com",
  "hotmail.fr",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "fastmail.com",
  "hey.com",
  "aol.com",
  "zoho.com",
]);

/**
 * Canonicalize an email address to its single owning inbox.
 *
 * Providers treat some spellings as the same mailbox: Gmail and Googlemail
 * ignore dots in the local part, and most major providers ignore everything
 * after a `+` (sub-addressing). Without this, an attacker can register
 * hundreds of "unique" accounts — user@gmail.com, u.ser@gmail.com,
 * user+spam1@gmail.com — all landing in one inbox, each claiming a verified
 * badge. Normalizing before identity checks means one inbox can only ever
 * own one badge.
 *
 * Dot-stripping is Gmail-only because Outlook.com and others treat dots as
 * significant in the local part; `+tag` stripping is scoped to the known
 * sub-addressing providers above. Applied where identity is decided (signup
 * profile, email hash, duplicate detection). The address a code is emailed
 * to is left as typed, so delivery is never disrupted.
 */
export function normalizeEmailIdentity(email: string): string {
  const raw = email.trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0) {
    return raw;
  }
  const domain = raw.slice(at + 1);
  let local = raw.slice(0, at);
  if (SUBADDRESS_DOMAINS.has(domain)) {
    // Sub-addressing: user+anything@ → user@
    const plus = local.indexOf("+");
    if (plus >= 0) {
      local = local.slice(0, plus);
    }
  }
  // Gmail / Googlemail ignore dots in the local part.
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

/** Extract the first URL from a string, if any. */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  if (!match) return null;
  return match[0].replace(/[),.!?;:]+$/, "");
}

/** All URLs in a string. */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const re = /https?:\/\/[^\s]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    urls.push(m[0].replace(/[),.!?;:]+$/, ""));
  }
  return urls;
}

/** Build a clean share URL for a post (uses the live origin). */
export function postUrl(postId: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/post/${postId}`;
}

export const PLATFORM_OPTIONS = [
  "Facebook",
  "Instagram",
  "Snapchat",
  "YouTube",
  "Discord",
  "TikTok",
  "X",
  "Website",
  "Other",
] as const;

export function platformUrl(platform: string, handle: string): string {
  const h = handle.trim();
  const p = platform.toLowerCase();
  if (p === "facebook") return `https://facebook.com/${h}`;
  if (p === "instagram") return `https://instagram.com/${h}`;
  if (p === "snapchat") return `https://snapchat.com/add/${h}`;
  if (p === "youtube") return `https://youtube.com/@${h}`;
  if (p === "discord") return `https://discord.com/users/${h}`;
  if (p === "tiktok") return `https://tiktok.com/@${h}`;
  if (p === "x") return `https://x.com/${h}`;
  if (/^https?:\/\//.test(h)) return h;
  return `https://${h}`;
}
