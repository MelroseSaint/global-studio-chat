/**
 * PureWire's phishing and account-integrity layer.
 *
 * The platform's promise is that no one's freedom is used to take someone
 * else's — and the sharpest tool of that abuse is a link that tries to
 * harvest accounts, passwords, money, or personal information. This module
 * scans every public text surface (posts, comments, story captions, and
 * profile bios/links) BEFORE it goes live:
 *
 * - BLOCKED: overwhelming scam signals — credential-harvesting phrasing,
 *   domains that pose as PureWire (homoglyphs, typosquats, obfuscated
 *   addresses), or URLs that hide login credentials. Rejected outright.
 * - REVIEW: suspicious but possibly innocent — link shorteners, direct IP
 *   addresses, login/verification pages on unfamiliar sites. Sent to the
 *   human review queue (or rejected with guidance where no queue exists),
 *   never auto-blocked, so genuine sharing is never destroyed on a hunch.
 *
 * Pure string logic only: mutations run in a stripped V8 isolate, so there
 * is no `URL` constructor, no `fetch`, no `TextEncoder` — everything here
 * is regexes, string ops, and plain arrays. Deliberately no external lookups
 * at write time, so the check is instant and cannot fail closed.
 */

export type PhishingVerdict =
  | { status: "clean" }
  | { status: "blocked"; reason: string }
  | { status: "review"; reason: string };

/**
 * Phrasing that is overwhelmingly a credential/payment harvest. Each entry
 * is matched case-insensitively as a substring; entries are chosen so
 * ordinary human speech ("free views" as in opinions, "get verified" as an
 * aspiration, "gift card" for a birthday) is never caught.
 */
const HARD_BLOCK_PHRASES = [
  // Engagement-buying / fake-growth scams.
  "free followers",
  "free likes",
  "free subscribers",
  "free engagement",
  "buy followers",
  "buy likes",
  "buy views",
  "buy subscribers",
  "get followers fast",
  "gain followers fast",
  "get free followers",
  "get free likes",
  // Prize / reward lures. "you have won" is left out — "you have won my
  // respect" is innocent speech — the URL layer catches the actionable
  // version (a lure needs a destination to be a scam).
  "claim your prize",
  "claim your reward",
  "congratulations you have been",
  "congratulations you've been",
  // Credential-verification traps. Only the unambiguous ones stay here:
  // "verify your account/email" is also innocent advice ("always verify
  // your email after signing up"), so those ride on the URL layer instead —
  // a phishing shape needs a destination, and the link checks catch it.
  "confirm your password",
  "re-enter your password",
  "reenter your password",
  "verify your password",
  "account has been suspended",
  "account has been locked",
  "account is suspended",
  "account is locked",
  "your account will be suspended",
  "your account will be locked",
  "click here to verify",
  "click to verify",
  // Payment solicitation / transfer scams.
  "cashapp me",
  "cash app me",
  "venmo me",
  "zelle me",
  "send me money on",
  "paypal me",
  "free gift card",
  "gift card giveaway",
  "gift card code",
  // Crypto / money lures.
  "bitcoin giveaway",
  "crypto giveaway",
  "double your bitcoin",
  "double your crypto",
  "guaranteed returns",
  // Fake-login framing. "login here"/"sign in here" are dropped — "the
  // login here is broken" is innocent — only the forms that frame a claim
  // or verification stay hard-blocked.
  "log in to claim",
  "sign in to verify",
  // Off-platform funnel with a prize/payment hook.
  "dm me on telegram for",
  "add me on telegram for",
];

/**
 * Softer funnel phrasing that could be innocent. Review-tier: a human
 * decides instead of an auto-block, so creators who genuinely share a
 * Telegram handle aren't punished.
 */
const REVIEW_PHRASES = [
  "dm me on telegram",
  "add me on telegram",
  "telegram @",
  "whatsapp me",
  "make money fast",
  "free money",
  "double your money",
  "get rich quick",
];

/** Generic URL shorteners that mask their destination. Brand-official
 * shorteners (amzn.to, spoti.fi, yt.be) are deliberately absent. */
