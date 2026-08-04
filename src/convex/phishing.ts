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
  // `message` is the author-facing copy for blocks that are platform rules
  // (e.g. adult platforms) rather than scam signals — surfaces show it so
  // the author learns the actual rule, not a generic warning.
  | { status: "blocked"; reason: string; message?: string }
  | { status: "review"; reason: string };

/**
 * Categories of adult platforms banned outright from PureWire. Keeping the
 * list category-based instead of one flat blocklist makes it readable,
 * auditable, and easy to extend — a new site slots into the category it
 * belongs to, and the block message names the category so the author and
 * the admin queue know exactly which rule tripped.
 */
export type AdultHostCategory =
  | "adult_subscription"
  | "adult_clips"
  | "adult_cams"
  | "adult_tube"
  | "adult_social"
  | "adult_chat"
  | "adult_dating"
  | "adult_escorts"
  | "adult_link_redirect";

/** Human label per category, used in block reasons and messages. */
export const ADULT_CATEGORY_LABEL: Record<AdultHostCategory, string> = {
  adult_subscription: "adult subscription site",
  adult_clips: "adult clip store",
  adult_cams: "adult cam site",
  adult_tube: "adult video site",
  adult_social: "adult image board",
  adult_chat: "adult chat service",
  adult_dating: "adult dating site",
  adult_escorts: "adult escort site",
  adult_link_redirect: "adult link redirector",
};

/**
 * The adult-platform blacklist, by category. A host is blocked when it
 * matches an entry exactly or appears as a subdomain of one — so
 * m.onlyfans.com and x.chaturbate.com count, and a `www.` prefix never
 * slips through. Every entry is a registrable domain; subdomain-style
 * entries like danbooru.donmai.us are listed in full.
 */
export const BANNED_ADULT_HOSTS: Record<AdultHostCategory, readonly string[]> = {
  // Fan-subscription platforms: creators sell access behind a paywall.
  adult_subscription: [
    "onlyfans.com",
    "fansly.com",
    "fanvue.com",
    "loyalfans.com",
    "justfor.fans",
    "fancentro.com",
    "mym.fans",
    "ismygirl.com",
    "admireme.vip",
    "unlockd.com",
    "exclu.app",
    "avnstars.com",
    "adultnode.com",
    "modelhub.com",
    "ifans.com",
    "fanfix.com",
    "playboy.com",
    "dfans.com",
    "sospoilt.com",
    "nowblind.com",
    "scrile.com",
    "scrile.app",
    "nvs.video",
    "sofiagray.com",
  ],
  // Clip stores and custom-content marketplaces.
  adult_clips: [
    "manyvids.com",
    "clips4sale.com",
    "iwantclips.com",
  ],
  // Live adult cam platforms.
  adult_cams: [
    "chaturbate.com",
    "stripchat.com",
    "myfreecams.com",
    "streamate.com",
    "cam4.com",
    "livejasmin.com",
    "flirt4free.com",
    "camsoda.com",
    "bongacams.com",
    "xhamsterlive.com",
    "vual1.tv",
    "tease.bot",
  ],
  // Adult video / tube sites.
  adult_tube: [
    "pornhub.com",
    "xvideos.com",
    "xnxx.com",
    "xhamster.com",
    "redgifs.com",
    "spankbang.com",
    "eporner.com",
    "tube8.com",
    "beeg.com",
    "drtuber.com",
    "tnaflix.com",
    "motherless.com",
    "fapello.com",
  ],
  // Adult image boards / communities.
  adult_social: ["rule34.xxx", "gelbooru.com", "danbooru.donmai.us"],
  // Adult chat / messaging services.
  adult_chat: [
    "sextpanther.com",
    "premium.chat",
    "niteflirt.com",
    "phrendly.com",
    "frisk.chat",
    "f2f.com",
  ],
  // Reserved categories — no entries on the current blacklist; kept so the
  // taxonomy is explicit and a future ban slots into the right bucket.
  adult_dating: [],
  adult_escorts: ["adultwork.com"],
  adult_link_redirect: [],
};

/** Flat host → category lookup with subdomain matching. */
const ADULT_LOOKUP: ReadonlyArray<readonly [string, AdultHostCategory]> =
  (Object.entries(BANNED_ADULT_HOSTS) as [AdultHostCategory, readonly string[]][])
    .flatMap(([category, hosts]) => hosts.map((host) => [host, category] as const));

/**
 * IDN → ASCII (punycode) conversion for a single label, per RFC 3492.
 *
 * Mutations run in a stripped V8 isolate with no TextEncoder or URL
 * constructor, so this is pure string math: the encode algorithm is just
 * integer arithmetic over code points. ASCII labels pass through untouched.
 */
const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;

function punyAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  delta = firstTime ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) / 2) {
    delta = Math.floor(delta / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * delta) / (delta + PUNY_SKEW));
}

function punyDigit(d: number): string {
  return String.fromCharCode(d + 22 + 75 * (d < 26 ? 1 : 0));
}

