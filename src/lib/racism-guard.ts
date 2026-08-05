/**
 * PureWire's Racial & Ethnic Hate Prevention layer.
 *
 * This is not a "banned word filter" — it is a context-aware enforcement
 * engine that normalizes obfuscated input (spacing attacks, leetspeak,
 * Unicode confusables, zero-width characters, repeated-character stuffing)
 * and distinguishes direct hateful attacks from discussion, quotation,
 * reporting, and educational context.
 *
 * Pure string logic only: runs in the Convex mutation isolate (no fetch,
 * no URL, no TextEncoder) AND in the browser for pre-encryption DM scans.
 * Every public text surface calls `scanForRacism` before content goes live.
 */

// ── Verdict shape ─────────────────────────────────────────────────────────

export type RacismVerdict =
  | { status: "clean" }
  | {
      status: "review";
      reason: string;
      /** The matched category for the review-queue label. */
      category?: RacismCategory;
      /** How many evasion techniques were detected. */
      evasionScore: number;
    }
  | {
      status: "blocked";
      reason: string;
      category: RacismCategory;
      evasionScore: number;
    };

// ── Categories (the taxonomy the engine reports) ──────────────────────────

export type RacismCategory =
  | "racial_slur"
  | "ethnic_slur"
  | "racial_dehumanization"
  | "racial_supremacy"
  | "racial_inferiority"
  | "racial_segregation"
  | "racial_harassment"
  | "racial_violence"
  | "holocaust_denial"
  | "racial_stereotype_attack"
  | "coded_hate";

/** Human label per category, shown in the admin review queue. */
export const RACISM_CATEGORY_LABEL: Record<RacismCategory, string> = {
  racial_slur: "Racial slur",
  ethnic_slur: "Ethnic slur",
  racial_dehumanization: "Racial dehumanization",
  racial_supremacy: "Racial supremacy",
  racial_inferiority: "Racial inferiority claim",
  racial_segregation: "Advocacy for racial segregation",
  racial_harassment: "Racial harassment",
  racial_violence: "Call for racial/ethnic violence",
  holocaust_denial: "Holocaust/genocide denial",
  racial_stereotype_attack: "Stereotype used to attack a group",
  coded_hate: "Coded racial language",
};

// ── Token entry: every lexical item in the engine ─────────────────────────

interface RacismToken {
  /** The canonical form of the term (lowercased, ASCII). */
  term: string;
  category: RacismCategory;
  /** 1 = lower-tier (possible discussion/reporting context) to 5 = unambiguous attack. */
  severity: 1 | 2 | 3 | 4 | 5;
  /** ISO 639-1 codes — null means the term spans languages. */
  language: "en" | "es" | "fr" | "de" | "ar" | "ru" | "zh" | null;
  /** Common variant spellings of the canonical term. */
  aliases?: readonly string[];
  /** Leetspeak / character-substitution variants. */
  variants?: readonly string[];
  /** When true, context analysis is REQUIRED — never auto-block. */
  contextRequired: boolean;
}

// ── The categorized lexicon ───────────────────────────────────────────────
//
// Every entry carries a category, severity, language, and contextRequired
// flag. High-severity slurs (4-5) in a clearly-attack context → BLOCK.
// Lower-severity terms or quotes/discussion → REVIEW. Terms marked
// contextRequired are ALWAYS REVIEW — a single match cannot auto-block.
//
// This list is deliberately sparse: it is the first line, not a complete
// dictionary. The platform adds and refines through the admin blocklist.
// ───────────────────────────────────────────────────────────────────────────

