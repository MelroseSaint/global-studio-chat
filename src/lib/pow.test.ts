import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { solveChallenge, solvePow } from "./pow";

/**
 * Independent verifier: does SHA-256(`${challenge}:${nonce}`) have
 * `difficulty` leading zero bits? Implemented with node:crypto so the test
 * does not trust the solver's own WebCrypto path to grade itself.
 */
function proofIsValid(
  challenge: string,
  nonce: string,
  difficulty: number,
): boolean {
  const digest = createHash("sha256")
    .update(`${challenge}:${nonce}`)
    .digest();
  const neededBytes = Math.ceil(difficulty / 8);
  for (let i = 0; i < neededBytes; i++) {
    const bitsLeft = difficulty - i * 8;
    const mask = bitsLeft >= 8 ? 0xff : (0xff << (8 - bitsLeft)) & 0xff;
    if ((digest[i] & mask) !== 0) return false;
  }
  return true;
}

describe("solvePow", () => {
  it("finds a nonce satisfying low difficulty", async () => {
    const challenge = "unit-test-challenge";
    const { nonce } = await solvePow(challenge, 8);
    expect(proofIsValid(challenge, nonce, 8)).toBe(true);
  });

  it("finds a nonce satisfying moderate difficulty", async () => {
    const challenge = "harder-puzzle";
    const { nonce } = await solvePow(challenge, 12);
    expect(proofIsValid(challenge, nonce, 12)).toBe(true);
  });

  it("never accepts a nonce that fails the verifier", async () => {
    // A wrong nonce must NOT verify — guards against the verifier itself
    // being vacuous (always-true would make the solver untestable).
    const challenge = "vacuity-check";
    const bad = "999999999";
    expect(proofIsValid(challenge, bad, 12)).toBe(false);
  });

  it("solves different challenges with different nonces", async () => {
    const a = await solvePow("challenge-alpha", 8);
    const b = await solvePow("challenge-beta", 8);
    expect([a.nonce, b.nonce]).not.toEqual([b.nonce, a.nonce]);
  });
});

describe("solveChallenge", () => {
  it("returns the three gated mutation fields for a live challenge", async () => {
    const out = await solveChallenge({
      challenge: "field-shape-check",
      difficulty: 8,
      issuedAt: 1234,
    });
    expect(out.powChallenge).toBe("field-shape-check");
    expect(proofIsValid(out.powChallenge, out.powNonce, 8)).toBe(true);
    expect(typeof out.powIssuedAt).toBe("number");
  });

  it("never forges a proof when no challenge arrived", async () => {
    const out = await solveChallenge(undefined);
    expect(out).toEqual({ powChallenge: "", powNonce: "", powIssuedAt: 0 });
  });
});
