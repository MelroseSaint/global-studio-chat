import { ConvexError } from "convex/values";

/**
 * Privacy layer for PureWire.
 *
 * The platform never exposes plain-text email addresses to clients. Every
 * user record returned by an API goes through `publicUser`, which replaces
 * the address with a masked form for display. The salted SHA-256 hash lives on the
 * user document so the platform can reason about identity without holding
 * the plain address, which only ever exists inside the auth service (it is
 * required to deliver one-time codes and to link accounts).
 *
 * Home-location coordinates get the same treatment as the plain-text email:
 * if stored at all, they are only a coarsened ~1 km anchor (rounded by
 * `coarsenLocation` on every write, never the precise point) and
 * `publicLocation` strips them from every response — no surface ever
 * receives or displays them. Post coordinates exist server-side only to
 * power the Local feed and are reduced to their public label
 * (`publicLocation`) before any response is sent to a client.
 */

/**
 * Pure-JS SHA-256 hex digest. Convex mutations run in a deterministic V8
 * isolate that strips not only crypto.subtle but also TextEncoder and
 * DataView — only bare TypedArray and String APIs survive. This
 * implementation uses nothing beyond Uint8Array, Uint32Array, and standard
 * bitwise operators so it works in the mutation environment.
 */
export async function sha256Hex(input: string): Promise<string> {
  const msg = asciiBytes(input);
  const H = sha256Digest(msg);
  return bytesToHex(H);
}

// ---- pure-JS SHA-256 (FIPS 180-4) ---------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Encode an ASCII string to a Uint8Array. Emails and salts are ASCII-safe
 * (no multi-byte codepoints), and the Convex V8 isolate strips TextEncoder.
 */
function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

