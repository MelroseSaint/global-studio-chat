/**
 * Client-side session fingerprint helpers for the self-auditing session
 * security (see convex/sessionAudit.ts).
 *
 * PureWire never sends IPs or full user agents anywhere. The browser
 * derives a one-way SHA-256 hash of the UA string and a coarse region
 * token (timezone + language) — enough to spot a stolen session jumping
 * devices/countries, useless for tracking a person.
 */

/** SHA-256 of a string, hex-encoded (WebCrypto, async). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Hash of this device's user agent — one-way, stable per browser. */
export async function clientUaHash(): Promise<string> {
  const ua = navigator.userAgent ?? "unknown";
  return sha256Hex(`pw-ua:${ua}`);
}

/** A coarse, stable region signal derived without any network call. */
export function clientRegionToken(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown";
  const lang = (navigator.language ?? "unknown").toLowerCase();
  return `${tz}|${lang}`;
}
