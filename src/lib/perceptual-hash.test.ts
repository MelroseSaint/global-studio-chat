import { describe, expect, it } from "vitest";

import { mediaHashesMatch } from "./perceptual-hash";

/** A 64-bit dHash as hex — `bits` describes the pattern for readability. */
const h = (hex: string) => hex;

describe("mediaHashesMatch", () => {
  it("matches an identical signature", () => {
    const frame = [h("81c3c3c3e7e7e7e7")];
    expect(mediaHashesMatch(frame, [[h("81c3c3c3e7e7e7e7")]])).toBe(true);
  });

  it("matches within the similarity threshold (recompression, resize)", () => {
    const original = h("ffffffffffffffff");
    // One bit flipped — distance 1, well under SIMILARITY_BITS (10).
    const nearCopy = h("fffffffffffffffe");
    expect(mediaHashesMatch([original], [[nearCopy]])).toBe(true);
  });

  it("rejects a visually different frame (far Hamming distance)", () => {
    const original = h("00000000000000ff");
    const different = h("ffffffffffffff00");
    expect(mediaHashesMatch([original], [[different]])).toBe(false);
  });

  it("matches when any variant pair matches (mirrored / cropped sets)", () => {
    const storedVariants = [h("00000000000000ff"), h("aaaaaaaaaaaaaaaa")];
    const candidateVariants = [h("bbbbbbbbbbbbbbbb"), h("aaaaaaaaaaaaaaaa")];
    expect(mediaHashesMatch(candidateVariants, [storedVariants])).toBe(true);
  });

  it("scans multiple stored posts and matches the right one", () => {
    const stored = [
      [h("1111111111111111")],
      [h("2222222222222222")],
      [h("3333333333333333")],
    ];
    expect(mediaHashesMatch([h("2222222222222222")], stored)).toBe(true);
    expect(mediaHashesMatch([h("4444444444444444")], stored)).toBe(false);
  });

  it("is empty-safe on both sides", () => {
    expect(mediaHashesMatch([], [[h("1111111111111111")]])).toBe(false);
    expect(mediaHashesMatch([h("1111111111111111")], [])).toBe(false);
  });
});