function sha256Digest(msg: Uint8Array): Uint8Array {
  // Initial hash values (first 32 bits of the fractional parts of the
  // square roots of the first 8 primes).
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  // Pre-processing: pad the message to a multiple of 512 bits.
  const ml = msg.length * 8; // message length in bits
  const padLen = (() => {
    const r = (msg.length + 9) % 64;
    return r === 0 ? 0 : 64 - r;
  })();
  const padded = new Uint8Array(msg.length + 1 + padLen + 8);
  padded.set(msg);
  padded[msg.length] = 0x80;

  // Append 64-bit big-endian length at the very end (no DataView —
  // manually write the bytes).
  const lenIdx = padded.length - 8;
  padded[lenIdx]     = 0;
  padded[lenIdx + 1] = 0;
  padded[lenIdx + 2] = 0;
  padded[lenIdx + 3] = 0;
  padded[lenIdx + 4] = (ml >>> 24) & 0xff;
  padded[lenIdx + 5] = (ml >>> 16) & 0xff;
  padded[lenIdx + 6] = (ml >>> 8)  & 0xff;
  padded[lenIdx + 7] =  ml         & 0xff;

  // Process each 512-bit chunk.
  for (let offset = 0; offset < padded.length; offset += 64) {
    const W = new Uint32Array(64);
    for (let t = 0; t < 16; t++) {
      W[t] =
        (padded[offset + t * 4] << 24) |
        (padded[offset + t * 4 + 1] << 16) |
        (padded[offset + t * 4 + 2] << 8) |
        padded[offset + t * 4 + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 =
        rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 =
        rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  // Convert to Uint8Array.
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (H[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (H[i] >>> 8) & 0xff;
    out[i * 4 + 3] = H[i] & 0xff;
  }
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * The current active salt version, from EMAIL_HASH_VERSION (default 1).
 *
 * Rotation procedure: set the new version's salt env (EMAIL_HASH_SALT_V2,
 * _V3, …), bump EMAIL_HASH_VERSION, redeploy, then run the one-pass
 * re-salt migration (internal.migrations.rehashEmailHashes) so every
 * existing hash converges immediately — no user ever waits for their next
 * sign-in to be re-salted.
 */
export function currentEmailHashVersion(): number {
  const raw = Number(process.env.EMAIL_HASH_VERSION);
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * The server salt for a given version. Version 1 reads EMAIL_HASH_SALT
 * (the original env name, kept for compatibility); later versions read
 * EMAIL_HASH_SALT_V{n}. Missing salts degrade to an empty string exactly
 * like the original single-salt scheme did, so nothing breaks in local dev.
 */
export function emailHashSaltForVersion(version: number): string {
  if (version <= 1) {
    return process.env.EMAIL_HASH_SALT ?? "";
  }
  return process.env[`EMAIL_HASH_SALT_V${version}`] ?? "";
}

/**
 * Salted one-way hash of an email identity: SHA-256(email + server salt).
 *
 * Version 1 keeps the original format byte-for-byte — `sha256(salt:email)`
 * with EMAIL_HASH_SALT — so hashes minted before this scheme existed stay
 * valid and never need rewriting until a rotation actually happens. Later
 * versions salt with their own env value, and each user record stores the
 * version that produced its hash (users.emailHashVersion) so verification
 * always knows which salt to use.
 *
 * The salt comes from the Convex deployment env and is never sent to
 * clients, so a leaked database exposes only salted hashes — unusable for
 * lookup-table or rainbow-table attacks. Set it with:
 *
 *   npx convex env set EMAIL_HASH_SALT <long random hex>
 *   npx convex env set EMAIL_HASH_SALT_V2 <another long random hex>
 *   npx convex env set EMAIL_HASH_VERSION 2
 *
 * When no salt is configured the hash degrades to plain SHA-256 so the
 * platform keeps working (e.g. in local dev) — production must set it.
 */
export async function saltedEmailHash(
  email: string,
  version: number = currentEmailHashVersion(),
): Promise<string> {
  const salt = emailHashSaltForVersion(version);
  // An empty salt at v1 is the local-dev convenience the legacy scheme had.
  // For any later version it is always a misconfiguration: running the
  // re-salt migration with the version bumped but the new salt env missing
  // would silently rewrite every stored hash to an UNSALTED one. Refuse to
  // hash rather than destroy the privacy guarantee. This function runs
  // inside the sign-in callback, so the error must read as a user-facing
  // message — the migration does its own pre-flight check with the detailed
  // operator guidance.
  if (version > 1 && salt.length === 0) {
    // ConvexError so the message crosses the public HTTP boundary — plain
    // Errors are masked as "Server Error" and the auth form would show a
    // generic failure instead of the real reason.
    throw new ConvexError(
      "PureWire is temporarily unavailable. Please try again in a moment.",
    );
  }
  return sha256Hex(`${salt}:${email}`);
}

/** Mask an address for display: jo••••@gmail.com → jo••••@gmail.com */
export function maskEmail(
  email: string | null | undefined,
): string | null {
  if (!email) {
    return null;
  }
  const at = email.indexOf("@");
  if (at <= 0) {
    return "••••";
  }
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}••••${domain}`;
}

/**
 * Reduce any location to its public label before it leaves the server.
 * Coordinates are sensitive — exactly like the plain-text email address —
 * so no client response ever carries them, even from pre-migration rows
 * that still hold them.
 */
export function publicLocation(
  location: unknown,
): { label?: string } | null | undefined {
  if (location === null || location === undefined) {
    return location;
  }
  const loc = location as { label?: string };
  return { label: loc.label };
}

/**
 * Shape a user document for any PureWire surface: the plain-text `email`
 * field is never sent to clients — only its hash and a masked address —
 * and any location is reduced to its public label, never coordinates.
 */
export function publicUser<
  T extends { email?: string | null; location?: unknown },
>(
  user: T,
): Omit<T, "email" | "location"> & {
  emailHash?: string | null;
  maskedEmail: string | null;
  location?: { label?: string } | null;
} {
  const { email, location, ...rest } = user;
  return {
    ...rest,
    ...(location !== undefined ? { location: publicLocation(location) } : {}),
    maskedEmail: maskEmail(email),
  };
}
