/**
 * Client-side Proof-of-Work solver. Runs ~10–60 ms on a normal device —
 * imperceptible to a human, but each attempt costs a bot the same compute.
 *
 * Usage:
 *   const challenge = await getChallenge();      // from api.pow.getChallenge
 *   const solution = await solvePow(challenge.challenge, challenge.difficulty);
 *   await createPost({ ..., powChallenge: challenge.challenge,
 *                      powNonce: solution.nonce, powIssuedAt: challenge.issuedAt });
 */

export interface PowSolution {
  nonce: string;
  issuedAt: number;
}

export interface PowChallenge {
  challenge: string;
  difficulty: number;
  issuedAt: number;
}

/**
 * Solve a fresh challenge from the hook-provided challenge object. Returns
 * the three fields a gated mutation expects.
 */
export async function solveChallenge(
  pow: PowChallenge | undefined,
): Promise<{ powChallenge: string; powNonce: string; powIssuedAt: number }> {
  if (pow === undefined) {
    // No challenge yet — the mutation will reject; the caller surfaces the
    // error. Never send a forged proof.
    return { powChallenge: "", powNonce: "", powIssuedAt: 0 };
  }
  const solution = await solvePow(pow.challenge, pow.difficulty);
  return {
    powChallenge: pow.challenge,
    powNonce: solution.nonce,
    powIssuedAt: solution.issuedAt,
  };
}

/** Find a nonce whose SHA-256(challenge:nonce) has `difficulty` leading
 *  zero bits. Returns after the target is reached (best-effort, ~ms). */
export async function solvePow(
  challenge: string,
  difficulty: number,
): Promise<PowSolution> {
  const encoder = new TextEncoder();
  let nonce = 0;

  while (true) {
    const input = encoder.encode(`${challenge}:${nonce}`);
    const digest = await crypto.subtle.digest("SHA-256", input);
    const bytes = new Uint8Array(digest);

    // Check the first `difficulty` bits directly on the digest bytes.
    const neededBytes = Math.ceil(difficulty / 8);
    let ok = true;
    for (let i = 0; i < neededBytes; i++) {
      const bitsLeft = difficulty - i * 8;
      const mask = bitsLeft >= 8 ? 0xff : (0xff << (8 - bitsLeft)) & 0xff;
      if ((bytes[i] & mask) !== 0) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { nonce: String(nonce), issuedAt: Date.now() };
    }
    nonce++;
  }
}
