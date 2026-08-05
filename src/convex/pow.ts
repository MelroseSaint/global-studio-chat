/**
 * Client-side Proof-of-Work (hashcash-style) for PureWire.
 *
 * Before a write-heavy mutation (createPost, addComment, sendMessage) a
 * client must solve a tiny puzzle: find a nonce such that
 * SHA-256(challenge + nonce) has `difficulty` leading zero bits. That
 * costs a legitimate user ~10–60 ms of local CPU but forces a bot
 * network to burn proportional compute per attempt — multiplying with the
 * existing server-side rate limits (enforceRateLimit) it makes flooding
 * the API with high-frequency requests impractical.
 *
 * The server never stores challenge state: the challenge embeds an issued
 * timestamp, and the mutation verifies freshness + the hash. Verdicts are
 * checked in the mutation BEFORE any DB work, so a cheap throw happens
 * first.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // A solved puzzle is valid for 5 min.
export const DEFAULT_DIFFICULTY = 16; // 1-in-65536 ≈ 20–60 ms on a laptop.

import { query } from "./_generated/server";

/** Random hex challenge the server issues. */
export function generateChallenge(): string {
  const bytes = new Uint8Array(24);
  // crypto.getRandomValues is available in Convex's Node runtime.
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Count leading zero bits of a SHA-256 digest (as hex string). */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    // Count leading zero bits in this nibble (1 → 3, 2-3 → 2, 4-7 → 1).
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

/**
 * Issue a fresh proof-of-work challenge. The client solves it locally
 * (lib/pow.ts) and returns { challenge, nonce, issuedAt } with the write.
 * No state is stored server-side — freshness is embedded in issuedAt.
 */
export const getChallenge = query({
  handler: async () => ({
    challenge: generateChallenge(),
    difficulty: DEFAULT_DIFFICULTY,
    issuedAt: Date.now(),
  }),
});

/** Verify a client's proof against a challenge + difficulty + issuedAt. */
export async function verifyProof(
  challenge: string,
  nonce: string,
  difficulty: number,
  issuedAt: number,
): Promise<boolean> {
  // Freshness: the challenge must have been issued within the TTL.
  if (Date.now() - issuedAt > CHALLENGE_TTL_MS) return false;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) {
    return false;
  }
  const input = new TextEncoder().encode(`${challenge}:${nonce}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return leadingZeroBits(hex) >= difficulty;
}

/**
 * Verify and throw a clear error when the proof is missing or invalid.
 * Called at the very top of every gated mutation, before any DB work.
 */
export async function requireProof(
  challenge: string | undefined,
  nonce: string | undefined,
  issuedAt: number | undefined,
): Promise<void> {
  if (
    challenge === undefined ||
    nonce === undefined ||
    issuedAt === undefined
  ) {
    throw new Error("This request is missing its work proof. Try again.");
  }
  const ok = await verifyProof(challenge, nonce, DEFAULT_DIFFICULTY, issuedAt);
  if (!ok) {
    throw new Error("Work proof invalid or expired. Try again.");
  }
}
