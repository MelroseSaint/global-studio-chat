/**
 * PureWire's centralized adult-content policy — Layer 3 (solicitation).
 *
 * Layer 1 (domain blocklist) and Layer 2 (URL/pattern scan) are handled by
 * blocklist.ts → phishing.ts — already wired into every content path.
 *
 * This module adds Layer 3: sexual-solicitation text detection with
 * circumvention normalization. Pure string logic — no DB reads, instant,
 * and never fails closed.
 *
 * Every content-creation path MUST call scanAdultContent(text) AFTER
 * scanBlockedContent(ctx, text). The two layers together form the
 * complete server-side adult-content gate.
 *
 * Layer 4 (NSFW image/video) is delegated to Cloudinary's moderation
 * add-on, configured at the upload-preset level.
 *
 * Verdict tiers:
 *   - blocked: cannot be published
 *   - clean:   no solicitation found
 *
 * Default: REJECT. If normalization fails for any reason, the raw text is
 * used instead — a degraded scan is better than a silent pass.
 */

export interface SolicitationVerdict {
  status: "blocked" | "clean";
  reason?: string;
  message?: string;
  normalized: string;
}

// ─── Text normalization (circumvention detection) ───────────────────────

/** Zero-width and invisible characters used to bypass filters. */
const ZERO_WIDTH_CHARS = /\u200B|\u200C|\u200D|\uFEFF|\u00AD|\u2060|\u180E/g;

/** Characters inserted between letters to dodge filters — removed entirely. */
const SEPARATOR_CHARS = /[._\-|*·•]+/g;

/** Repeated-character spam: "eeeessssccccoooorrrrtttt" → "escort". */
function collapseRepeats(text: string): string {
  return text.replace(/(.)\1+/g, "$1");
}

/** Strip zero-width chars, collapse repeats, remove letter separators. */
export function normalizeCircumvention(text: string): string {
  let cleaned = text.replace(ZERO_WIDTH_CHARS, "");
  cleaned = cleaned.toLowerCase().trim();
  // Remove separator characters entirely (join "e.s.c.o.r.t" → "escort")
  cleaned = cleaned.replace(SEPARATOR_CHARS, "");
  cleaned = collapseRepeats(cleaned);
  // Normalize whitespace (multiple spaces → one)
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  return cleaned;
}

// ─── Sexual-solicitation detection ──────────────────────────────────────

const SOLICITATION_PHRASES = [
  "escort service", "escort services", "book an escort",
  "hire an escort", "escort available", "escort in",
  "escort near", "escort girl", "escort boy",
  "escort agency", "escort booking", "independent escort",
  "elite escort", "vip escort",
  "sex for money", "sex for cash", "pay for sex",
  "buy sex", "sell sex", "sex worker",
  "sex service", "sexual service", "full service",
  "girlfriend experience", "boyfriend experience",
  "subscribe to my onlyfans", "follow my onlyfans",
  "check my onlyfans", "link to my onlyfans",
  "onlyfans in bio", "onlyfans link",
  "fansly link", "fansly in bio",
  "adult content creator", "adult creator",
  "nsfw creator", "nsfw content",
  "explicit content", "xxx content",
  "porn star", "pornstar",
  "adult film", "adult video", "adult model",
  "dm for rates", "dm for price", "dm for menu",
  "dm me for", "rate per hour", "hourly rate",
  "incall", "outcall", "incalls", "outcalls",
  "find me on", "my page on", "my profile on", "see more on",
];

function containsSolicitation(tokens: string[]): string | null {
  const joined = tokens.join(" ");
  for (const phrase of SOLICITATION_PHRASES) {
    if (joined.includes(phrase)) return phrase;
    const pt = phrase.split(" ");
    if (pt.length === 1 && tokens.includes(pt[0])) return phrase;
  }
  return null;
}

// ─── Main entry points ──────────────────────────────────────────────────

/**
 * Scan text for sexual solicitation after circumvention normalization.
 * Call AFTER scanBlockedContent() in every content-creation path.
 */
export function scanAdultContent(text: string | null | undefined): SolicitationVerdict {
  const raw = (text ?? "").trim();
  if (raw.length === 0) return { status: "clean", normalized: "" };

  const normalized = normalizeCircumvention(raw);
  const tokens = normalized.split(/\s+/).filter(Boolean);

  const hit = containsSolicitation(tokens);
  if (hit) {
    return {
      status: "blocked",
      reason: `sexual solicitation (“${hit}”)`,
      message: "Sexual solicitation isn't allowed on PureWire — advertising or offering sexual services violates the platform's content policy.",
      normalized,
    };
  }

  return { status: "clean", normalized };
}

/**
 * Scan a proposed username or display name — same normalization and
 * solicitation check, tuned for short strings.
 */
export function scanUsername(name: string): SolicitationVerdict {
  return scanAdultContent(name);
}