const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "is.gd",
  "cutt.ly",
  "rb.gy",
  "rebrand.ly",
  "s.id",
  "shorturl.at",
  "tiny.cc",
  "tny.im",
  "ow.ly",
  "buff.ly",
  "tiny.pl",
  "0rz.tw",
  "short.io",
  "bl.ink",
  "t.ly",
]);

/**
 * Domains a login/verification path on is expected — the user is far more
 * likely linking to a real platform's sign-in than being phished by it.
 * Subdomains count too. Government and academic sites are trusted.
 */
const KNOWN_PLATFORMS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "google.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "youtube.com",
  "apple.com",
  "microsoft.com",
  "amazon.com",
  "netflix.com",
  "spotify.com",
  "discord.com",
  "reddit.com",
  "telegram.org",
  "t.me",
  "whatsapp.com",
  "signal.org",
  "paypal.com",
  "stripe.com",
  "coinbase.com",
  "binance.com",
  "cloudflare.com",
  "vercel.com",
  "netlify.com",
  "shopify.com",
  "medium.com",
  "substack.com",
  "patreon.com",
  "ko-fi.com",
  "kickstarter.com",
  "indiegogo.com",
  "behance.net",
  "dribbble.com",
  "deviantart.com",
  "artstation.com",
  "vimeo.com",
  "twitch.tv",
  "soundcloud.com",
  "bandcamp.com",
  "figma.com",
  "canva.com",
  "adobe.com",
  "wikipedia.org",
]);

/** TLDs scammers favor for fake-login pages. Only meaningful combined with
 * a credential-style path — a plain .xyz blog is not flagged. */
const UNUSUAL_TLDS = new Set([
  "xyz",
  "top",
  "icu",
  "gq",
  "ml",
  "cf",
  "tk",
  "zip",
  "mov",
  "click",
  "loan",
  "work",
  "rest",
  "country",
  "stream",
  "download",
  "racing",
  "win",
  "party",
  "science",
  "quest",
  "fun",
  "online",
  "sbs",
  "kim",
  "cam",
]);

/** Paths that mark a page as a sign-in / verification surface. */
const CREDENTIAL_PATH_RE =
  /\/(?:login|log-in|signin|sign-in|verify|verification|secure|account|accounts|password|wallet|auth|sso|authenticate)(?:[/?#]|$)/i;

/** Official PureWire domains — never treated as lookalikes. */
function isOfficialHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    h === "purewire.com" ||
    h === "purewire.app" ||
    h === "purewire.vercel.app" ||
    h.endsWith(".purewire.com") ||
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h === "::1"
  );
}

/** Cyrillic/Greek/fullwidth confusables that render as ASCII lookalikes. */
const HOMOGLYPHS: Record<string, string> = {
  а: "a",
  е: "e",
  і: "i",
  ї: "i",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  ѕ: "s",
  ν: "v",
  ѵ: "v",
  ⅴ: "v",
  ᴠ: "v",
  ι: "i",
  ⅰ: "i",
  Ⅰ: "i",
  l: "l",
  ⅼ: "l",
  // Fullwidth digits — quoted because TypeScript's identifier parser
  // rejects them as bare keys.
  "０": "0",
  "１": "1",
  "２": "2",
  "３": "3",
  "４": "4",
  "５": "5",
  "６": "6",
  "７": "7",
  "８": "8",
  "９": "9",
};

/** Map confusables to ASCII and drop separators — "ρure-wire", "purewіre",
 * and "pure_wire" all normalize to "purewire". */
function normalizeLabel(label: string): string {
  let out = "";
  for (const ch of label.toLowerCase()) {
    const mapped = HOMOGLYPHS[ch] ?? ch;
    if (/[a-z0-9]/.test(mapped)) out += mapped;
  }
  return out;
}

