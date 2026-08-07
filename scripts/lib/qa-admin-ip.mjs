#!/usr/bin/env node
/**
 * Shared helper for PureWire production QA scripts: verify an admin
 * session's backend-observed IP binding.
 *
 * Since requireAdmin now refuses admin power unless the backend has
 * recently OBSERVED this session's IP (see src/convex/adminIp.ts), every
 * QA script that mints or signs into an admin session must first POST to
 * the /admin/ip/verify HTTP action with the session's bearer token —
 * exactly like the real admin client does on load. Without it, a long
 * script that mints an admin session and calls admin-gated mutations later
 * would be cut off the moment the session's bootstrap grace elapses.
 *
 * Derives the convex.site URL from the convex.cloud URL (the standard
 * Convex mirror mapping), then performs the verify call.
 */

/** Derive the convex.site URL for a convex.cloud deployment URL. */
export function siteUrlFor(convexUrl) {
  return convexUrl.replace(".convex.cloud", ".convex.site").replace(/\/$/, "");
}

/**
 * Verify an admin session against the backend IP action. Resolves the
 * action's JSON verdict; throws on transport/HTTP errors.
 *
 * Returns { ok, established, refreshed, revoked } — `revoked: true` means
 * the backend deleted the session (IP mismatch) and admin power is gone.
 */
export async function verifyAdminIp({ convexUrl, token }) {
  const res = await fetch(`${siteUrlFor(convexUrl)}/admin/ip/verify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Verify endpoint failed (${res.status}): ${data?.error ?? "unknown"}`);
  }
  return data;
}

/**
 * Verify + assert the happy path: the session binds to the backend-observed
 * IP and is NOT revoked. Returns the verdict for the caller to check.
 */
export async function assertAdminIpVerified({ convexUrl, token }) {
  const verdict = await verifyAdminIp({ convexUrl, token });
  if (verdict.ok !== true) {
    throw new Error(`Admin IP verify reported failure: ${JSON.stringify(verdict)}`);
  }
  if (verdict.revoked === true) {
    throw new Error("Admin IP verify revoked the session on first verification.");
  }
  return verdict;
}