/** Encode one label (already lowercased) to punycode, without the xn-- prefix. */
function punyEncodeLabel(label: string): string {
  let output = "";
  const input = Array.from(label);
  const basic = input.filter((ch) => ch.charCodeAt(0) < 0x80);
  let h = basic.length;
  if (basic.length > 0) {
    output += basic.join("");
    if (input.length > basic.length) output += "-";
  }
  let n = PUNY_INITIAL_N;
  let delta = 0;
  let bias = PUNY_INITIAL_BIAS;
  while (h < input.length) {
    let m = Number.MAX_SAFE_INTEGER;
    for (const ch of input) {
      const c = ch.codePointAt(0)!;
      if (c >= n && c < m) m = c;
    }
    delta += (m - n) * (h + 1);
    n = m;
    for (const ch of input) {
      const c = ch.codePointAt(0)!;
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = PUNY_BASE; ; k += PUNY_BASE) {
          const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
          if (q < t) break;
          const digit = t + ((q - t) % (PUNY_BASE - t));
          output += punyDigit(digit);
          q = Math.floor((q - t) / (PUNY_BASE - t));
        }
        output += punyDigit(q);
        bias = punyAdapt(delta, h + 1, h === basic.length);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return output;
}

/**
 * Convert every non-ASCII label of a hostname to its ASCII punycode form
 * (xn-- …). Pure string math — no TextEncoder, so it runs in the stripped
 * mutation isolate and in the client bundle alike. ASCII hosts are returned
 * unchanged, so this is safe to call unconditionally on any host.
 */
export function idnToAscii(host: string): string {
  return host
    .split(".")
    .map((label) => {
      if (label.length === 0) return label;
      let hasNonAscii = false;
      for (let i = 0; i < label.length; i++) {
        if (label.charCodeAt(i) > 0x7f) {
          hasNonAscii = true;
          break;
        }
      }
      if (!hasNonAscii) return label;
      return `xn--${punyEncodeLabel(label.toLowerCase())}`;
    })
    .join(".");
}

/**
 * The canonical lookup chain for a host, most specific first: the exact
 * host, then each parent domain. Lowercased, www- and trailing-dot-stripped,
 * and punycoded so an IDN host meets its xn-- blocked entry and vice versa.
 * The exact→parent ordering is what the policy walk uses: exact-domain
 * lookup first, parent-domain lookup second.
 */
export function hostChain(host: string): string[] {
  const normalized = idnToAscii(
    host.toLowerCase().replace(/^www\./, "").replace(/\.+$/, ""),
  );
  if (normalized.length === 0) return [];
  const labels = normalized.split(".");
  const chain: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    chain.push(labels.slice(i).join("."));
  }
  return chain;
}

/** The banned category a host belongs to, or null when it's not banned. */
export function bannedAdultCategory(host: string): AdultHostCategory | null {
  for (const candidate of hostChain(host)) {
    for (const [domain, category] of ADULT_LOOKUP) {
      if (candidate === domain) return category;
    }
  }
  return null;
}

/**
 * The blocklist engine's category taxonomy — the 12 DB-backed categories
 * used by the blockedDomains table (and the admin UI). The static adult
 * list above is seeded INTO the DB mapped onto these (see
 * STATIC_TO_DB_CATEGORY), and admins can add entries in any category.
 */
export type BlockCategory =
  | "adult_explicit"
  | "adult_creator"
  | "adult_porn"
  | "adult_cam"
  | "adult_clips"
  | "adult_chat"
  | "adult_escort"
  | "adult_dating"
  | "adult_fetish"
  | "adult_community"
  | "adult_redirect"
  | "adult_other";

/** Human label per DB category, used in block reasons and messages. */
export const BLOCK_CATEGORY_LABEL: Record<BlockCategory, string> = {
  adult_explicit: "adult explicit site",
  adult_creator: "adult creator subscription site",
  adult_porn: "adult video site",
  adult_cam: "adult cam site",
  adult_clips: "adult clip store",
  adult_chat: "adult chat service",
  adult_escort: "adult escort service",
  adult_dating: "adult dating site",
  adult_fetish: "adult fetish site",
  adult_community: "adult community board",
  adult_redirect: "adult link redirector",
  adult_other: "adult platform",
};

/**
 * Map the static categories in BANNED_ADULT_HOSTS onto the DB taxonomy so
 * importCoreBlocklist can seed the blockedDomains table without a hand
 * rewrite. Categories are semantically closest by intent: subscription
 * platforms → creator, tube sites → porn, image boards → community.
 */
export const STATIC_TO_DB_CATEGORY: Record<AdultHostCategory, BlockCategory> = {
  adult_subscription: "adult_creator",
  adult_clips: "adult_clips",
  adult_cams: "adult_cam",
  adult_tube: "adult_porn",
  adult_social: "adult_community",
  adult_chat: "adult_chat",
  adult_dating: "adult_dating",
  adult_escorts: "adult_escort",
  adult_link_redirect: "adult_redirect",
};

/**
 * One entry of the DB-backed blockedDomains table, as the pure scan layer
 * consumes it (both server-side and in the client DM gate, which fetches
 * getActiveBlocklist and re-checks pre-encryption).
 */