/** Classic Levenshtein distance — catches typosquats (purew1re, purewlre). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = [];
  for (let i = 0; i <= n; i++) prev.push(i);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur.push(
        Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    }
    prev = cur;
  }
  return prev[n];
}

const PLATFORM = "purewire";

/** True when a host poses as PureWire: a label that contains "purewire"
 * (purewire-verify.com, notpurewire.org), is within two edits of it
 * (purew1re.com, purewlre.net), or carries the name inside a compound
 * with a couple of lookalike edits (purew1re-login.com → "purew1relogin",
 * too long for a whole-label distance but the name sits inside it). The
 * official allowlist runs first. */
function isPureWireLookalike(host: string): boolean {
  const labels = host.toLowerCase().split(".");
  for (const label of labels) {
    const norm = normalizeLabel(label);
    if (norm === "") continue;
    if (norm.includes(PLATFORM)) return true;
    if (levenshtein(norm, PLATFORM) <= 2) return true;
    // Sliding-window fuzzy scan: any stretch of the label near the platform
    // name marks a typosquat compound (purew1re-login.com → "purew1re").
    // Tight tolerance on short windows so real words never collide:
    // 6-7 chars must be within ONE edit ("purewizard", "purewine" are
    // dist-2, safe), 8-10 chars within two.
    for (let win = 6; win <= Math.min(norm.length, 10); win++) {
      const maxDist = win >= 8 ? 2 : 1;
      for (let i = 0; i + win <= norm.length; i++) {
        if (levenshtein(norm.slice(i, i + win), PLATFORM) <= maxDist) return true;
      }
    }
  }
  return false;
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/** True when a host is a literal address: IPv4, bracketed IPv6, or an
 * encoded integer form (0x7f000001, 2130706433). */
function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (IPV4_RE.test(host)) {
    return host.split(".").every((octet) => Number(octet) <= 255);
  }
  return /^0x[0-9a-f]+$/i.test(host) || /^\d{7,}$/.test(host);
}

/** Percent- or hex-obfuscated host, e.g. %70urewire.com. */
function isObfuscatedHost(host: string): boolean {
  return host.includes("%") || /^0x/i.test(host);
}

