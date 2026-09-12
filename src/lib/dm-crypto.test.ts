import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  decryptBytes,
  decryptText,
  encryptBytes,
  encryptText,
  generateDmKeyPair,
  getOrCreateConversationKey,
  DM_CRYPTO_AVAILABLE,
} from "./dm-crypto";

/**
 * The module guards window.localStorage at runtime (a blocked storage must
 * never crash the thread), so a Map-backed shim is enough for the cache
 * paths — no DOM needed. Node ≥19 provides crypto.subtle natively.
 */
beforeAll(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
});

/** Two parties, real keypairs, one conversation — the actual E2E shape. */
async function twoParties(conversationId: string) {
  const alice = await generateDmKeyPair();
  const bob = await generateDmKeyPair();
  const aliceKey = await getOrCreateConversationKey(
    conversationId,
    alice.privateJwk,
    bob.publicJwk,
  );
  const bobKey = await getOrCreateConversationKey(
    conversationId,
    bob.privateJwk,
    alice.publicJwk,
  );
  return { alice, bob, aliceKey, bobKey };
}

describe("DM end-to-end encryption", () => {
  it("WebCrypto is available (the whole feature depends on it)", () => {
    expect(DM_CRYPTO_AVAILABLE).toBe(true);
  });

  it("both parties derive the same conversation key and read each other", async () => {
    const { aliceKey, bobKey } = await twoParties("conv-shared-key");
    const msg = "Crimson maple ember twilight ❄️ snowfall";
    const { ciphertext, iv } = await encryptText(aliceKey, msg);
    expect(ciphertext).not.toContain(msg);
    expect(await decryptText(bobKey, ciphertext, iv)).toBe(msg);
  });

  it("a different conversation derives a different key (salted by conversationId)", async () => {
    // One device (one storage), two conversations with the same peer.
    const alice = await generateDmKeyPair();
    const bob = await generateDmKeyPair();
    const key1 = await getOrCreateConversationKey(
      "conv-iso-1",
      alice.privateJwk,
      bob.publicJwk,
    );
    const key2 = await getOrCreateConversationKey(
      "conv-iso-2",
      alice.privateJwk,
      bob.publicJwk,
    );
    const { ciphertext, iv } = await encryptText(key1, "thread-isolated");
    await expect(decryptText(key2, ciphertext, iv)).rejects.toThrow();
  });

  it("tampered ciphertext never decrypts (AES-GCM auth)", async () => {
    const { aliceKey, bobKey } = await twoParties("conv-auth");
    const { ciphertext, iv } = await encryptText(aliceKey, "do not tamper");
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[0] ^= 0x01;
    await expect(
      decryptText(bobKey, bytes.toString("base64"), iv),
    ).rejects.toThrow();
  });

  it("media bytes roundtrip through encryptBytes/decryptBytes", async () => {
    const { aliceKey, bobKey } = await twoParties("conv-media");
    const payload = new Uint8Array(2048).map((_, i) => (i * 7) & 0xff);
    const { data, ivB64 } = await encryptBytes(aliceKey, payload);
    expect(Buffer.from(data).equals(Buffer.from(payload))).toBe(false);
    const plain = await decryptBytes(bobKey, data, ivB64);
    expect(Buffer.from(plain).equals(Buffer.from(payload))).toBe(true);
  });

  it("the key cache returns a functionally identical key on the second call", async () => {
    // The cache is per-device (localStorage), so the same party calling
    // twice must get an equivalent key — proven by decrypting, not by
    // exporting (cached keys are re-imported non-extractable by design).
    const alice = await generateDmKeyPair();
    const bob = await generateDmKeyPair();
    const k1 = await getOrCreateConversationKey(
      "conv-cache",
      alice.privateJwk,
      bob.publicJwk,
    );
    const k2 = await getOrCreateConversationKey(
      "conv-cache",
      alice.privateJwk,
      bob.publicJwk,
    );
    const { ciphertext, iv } = await encryptText(k1, "cache-hit");
    expect(await decryptText(k2, ciphertext, iv)).toBe("cache-hit");
  });
});
