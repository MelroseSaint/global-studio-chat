/**
 * Privacy layer for PureWire.
 *
 * The platform never exposes plain-text email addresses to clients. Every
 * user record returned by an API goes through `publicUser`, which replaces
 * the address with a masked form for display. The SHA-256 hash lives on the
 * user document so the platform can reason about identity without holding
 * the plain address, which only ever exists inside the auth service (it is
 * required to deliver one-time codes and to link accounts).
 */

/** SHA-256 hex digest, via the runtime's Web Crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
 * Shape a user document for any PureWire surface: the plain-text `email`
 * field is never sent to clients — only its hash and a masked address.
 */
export function publicUser<T extends { email?: string | null }>(
  user: T,
): Omit<T, "email"> & {
  emailHash?: string | null;
  maskedEmail: string | null;
} {
  const { email, ...rest } = user;
  return { ...rest, maskedEmail: maskEmail(email) };
}
