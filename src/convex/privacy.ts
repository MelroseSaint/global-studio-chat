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
 * Salted one-way hash of an email identity: SHA-256(email + server salt).
 *
 * The salt comes from the Convex deployment env (EMAIL_HASH_SALT) and is
 * never sent to clients, so a leaked database exposes only salted hashes —
 * unusable for lookup-table or rainbow-table attacks. Set it with:
 *
 *   npx convex env set EMAIL_HASH_SALT <long random hex>
 *
 * When no salt is configured the hash degrades to plain SHA-256 so the
 * platform keeps working (e.g. in local dev) — production must set it.
 */
export async function saltedEmailHash(email: string): Promise<string> {
  const salt = process.env.EMAIL_HASH_SALT ?? "";
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