/** Manual authority parse — no URL constructor (mutations strip it). */
function parseUrl(raw: string): { host: string; path: string; raw: string } | null {
  let s = raw.trim();
  if (s.startsWith("www.")) s = `https://${s}`;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
  if (scheme === null) return null;
  const rest = s.slice(scheme[0].length);
  const pathStart = rest.search(/[/?#]/);
  const authEnd = pathStart === -1 ? rest.length : pathStart;
  const auth = rest.slice(0, authEnd);
  const path = rest.slice(authEnd);
  // Strip userinfo: "https://user:pass@host" — the @ before the first /?#.
  const at = auth.lastIndexOf("@");
  let host = at === -1 ? auth : auth.slice(at + 1);
  host = host.toLowerCase().replace(/\.+$/, "");
  if (!host.startsWith("[") && host.includes(":")) {
    host = host.slice(0, host.indexOf(":"));
  }
  if (host === "") return null;
  return { host, path, raw: s };
}

/** Extract http(s)/www URLs AND bare "domain.tld[/path]" links from text,
 * trimming trailing punctuation. The bare form is the sloppy paste that
 * would otherwise dodge an https://-only regex ("visit purewire-login.xyz
 * now"); sentence noise like "end.now" or "u.s. history" resolves to a
 * clean verdict, so the extra scans are harmless. */
function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const push = (u: string) => {
    let v = u.replace(/[.,;:!?'")\]}>]+$/, "");
    const opens = (v.match(/\(/g) ?? []).length;
    const closes = (v.match(/\)/g) ?? []).length;
    if (closes > opens) v = v.replace(/\)+$/, "");
    if (v.length > 0) urls.push(v);
  };
  for (const m of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'{}[\]]+/gi)) {
    push(m[0]);
  }
  for (const m of text.matchAll(
    /(?:^|[\s(>])((?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s<>"']*)?)(?![a-z0-9-])/gi,
  )) {
    push(m[1]);
  }
  return urls;
}

function hasUnusualTld(host: string): boolean {
  const labels = host.split(".");
  return UNUSUAL_TLDS.has(labels[labels.length - 1]);
}

function isShortener(host: string): boolean {
  return SHORTENER_HOSTS.has(host.replace(/^www\./, ""));
}

function isKnownPlatform(host: string): boolean {
  const h = host.replace(/^www\./, "").toLowerCase();
  if (h.endsWith(".gov") || h.endsWith(".edu")) return true;
  if (KNOWN_PLATFORMS.has(h)) return true;
  for (const p of KNOWN_PLATFORMS) {
    if (h.endsWith(`.${p}`)) return true;
  }
  return false;
}

/** Inspect a single extracted URL against every hostile pattern. */
function inspectUrl(raw: string): PhishingVerdict {
  const parsed = parseUrl(raw);
  if (parsed === null) return { status: "clean" };
  const { host, path } = parsed;
  if (isOfficialHost(host)) return { status: "clean" };
  // Embedded credentials in the authority are a phishing hallmark.
  const pathStart = parsed.raw.search(/[/?#]/);
  const authPart =
    (pathStart === -1 ? parsed.raw : parsed.raw.slice(0, pathStart)).toLowerCase() ?? "";
  if (authPart.includes("@") && !authPart.startsWith("mailto:")) {
    return {
      status: "blocked",
      reason: `URL hides embedded login credentials (${host})`,
    };
  }
  if (isObfuscatedHost(host)) {
    return { status: "blocked", reason: `obfuscated address (${host})` };
  }
  if (isPureWireLookalike(host)) {
    return {
      status: "blocked",
      reason: `looks like an unofficial PureWire page (${host})`,
    };
  }
  if (isIpLiteral(host)) {
    return { status: "review", reason: `direct IP address link (${host})` };
  }
  if (isShortener(host)) {
    return {
      status: "review",
      reason: `link shortener (${host}) — where it goes is hidden`,
    };
  }
  if (CREDENTIAL_PATH_RE.test(path) && !isKnownPlatform(host)) {
    return {
      status: "review",
      reason: `login/verification page on an unfamiliar site (${host})`,
    };
  }
  if (hasUnusualTld(host) && CREDENTIAL_PATH_RE.test(path)) {
    return {
      status: "review",
      reason: `verification-style page on a suspicious domain (${host})`,
    };
  }
  return { status: "clean" };
}

/**
 * Scan text for phishing and account-integrity threats. Two tiers,
 * deliberately: hard scam signals are BLOCKED outright (there is no
 * innocent reading of "verify your account at purew1re-login.com"), while
 * merely-suspicious links (shorteners, IP addresses, unfamiliar login
 * pages) are REVIEW-tier so a human decides — genuine sharing is never
 * destroyed on a hunch. The reason names exactly what tripped the scan so
 * the author and the admin queue can judge it at a glance.
 */
export function scanForPhishing(content: string): PhishingVerdict {
  const text = content.trim();
  if (text.length === 0) {
    return { status: "clean" };
  }
  const lower = text.toLowerCase();
  for (const phrase of HARD_BLOCK_PHRASES) {
    if (lower.includes(phrase)) {
      return {
        status: "blocked",
        reason: `credential- or scam-harvesting phrasing (“${phrase}”)`,
      };
    }
  }
  const reviewHits: string[] = [];
  for (const phrase of REVIEW_PHRASES) {
    if (lower.includes(phrase)) reviewHits.push(`“${phrase}”`);
  }
  for (const raw of extractUrls(text)) {
    // Bare "domain.tld" matches (and www. forms) get a scheme so the URL
    // inspection sees a real destination.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const verdict = inspectUrl(withScheme);
    if (verdict.status === "blocked") return verdict;
    if (verdict.status === "review") reviewHits.push(verdict.reason);
  }
  if (reviewHits.length > 0) {
    const unique = [...new Set(reviewHits)];
    return {
      status: "review",
      reason: `Suspected phishing — ${unique.slice(0, 2).join("; ")}`,
    };
  }
  return { status: "clean" };
}
