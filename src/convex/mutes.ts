import { v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { mutation, query } from "./_generated/server";

const MAX_MUTED_KEYWORDS = 100;
const MAX_KEYWORD_LENGTH = 60;

/** Normalize a mute term for matching: lowercase, strip diacritics. */
export function normalizeMuteTerm(term: string): string {
  return term
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * True when `text` contains any of the user's muted keywords.
 * Unicode-aware: keywords are matched case-insensitively and after
 * diacritic folding, so "café" and "cafe" are equivalent. Substring
 * matching by design — a muted term hides any post/comment/preview
 * that mentions it, in any phrasing.
 */
export function textMatchesMutes(
  text: string | undefined,
  mutedKeywords: string[] | undefined,
): boolean {
  if (!text || !mutedKeywords || mutedKeywords.length === 0) return false;
  const folded = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  for (const term of mutedKeywords) {
    if (term.length === 0) continue;
    if (folded.includes(term)) return true;
  }
  return false;
}

/** Set the caller's personal mute list (replaces the whole list). */
export const setMutedKeywords = mutation({
  args: { keywords: v.array(v.string()) },
  handler: async (ctx, { keywords }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const cleaned: string[] = [];
    for (const raw of keywords) {
      const term = normalizeMuteTerm(raw);
      if (term.length === 0 || term.length > MAX_KEYWORD_LENGTH) continue;
      if (!cleaned.includes(term)) cleaned.push(term);
      if (cleaned.length >= MAX_MUTED_KEYWORDS) break;
    }
    await ctx.db.patch(userId, { mutedKeywords: cleaned });
  },
});

/** The caller's current mute list. */
export const getMutedKeywords = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const me = await ctx.db.get(userId);
    return me?.mutedKeywords ?? [];
  },
});