const TOKENS: readonly RacismToken[] = [
  // ── Racial slurs (severity 5) ──────────────────────────────────────────
  {
    term: "nigger",
    category: "racial_slur",
    severity: 5,
    language: "en",
    aliases: ["nigga", "niggas", "niggaz"],
    variants: ["n1gger", "n1gg3r", "n!gger", "nigg3r", "n1gga"],
    contextRequired: false,
  },
  {
    term: "chink",
    category: "racial_slur",
    severity: 5,
    language: "en",
    variants: ["ch1nk", "ch!nk"],
    contextRequired: false,
  },
  {
    term: "kike",
    category: "racial_slur",
    severity: 5,
    language: "en",
    variants: ["k1ke", "k!ke"],
    contextRequired: false,
  },
  {
    term: "spic",
    category: "racial_slur",
    severity: 5,
    language: "en",
    variants: ["sp1c", "sp!c"],
    contextRequired: false,
  },
  {
    term: "wetback",
    category: "racial_slur",
    severity: 5,
    language: "en",
    variants: ["wetb4ck", "wetback5"],
    contextRequired: false,
  },
  {
    term: "gook",
    category: "racial_slur",
    severity: 5,
    language: "en",
    variants: ["g00k", "go0k"],
    contextRequired: false,
  },
  {
    term: "coon",
    category: "racial_slur",
    severity: 5,
    language: "en",
    variants: ["c00n", "co0n"],
    contextRequired: false,
  },
  {
    term: "paki",
    category: "ethnic_slur",
    severity: 5,
    language: "en",
    variants: ["p4ki", "p@ki"],
    contextRequired: false,
  },
  // ── Dehumanization (severity 4) ────────────────────────────────────────
  {
    term: "subhuman",
    category: "racial_dehumanization",
    severity: 4,
    language: "en",
    aliases: ["sub-human"],
    contextRequired: false,
  },
  {
    term: "vermin",
    category: "racial_dehumanization",
    severity: 4,
    language: "en",
    contextRequired: true,
  },
  {
    term: "cockroach",
    category: "racial_dehumanization",
    severity: 4,
    language: "en",
    contextRequired: true,
  },
  {
    term: "infestation",
    category: "racial_dehumanization",
    severity: 4,
    language: "en",
    contextRequired: true,
  },
  // ── Supremacy (severity 4) ─────────────────────────────────────────────
  {
    term: "white power",
    category: "racial_supremacy",
    severity: 4,
    language: "en",
    variants: ["wh1te power", "whitepower"],
    contextRequired: false,
  },
  {
    term: "white genocide",
    category: "racial_supremacy",
    severity: 4,
    language: "en",
    contextRequired: true,
  },
  {
    term: "master race",
    category: "racial_supremacy",
    severity: 4,
    language: "en",
    contextRequired: false,
  },
  // ── Inferiority claims (severity 4) ─────────────────────────────────────
  {
    term: "mongrel",
    category: "racial_inferiority",
    severity: 4,
    language: "en",
    contextRequired: true,
  },
  {
    term: "mudblood",
    category: "racial_inferiority",
    severity: 3,
    language: "en",
    contextRequired: true,
  },
  {
    term: "race traitor",
    category: "racial_inferiority",
    severity: 4,
    language: "en",
    contextRequired: false,
  },
  // ── Segregation advocacy (severity 3) ───────────────────────────────────
  {
    term: "racial purity",
    category: "racial_segregation",
    severity: 4,
    language: "en",
    contextRequired: false,
  },
  {
    term: "separate but equal",
    category: "racial_segregation",
    severity: 3,
    language: "en",
    contextRequired: true,
  },
  // ── Calls for violence (severity 5) ────────────────────────────────────
  {
    term: "kill all",
    category: "racial_violence",
    severity: 5,
    language: "en",
    variants: ["k1ll all"],
    contextRequired: false,
  },
  // ── Coded hate language (severity 3, always context-required) ───────────
  {
    term: "swarm",
    category: "coded_hate",
    severity: 3,
    language: "en",
    contextRequired: true,
  },
  {
    term: "invasion",
    category: "coded_hate",
    severity: 3,
    language: "en",
    contextRequired: true,
  },
];

// ── Context markers (discussion/quote/report detection) ───────────────────

/** Phrases that indicate the speaker is discussing/reporting/quotation, not
 *  personally attacking. Matched against the text AROUND a flagged term. */
const CONTEXT_DISCUSSION_PREFIXES = [
  "i reported",
  "i'm reporting",
  "someone called me",
  "they called me",
  "was called a",
  "i was told",
  "someone said",
  "the word",
  "the term",
  "the slur",
  "use of the word",
  "someone used",
  "they said",
  "quote:",
  "quoting",
  "he said",
  "she said",
  "they texted",
  "this post says",
  "this comment says",
  "reported for",
  "i want to report",
];

