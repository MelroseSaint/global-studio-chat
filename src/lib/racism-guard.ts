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
      category?: RacismCategory;
      evasionScore: number;
    }
  | {
      status: "blocked";
      reason: string;
      category: RacismCategory;
      evasionScore: number;
    };

// ── Categories ────────────────────────────────────────────────────────────

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

// ── Token entry ───────────────────────────────────────────────────────────

interface RacismToken {
  term: string;
  category: RacismCategory;
  severity: 1 | 2 | 3 | 4 | 5;
  language: "en" | "es" | "fr" | "de" | "ar" | "ru" | "zh" | null;
  aliases?: readonly string[];
  variants?: readonly string[];
  contextRequired: boolean;
}

// ── Lexicon ───────────────────────────────────────────────────────────────

const TOKENS: readonly RacismToken[] = [
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
  {
    term: "kill all",
    category: "racial_violence",
    severity: 5,
    language: "en",
    variants: ["k1ll all"],
    contextRequired: true,
  },
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

// ── Context markers ───────────────────────────────────────────────────────

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

function stripZeroWidth(text: string): string {
  let out = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  out = out.replace(/[\u200E\u200F\u2060-\u2064]/g, "");
  out = out.replace(/\u00AD/g, "").replace(/\u034F/g, "").replace(/\u061C/g, "");
  out = out.replace(/\u115F/g, "").replace(/\u1160/g, "");
  out = out.replace(/\u17B4/g, "").replace(/\u17B5/g, "");
  out = out.replace(/[\u180B-\u180F]/g, "");
  out = out.replace(/[\u2028-\u202F]/g, "").replace(/[\u205F-\u206F]/g, "").replace(/[\uFE00-\uFE0F]/g, "");
  return out;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, " ").trim();
}

/**
 * Collapse separator characters between letters into nothing.
 * Dots, dashes, underscores, slashes, pipes, commas, semicolons.
 * "n-i-g-g-e-r" → "nigger". "n . ì . g _ g _ e . r" → "nìgger".
 *
 * Now covers Latin-accented letters (U+00C0–U+024F) so diacritics
 * like ì/í/é used in obfuscation don't break the collapse.
 */
function normalizeFragmentation(text: string): string {
  // Letter class: ASCII + Latin-1 Supplement + Extended-A/B
  const L = "[a-zA-Z\u00C0-\u024F]";
  // Single separator chars (optional whitespace around them) between letters
  const sepRe = new RegExp("(" + L + ")\\s*[-._/\\\\|,;]\\s*(?=" + L + ")", "g");
  // Space-separated single letters: "n i g g e r" → "nigger" (3+ letters)
  const spaceRe = new RegExp("\\b(" + L + ")\\s+(" + L + ")\\s+(" + L + ")(\\s+" + L + "){0,}", "g");
  let out = text.replace(sepRe, "$1");
  out = out.replace(spaceRe, (m) => m.replace(/\s+/g, ""));
  return out;
}

/**
 * Collapse word-initial doubled letters: "nnigga" → "nigga".
 * Normalized form is only matched against the lexicon, then discarded — so legitimate words like "bookkeeper" shrinking to "bokeeper" in the search form is harmless. Only collapses exactly 2 repeated letters at word start — 3+ reps
 * are handled by collapseRepeated, and mid-word doubles stay intact.
 */
function collapseDoubledStart(text: string): string {
  return text.replace(/\b([a-zA-Z])\1+/g, (m, ch) => {
    if (m.length === 2) return ch;
    return m;
  });
}

/**
 * Collapse suspicious repeated characters: "sluuuuur" → "slur".
 * Only collapses letters repeated 3+ times, and only when the
 * collapsed word is short — long genuine words with repeats untouched.
 */
function collapseRepeated(text: string): string {
  return text.replace(/([a-zA-Z])\1{2,}/g, (m) => {
    const collapsed = m.replace(/(.)\1+/g, "$1");
    if (collapsed.length <= 10) return collapsed;
    return m;
  });
}

const LEET_MAP: Record<string, string> = {
  "4": "a", "@": "a",
  "3": "e",
  "1": "i", "!": "i",
  "0": "o",
  "5": "s", "$": "s",
  "7": "t",
};

function normalizeLeet(text: string): string {
  return text.replace(/([a-z])([4@3!10$57])([a-z])/gi, (_, before, ch, after) =>
    before + (LEET_MAP[ch] ?? ch) + after,
  );
}

const HOMOGLYPH_MAP: Record<string, string> = {
  "а": "a", "е": "e", "і": "i", "о": "o", "р": "p", "с": "c",
  "х": "x", "у": "y", "ѕ": "s",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "τ": "t", "ν": "v",
  "ɑ": "a", "ɛ": "e", "ι": "i",
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
  // Latin diacritics — attackers put accents on letters to defeat
  // exact matching. Normalized to base ASCII.
  "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a",
  "è": "e", "é": "e", "ê": "e", "ë": "e",
  "ì": "i", "í": "i", "î": "i", "ï": "i",
  "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o",
  "ù": "u", "ú": "u", "û": "u", "ü": "u",
  "ñ": "n",
  "ç": "c",
};

