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

/** SHA-256 hex digest, via the runtime's Web Crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    throw new Error(
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