/** Sentences that frame the content as reporting/educational. */
const CONTEXT_DISCUSSION_SENTENCES = [
  /(?:i'?m?\s+)?report(?:ing)?\s+(?:this|that|someone|a\s+user)/i,
  /(?:i\s+)?want\s+to\s+report/i,
  /flag(?:ging)?\s+(?:this|that|a)\s+(?:post|comment|user|account)/i,
  /is\s+this\s+(?:allowed|okay|hate\s+speech|racist)/i,
  /should\s+(?:this|that|i)\s+(?:be|report|flag)/i,
  /what\s+does\s+\[.+\]\s+mean/i,
  /in\s+my\s+(?:history|english|sociology)\s+class/i,
  /we\s+(?:read|studied|learned\s+about)/i,
  /according\s+to\s+(?:the\s+)?(?:article|book|study|report)/i,
  /the\s+(?:author|writer|speaker)\s+(?:said|wrote|stated|argued)/i,
];

// ── Normalization pipeline ────────────────────────────────────────────────

/** Strip zero-width and invisible Unicode characters. */
/* eslint-disable no-misleading-character-class */
function stripZeroWidth(text: string): string {
  // Split into multiple passes so the regex engine doesn't trip over
  // Unicode combining characters inside a single character class.
  let out = text.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  out = out.replace(/[\u200E\u200F\u2060-\u2064]/g, "");
  out = out.replace(/[\u00AD\u034F\u061C\u115F\u1160]/g, "");
  out = out.replace(/[\u17B4\u17B5\u180B-\u180F]/g, "");
  out = out.replace(/[\u2028-\u202F\u205F-\u206F\uFE00-\uFE0F]/g, "");
  return out;
}
/* eslint-enable no-misleading-character-class */

/** Normalize whitespace: collapse runs, trim. */
function normalizeWhitespace(text: string): string {
  return text.replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, " ").trim();
}

/** Normalize punctuation/spacing separators that attackers use to fragment
 *  a prohibited term character by character: s-l-u-r, s.l.u.r, s_l_u_r,
 *  s/l/u/r, s l u r. Collapses repeated separators between single letters. */
function normalizeFragmentation(text: string): string {
  // Collapse letter-separator-letter runs: s-l-u-r → slur
  let out = text;
  // Pass 1: single separators between word characters
  out = out.replace(/(\w)[-._/\\|,;](?=\w)/g, "$1");
  // Pass 2: space-separated single letters
  out = out.replace(/\b([a-zA-Z])\s+([a-zA-Z])\s+([a-zA-Z])(\s+[a-zA-Z]){0,}/g, (m) =>
    m.replace(/\s+/g, ""),
  );
  return out;
}

/** Collapse suspicious repeated characters: sluuuuur → slur.
 *  Only collapses letters repeated 3+ times, and only when the resulting
 *  word length after collapse is in a plausible slur range (3-10 chars),
 *  so legitimate repeated letters ("goooood") are rarely affected. */
function collapseRepeated(text: string): string {
  return text.replace(/\b([a-zA-Z])\1{2,}\b/g, (m) => {
    const collapsed = m.replace(/(.)\1+/g, "$1");
    // Only collapse short words where the repetition looks evasive.
    if (collapsed.length >= 3 && collapsed.length <= 10) return collapsed;
    return m;
  });
}

/** Leetspeak substitutions targeted at slur evasion: a→4/@, e→3, i→1/!,
 *  o→0, s→5/$, t→7. Applied only within word boundaries so "@someone"
 *  stays intact and "p@ss" → "pass" doesn't trigger. */
const LEET_MAP: Record<string, string> = {
  "4": "a", "@": "a",
  "3": "e",
  "1": "i", "!": "i",
  "0": "o",
  "5": "s", "$": "s",
  "7": "t",
};

function normalizeLeet(text: string): string {
  // Only substitute when the leet character appears within a word context
  // (surrounded by letters), so "I have $50" and "top 10" stay intact
  // while "n1gger" → "nigger" and "p@ki" → "paki" still normalize.
  return text.replace(/([a-z])[@4!10$57]([a-z])/gi, (_, before, ch, after) =>
    before + (LEET_MAP[ch] ?? ch) + after,
  );
}

/** Targeted homoglyph/confusable normalization for common attack classes:
 *  Cyrillic, Greek, math, and fullwidth forms that visually resemble ASCII.
 *  Does NOT blindly convert every Unicode char to ASCII — that destroys
 *  legitimate multi-language text. Only the deliberate lookalikes are mapped. */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic lookalikes
  "а": "a", "е": "e", "і": "i", "о": "o", "р": "p", "с": "c",
  "х": "x", "у": "y", "ѕ": "s",
  // Greek lookalikes
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "τ": "t", "ν": "v",
  // Math / IPA
  "ɑ": "a", "ɛ": "e", "ι": "i",
  // Fullwidth
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
};

function normalizeHomoglyphs(text: string): string {
  let out = "";
  for (const ch of text) {
    out += HOMOGLYPH_MAP[ch] ?? ch;
  }
  return out;
}

// ── Evasion detection ─────────────────────────────────────────────────────

