/**
 * PureWire client proof-of-work (hashcash) solver for harness QA scripts.
 *
 * The browser composer solves a ~50 ms puzzle (SHA-256 leading-zero-bits)
 * before every createPost / addComment / sendMessage call. The harness QA
 * scripts call those mutations directly, so they must present the same
 * proof or the mutation rejects with "This request is missing its work
 * proof." This helper fetches a fresh challenge and solves it, returning
 * exactly the three fields the gated mutations expect.
 *
 * Self-contained on purpose (no TS imports): the CI image runs Node 20,
 * which has no native TypeScript type-stripping — the solver mirrors the
 * logic in src/lib/pow.ts in plain JS so it works identically everywhere.
 *
 *   import { powProof } from "./lib/qa-pow.mjs";
 *   const post = await client.action(api.posts.createPost, {
 *     creatorDisclosure: "human-made",
 *     content: "...",
 *     ...(await powProof(client)),
 *   });
 */
import { api } from "../../src/convex/_generated/api.js";

/**
 * Find a nonce whose SHA-256(challenge:nonce) begins with `difficulty`
 * leading zero bits — the same check the server's verifyProof performs.
 */
async function solvePow(challenge, difficulty) {
  const encoder = new TextEncoder();
  let nonce = 0;
  for (;;) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`${challenge}:${nonce}`),
    );
    const bytes = new Uint8Array(digest);
    const neededBytes = Math.ceil(difficulty / 8);
    let ok = true;
    for (let i = 0; i < neededBytes && ok; i++) {
      const bitsLeft = difficulty - i * 8;
      const mask = bitsLeft >= 8 ? 0xff : (0xff << (8 - bitsLeft)) & 0xff;
      if ((bytes[i] & mask) !== 0) ok = false;
    }
    if (ok) return { nonce: String(nonce), issuedAt: Date.now() };
    nonce++;
  }
}

/**
 * Fetch a fresh challenge from the deployment and solve it. Returns the
 * three fields a gated mutation expects (spread into the call args).
 */
export async function powProof(client) {
  const ch = await client.query(api.pow.getChallenge);
  const sol = await solvePow(ch.challenge, ch.difficulty);
  return {
    powChallenge: ch.challenge,
    powNonce: sol.nonce,
    powIssuedAt: sol.issuedAt,
  };
}