export interface BlockedDomainEntry {
  domain: string;
  category: BlockCategory;
  action: "block" | "review";
  blockSubdomains: boolean;
}

/**
 * Match a host against a set of DB entries, walking the exact→parent chain.
 *
 * The pipeline: exact-domain lookup first (the host itself), then each
 * parent domain in order of specificity. A parent-domain hit counts only
 * when the entry has blockSubdomains set — so listing onlyfans.com with
 * blockSubdomains covers m.onlyfans.com, and a deliberately-scoped entry
 * (sub.thing.com, blockSubdomains false) never overreaches. The most
 * specific match wins because the chain is walked most-specific first and
 * the first hit is returned. Hosts and entries are punycoded so an IDN
 * host meets its xn-- blocked entry and vice versa.
 */
export function matchBlockedHost(
  host: string,
  entries: readonly BlockedDomainEntry[],
): BlockedDomainEntry | null {
  const chain = hostChain(host);
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    for (const entry of entries) {
      const d = idnToAscii(
        entry.domain.toLowerCase().replace(/^www\./, "").replace(/\.+$/, ""),
      );
      if (d.length === 0 || d !== candidate) continue;
      // Exact lookup (i === 0) always counts; parent lookups need the flag.
      if (i === 0 || entry.blockSubdomains) return entry;
    }
  }
  return null;
}

/** One active pattern from the blockedUrlPatterns table. */
export interface BlockedPatternEntry {
  pattern: string;
  action: "block" | "review";
}

/**
 * Scan text combining the DB-backed blocklist (domains + URL patterns) with
 * the static heuristics. DB entries are checked first (an admin-added or
 * synced domain blocks outright), then the existing static scan handles
 * phrasing, lookalikes, shorteners, and login-page shapes. Used server-side
 * (entries/patterns loaded from the DB) and client-side (the DM gate, with
 * the list from getActiveBlocklist) — pure string logic, no ctx, so both
 * run anywhere. Patterns are matched case-insensitively as a substring of
 * each raw URL — the cheap supplement to exact-domain blocking.
 */
export function scanWithBlocklist(
  content: string,
  entries: readonly BlockedDomainEntry[],
  patterns: readonly BlockedPatternEntry[] = [],
): PhishingVerdict {
  const text = content.trim();
  if (text.length === 0) {
    return { status: "clean" };
  }
  for (const raw of extractUrls(text)) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = parseUrl(withScheme);
    if (parsed === null) continue;
    const hit = matchBlockedHost(parsed.host, entries);
    if (hit !== null) {
      const label = BLOCK_CATEGORY_LABEL[hit.category];
      if (hit.action === "review") {
        return {
          status: "review",
          reason: `listed for review: ${hit.domain} (${label})`,
        };
      }
      return {
        status: "blocked",
        reason: `banned ${label} (${hit.domain})`,
        message: `Adult platforms aren't allowed on PureWire — this ${label} can't be shared, posted, or linked.`,
      };
    }
    // Pattern match: the whole raw URL (scheme + host + path) against each
    // active pattern as a case-insensitive substring.
    const lower = withScheme.toLowerCase();
    for (const pattern of patterns) {
      if (lower.includes(pattern.pattern.toLowerCase())) {
        if (pattern.action === "review") {
          return {
            status: "review",
            reason: `listed for review: “${pattern.pattern}”`,
          };
        }
        return {
          status: "blocked",
          reason: `banned URL pattern “${pattern.pattern}”`,
          message: `That link isn't allowed on PureWire — it matches a blocked URL pattern.`,
        };
      }
    }
  }
  return scanForPhishing(text);
}

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

/** Manual authority parse exposed for callers that need the host of a
 * single raw link (e.g. the link-scan cache). Same rules as the internal
 * parser — strips userinfo, port, and trailing dots — then converts the
 * host to its canonical ASCII/punycode form, so the cache key and the
 * hostname recorded in linkScanResults are the same form the lookups use. */
export function parseUrlHost(raw: string): string | null {
  const parsed = parseUrl(raw);
  return parsed === null ? null : idnToAscii(parsed.host);
}

/** Extract http(s)/www URLs AND bare "domain.tld[/path]" links from text,
 * trimming trailing punctuation. The bare form is the sloppy paste that
 * would otherwise dodge an https://-only regex ("visit purewire-login.xyz
 * now"); sentence noise like "end.now" or "u.s. history" resolves to a
 * clean verdict, so the extra scans are harmless. */
export function extractUrls(text: string): string[] {
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
  // Hard platform rule: adult platforms are never shared, posted, or linked
  // on PureWire. Checked right after the official allowlist so a banned
  // host is never mislabeled by a later scan, and the block carries a
  // full sentence so the author learns the actual rule.
  const adult = bannedAdultCategory(host);
  if (adult !== null) {
    return {
      status: "blocked",
      reason: `banned ${ADULT_CATEGORY_LABEL[adult]} (${host})`,
      message: `Adult platforms aren't allowed on PureWire — this ${ADULT_CATEGORY_LABEL[adult]} can't be shared, posted, or linked.`,
    };
  }
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