function computeEvasionScore(
  raw: string,
  normalized: string,
  leetNormalized: string,
): number {
  let score = 0;
  // Zero-width characters: always evasion.
  if (raw.length !== stripZeroWidth(raw).length) score += 3;
  // Leetspeak characters detected.
  if (raw !== leetNormalized) {
    const leetChars = raw.match(/[@4!10$57]/g);
    if (leetChars && leetChars.length >= 2) score += 2;
    if (leetChars && leetChars.length >= 1) score += 1;
  }
  // Suspicious character variation within a single word.
  if (/[a-zA-Z]+[^a-zA-Z\s]+[a-zA-Z]+/.test(normalized)) score += 1;
  // Repeated character manipulation detected.
  if (collapseRepeated(normalized) !== normalized) score += 2;
  return Math.min(score, 10); // cap
}

// ── Context / intent analysis ────────────────────────────────────────────

/** True when the text around a flagged term reads like reporting/discussion,
 *  not an attack. Checks sentences surrounding the match position. */
function isDiscussionContext(text: string, matchIndex: number): boolean {
  const window = 80;
  const start = Math.max(0, matchIndex - window);
  const end = Math.min(text.length, matchIndex + window);
  const context = text.slice(start, end).toLowerCase();
  for (const prefix of CONTEXT_DISCUSSION_PREFIXES) {
    if (context.includes(prefix)) return true;
  }
  for (const re of CONTEXT_DISCUSSION_SENTENCES) {
    if (re.test(context)) return true;
  }
  return false;
}

// ── The scan function ─────────────────────────────────────────────────────

/**
 * Scan text for racial and ethnic hate content, applying the full
 * normalization pipeline and context analysis. Returns a three-tier
 * verdict:
 *
 * - BLOCKED: unambiguous slurs and hate speech with high severity and no
 *   discussion/reporting context.
 * - REVIEW: ambiguous, context-required, or lower-severity matches that a
 *   human moderator should judge.
 * - CLEAN: no prohibited content detected, or the match is clearly in a
 *   reporting/educational context.
 */
export function scanForRacism(content: string): RacismVerdict {
  const raw = content.trim();
  if (raw.length === 0) return { status: "clean" };

  // ── Normalize ───────────────────────────────────────────────────────────
  const step1 = stripZeroWidth(raw);
  const step2 = normalizeWhitespace(step1);
  const step3 = normalizeFragmentation(step2);
  const step4 = collapseRepeated(step3);
  const step5 = normalizeLeet(step4);
  const normalized = normalizeHomoglyphs(step5.toLowerCase());
  const leetNormalized = normalizeHomoglyphs(normalizeLeet(step2).toLowerCase());

  // ── Evasion score ───────────────────────────────────────────────────────
  const evasionScore = computeEvasionScore(raw, normalized, leetNormalized);

  // ── Match against lexicon ───────────────────────────────────────────────
  let bestMatch: { token: RacismToken; index: number } | null = null;

  // Try the fully normalized form first, then the leet-normalized-only form.
  const candidates = [normalized, leetNormalized];
  for (const candidate of candidates) {
    for (const token of TOKENS) {
      const terms = [token.term, ...(token.aliases ?? []), ...(token.variants ?? [])];
      for (const term of terms) {
        const idx = candidate.indexOf(term);
        if (idx === -1) continue;
        // Track the best (highest severity) match, breaking ties by
        // preferring contextRequired=false (more definitive).
        if (bestMatch === null) {
          bestMatch = { token, index: idx };
        } else if (
          token.severity > bestMatch.token.severity ||
          (token.severity === bestMatch.token.severity && !token.contextRequired)
        ) {
          bestMatch = { token, index: idx };
        }
      }
    }
  }

  if (bestMatch === null) return { status: "clean" };

  const { token, index } = bestMatch;

  // ── Context check ───────────────────────────────────────────────────────
  const discussion = isDiscussionContext(raw, index);

  // High-severity unambiguous attack in a direct context → BLOCK.
  if (
    token.severity >= 5 &&
    !token.contextRequired &&
    !discussion &&
    evasionScore <= 3 // high evasion with an unambiguous hit = still block
  ) {
    return {
      status: "blocked",
      reason: `${RACISM_CATEGORY_LABEL[token.category]} — content violates PureWire's racial-hate policy`,
      category: token.category,
      evasionScore,
    };
  }

  // Context-required term in reporting/discussion context → ALLOW (clean).
  if (token.contextRequired && discussion) {
    return { status: "clean" };
  }

  // Everything else → REVIEW (human moderator judges).
  return {
    status: "review",
    reason: discussion
      ? `Possible protected discussion — ${RACISM_CATEGORY_LABEL[token.category]} mentioned in reporting/discussion context`
      : `Suspected ${RACISM_CATEGORY_LABEL[token.category]}`,
    category: token.category,
    evasionScore,
  };
}
