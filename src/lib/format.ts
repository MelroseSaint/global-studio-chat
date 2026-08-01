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
