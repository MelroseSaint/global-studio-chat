/**
 * Client side of the backend-verified admin IP binding (see
 * src/convex/adminIp.ts).
 *
 * The app never claims an IP — the browser POSTs to the Convex site's
 * /admin/ip/verify endpoint with its bearer token, and the HTTP action
 * records the IP the edge actually OBSERVED (cf-connecting-ip /
 * x-forwarded-for). Only an HTTP action can see the real client IP:
 * Convex queries and mutations never receive request headers. This module
 * just performs that fetch; the AppLayout heartbeat drives it.
 *
 * The token is the same JWT the Convex client attaches to every request
 * (Authorization: Bearer …) — exactly the pattern @convex-dev/auth
 * documents for calling auth-protected HTTP actions.
 */

/** The Convex site URL (convex.site) derived from the API URL (convex.cloud). */
export function convexSiteUrl(): string {
  return (import.meta.env.VITE_CONVEX_URL ?? "")
    .replace(".convex.cloud", ".convex.site")
    .replace(/\/$/, "");
}

export type VerifyResult =
  | { ok: true; established: boolean; refreshed: boolean; revoked: boolean }
  | { ok: false; error: string };

/**
 * Ask the backend to verify this session's IP and (re)bind it. Returns the
 * action's verdict:
 *   - revoked: the backend saw a DIFFERENT IP than the one that bound this
 *     session and has already deleted the session — the caller must sign out.
 *   - established: first verification for this session.
 *   - refreshed: same IP as before, binding timestamp bumped.
 */
export async function verifyAdminIp(token: string): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await fetch(`${convexSiteUrl()}/admin/ip/verify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  } catch {
    return { ok: false, error: "Network error reaching the verify endpoint." };
  }
  let data: { ok?: boolean; error?: string } & Partial<VerifyResult>;
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, error: `Verify endpoint returned ${res.status}.` };
  }
  if (res.ok && data.ok === true) {
    return {
      ok: true,
      established: (data as { established?: boolean }).established ?? false,
      refreshed: (data as { refreshed?: boolean }).refreshed ?? false,
      revoked: (data as { revoked?: boolean }).revoked ?? false,
    };
  }
  return { ok: false, error: data.error ?? `Verify failed (${res.status}).` };
}
