/**
 * End-to-end encryption for PureWire direct messages.
 *
 * Every byte is encrypted in the sender's browser and decrypted in the
 * recipient's browser. PureWire's servers never see plaintext: they store
 * only AES-GCM ciphertext, and the keys never exist anywhere but on the
 * devices that derive them. There is nothing to subpoena, nothing to pull —
 * a full database copy contains only unreadable ciphertext.
 *
 * How it works (all WebCrypto, all client-side):
 *
 *   1. Every account gets an ECDH P-256 keypair. The PUBLIC half is stored
 *      on the account record (public keys are not secret). The PRIVATE half
 *      is generated in the browser and kept only on that device.
 *   2. A conversation key is derived as
 *          HKDF-SHA256(ECDH(myPrivateKey, theirPublicKey),
 *                      salt = conversationId, info = "PureWire DM v1")
 *      Both participants can derive the SAME key independently — the
 *      server only ever sees conversationIds, never key material.
 *   3. Message bodies and media are AES-GCM-256 encrypted with that
 *      conversation key. Only {ciphertext, iv} are stored.
 *   4. The derived conversation key is cached on each device once a thread
 *      is opened, so key changes later never corrupt the history.
 *
 * Honest limits (disclosed on the Privacy page and in the UI):
 *   - No forward secrecy: a static ECDH key pair is used, not a double
 *     ratchet. A device's private key decrypts everything derived with it.
 *   - Keys are device-bound: a device that signs in later has no key for
 *     conversations it never opened, so those stay unreadable there.
 */

const ALGORITHM = { name: "ECDH", namedCurve: "P-256" } as const;
const HKDF_INFO = new TextEncoder().encode("PureWire DM v1");
const CACHE_PREFIX = "purewire_dm_key_";
const PRIV_PREFIX = "purewire_dm_priv_";
const PUB_PREFIX = "purewire_dm_pub_";

/** Generate a fresh account keypair. Returns both halves as JWK JSON. */
export async function generateDmKeyPair(): Promise<{
  publicJwk: string;
  privateJwk: string;
}> {
  const pair = await crypto.subtle.generateKey(
    ALGORITHM,
    true, // extractable: we need to export both halves as JWK
    ["deriveKey", "deriveBits"],
  );
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  return {
    publicJwk: JSON.stringify(publicJwk),
    privateJwk: JSON.stringify(privateJwk),
  };
}

/** Import a peer's public JWK (no usages — public keys need none). */
async function importPublic(jwkJson: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    JSON.parse(jwkJson) as JsonWebKey,
    ALGORITHM,
    false,
    [],
  );
}

/** Import this device's private JWK for deriving shared secrets. */
async function importPrivate(jwkJson: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    JSON.parse(jwkJson) as JsonWebKey,
    ALGORITHM,
    false,
    ["deriveBits"],
  );
}

/**
 * The shared AES-GCM-256 conversation key for one conversation.
 * `myPrivateJwk` is this device's key; `theirPublicJwk` is the peer's
 * public key (fetched from their account record). Both sides arrive at the
 * same key, and the server sees neither input nor output.
 */
async function deriveConversationKey(
  myPrivateJwk: string,
  theirPublicJwk: string,
  conversationId: string,
): Promise<CryptoKey> {
  const [myPrivate, theirPublic] = await Promise.all([
    importPrivate(myPrivateJwk),
    importPublic(theirPublicJwk),
  ]);
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: theirPublic },
    myPrivate,
    256,
  );
  // HKDF's base key must be a CryptoKey wrapping the ECDH shared secret
  // (importKey "HKDF" is the documented way to feed it input key material).
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    shared,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(conversationId),
      info: HKDF_INFO,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true, // extractable so the derived key can be cached on this device
    ["encrypt", "decrypt"],
  );
}

/**
 * Get (or derive and cache) the conversation key. Caching means a later
 * key change on either side can never corrupt an already-open thread: once
 * both devices have derived the key, history stays readable forever.
 */
export async function getOrCreateConversationKey(
  conversationId: string,
  myPrivateJwk: string,
  theirPublicJwk: string,
): Promise<CryptoKey> {
  const cached = safeGetItem(CACHE_PREFIX + conversationId);
  if (cached) {
    try {
      return await crypto.subtle.importKey(
        "raw",
        fromBase64(cached),
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    } catch {
      // A corrupted cache entry must not brick the thread — fall through
      // and re-derive.
    }
  }
  const key = await deriveConversationKey(
    myPrivateJwk,
    theirPublicJwk,
    conversationId,
  );
  const raw = await crypto.subtle.exportKey("raw", key);
  safeSetItem(CACHE_PREFIX + conversationId, toBase64(new Uint8Array(raw)));
  return key;
}

/** Encrypt a text message. Returns only what the server may store. */
export async function encryptText(
  key: CryptoKey,
  text: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text),
  );
  return {
    ciphertext: toBase64(new Uint8Array(cipher)),
    iv: toBase64(iv),
  };
}

/** Decrypt a text message. Throws on tampered or wrong-key ciphertext. */
export async function decryptText(
  key: CryptoKey,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(plain);
}

/** Encrypt media bytes (images/video/audio) for a DM attachment. */
export async function encryptBytes(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ data: Uint8Array<ArrayBuffer>; ivB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  // WebCrypto hands back a plain ArrayBuffer, so the wrapper is exactly
  // Uint8Array<ArrayBuffer> — directly usable as a BlobPart / BodyInit.
  return { data: new Uint8Array(cipher), ivB64: toBase64(iv) };
}

/** Decrypt media bytes fetched from storage. */
export async function decryptBytes(
  key: CryptoKey,
  data: ArrayBuffer | Uint8Array<ArrayBuffer>,
  iv: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    data,
  );
  return new Uint8Array(plain);
}

/* ---- device key storage (guarded — a blocked localStorage must never
        crash the page, matching the "Keep me signed in" pattern) ---- */

/** This device's private key for an account, or null if never generated. */
export function getDevicePrivateKey(userId: string): string | null {
  return safeGetItem(PRIV_PREFIX + userId);
}

/** The public half that was pushed to the account record, if known. */
export function getDevicePublicKey(userId: string): string | null {
  return safeGetItem(PUB_PREFIX + userId);
}

/** Persist this device's keypair for an account. */
export function setDeviceKeypair(
  userId: string,
  keypair: { publicJwk: string; privateJwk: string },
): void {
  safeSetItem(PRIV_PREFIX + userId, keypair.privateJwk);
  safeSetItem(PUB_PREFIX + userId, keypair.publicJwk);
}

/* ---- small guarded helpers ---- */

function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // No storage (private mode, sandboxed frame) — the thread still works
    // for the session; keys just won't survive a reload.
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