function normalizeHomoglyphs(text: string): string {
  let out = "";
  for (const ch of text) {
    out += HOMOGLYPH_MAP[ch] ?? ch;
  }
  return out;
}

// ── Evasion score ─────────────────────────────────────────────────────────

function computeEvasionScore(
  raw: string,
  normalized: string,
  leetNormalized: string,
): number {
  let score = 0;
  if (raw.length !== stripZeroWidth(raw).length) score += 3;
  if (raw !== leetNormalized) {
    const leetChars = raw.match(/[@34!10$57]/g);
    if (leetChars && leetChars.length >= 2) score += 2;
    if (leetChars && leetChars.length >= 1) score += 1;
  }
  if (/[a-zA-Z]+[^a-zA-Z\s]+[a-zA-Z]+/.test(normalized)) score += 1;
  if (collapseRepeated(normalized) !== normalized) score += 2;
  return Math.min(score, 10);
}

// ── Context analysis ──────────────────────────────────────────────────────

/** True when the text around a flagged term reads like reporting/discussion,
 *  not an attack. Checks sentences surrounding the match within an 80-char
 *  window. A sentence boundary (period, !, ?, newline) between the context
 *  marker and the match disqualifies the context — "I reported X. Also, nigger."
 *  correctly blocks the second sentence. */
function isDiscussionContext(text: string, matchIndex: number): boolean {
  const window = 80;
  const start = Math.max(0, matchIndex - window);
  const end = Math.min(text.length, matchIndex + window);
  const context = text.slice(start, end).toLowerCase();
  const matchPos = matchIndex - start;
  for (const prefix of CONTEXT_DISCUSSION_PREFIXES) {
    const idx = context.indexOf(prefix);
    if (idx === -1) continue;
    // Must be no sentence boundary between marker and match
    const [lo, hi] = idx < matchPos ? [idx, matchPos] : [matchPos, idx];
    if (/[.!?\n]/.test(context.slice(lo, hi))) continue;
    return true;
  }
  for (const re of CONTEXT_DISCUSSION_SENTENCES) {
    const m = re.exec(context);
    if (m === null) continue;
    const [lo, hi] = m.index < matchPos ? [m.index, matchPos] : [matchPos, m.index];
    if (/[.!?\n]/.test(context.slice(lo, hi))) continue;
    return true;
  }
  return false;
}

// ── Main scan ─────────────────────────────────────────────────────────────

export function scanForRacism(content: string): RacismVerdict {
  const raw = content.trim();
  if (raw.length === 0) return { status: "clean" };

  const step1 = stripZeroWidth(raw);
  const step2 = normalizeWhitespace(step1);
  const step3 = normalizeFragmentation(step2);
  const step4 = collapseDoubledStart(step3);
  const step5 = collapseRepeated(step4);
  const step6 = normalizeLeet(step5);
  const normalized = normalizeHomoglyphs(step6.toLowerCase());
  const leetNormalized = normalizeHomoglyphs(normalizeLeet(step2).toLowerCase());

  const evasionScore = computeEvasionScore(raw, normalized, leetNormalized);

  let bestMatch: { token: RacismToken; index: number } | null = null;
  const candidates = [normalized, leetNormalized];
  for (const candidate of candidates) {
    for (const token of TOKENS) {
      const terms = [token.term, ...(token.aliases ?? []), ...(token.variants ?? [])];
      for (const term of terms) {
        const idx = candidate.indexOf(term);
        if (idx === -1) continue;
        const before = idx > 0 ? candidate.charAt(idx - 1) : " ";
        const after = idx + term.length < candidate.length
          ? candidate.charAt(idx + term.length)
          : " ";
        if (/[a-z]/.test(before) || /[a-z]/.test(after)) continue;
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
  const discussion = isDiscussionContext(raw, index);

  if (
    token.severity >= 4 &&
    !token.contextRequired &&
    !discussion &&
    evasionScore <= 3
  ) {
    return {
      status: "blocked",
      reason: `${RACISM_CATEGORY_LABEL[token.category]} — content violates PureWire's racial-hate policy`,
      category: token.category,
      evasionScore,
    };
  }

  if (discussion) {
    return { status: "clean" };
  }

  if (token.contextRequired) {
    return {
      status: "review",
      reason: `Suspected ${RACISM_CATEGORY_LABEL[token.category]}`,
      category: token.category,
      evasionScore,
    };
  }

  return {
    status: "review",
    reason: `Suspected ${RACISM_CATEGORY_LABEL[token.category]}`,
    category: token.category,
    evasionScore,
  };
}
