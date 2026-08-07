import { useAuthToken } from "@convex-dev/auth/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { verifyAdminIp } from "@/lib/admin-ip";

/**
 * Backend-verified admin IP heartbeat (see src/convex/adminIp.ts).
 *
 * While an admin is signed in, this hook:
 *   1. verifies on mount — binding this session to the IP the backend
 *      actually observed;
 *   2. re-verifies on a heartbeat (well inside the backend TTL, so the
 *      binding never goes stale while the admin works);
 *   3. re-verifies when the tab regains focus or the network comes back —
 *      the two moments an IP can silently change (VPN toggled, mobile
 *      network swap);
 *   4. if the backend reports the session was used from a DIFFERENT IP
 *      (revoked), calls `onRevoked` — the caller signs the admin out, and
 *      the backend has already deleted the session, so no admin power
 *      survives a cross-network replay.
 *
 * The state is exposed for UI gating: the Admin page renders a
 * "verifying device" screen until `verified`, so its data queries never
 * fire (and error out) before the first verify lands. While the gate is
 * disabled (signed out, or not an admin) the exposed state is "idle".
 */
export type AdminIpState = "idle" | "verifying" | "verified" | "revoked" | "error";

const HEARTBEAT_MS = 4 * 60_000; // backend TTL is 15 min — verify ~4× inside it

export function useAdminIpVerify({
  enabled,
  onRevoked,
}: {
  enabled: boolean;
  onRevoked: () => void;
}): AdminIpState {
  const token = useAuthToken();
  const [state, setState] = useState<AdminIpState>("idle");
  const onRevokedRef = useRef(onRevoked);
  useEffect(() => {
    onRevokedRef.current = onRevoked;
  }, [onRevoked]);

  const run = useCallback(async () => {
    if (!enabled || token === null) return;
    setState((s) => (s === "idle" ? "verifying" : s));
    const result = await verifyAdminIp(token);
    if (result.ok) {
      if (result.revoked) {
        setState("revoked");
        onRevokedRef.current();
        return;
      }
      setState("verified");
    } else {
      // A transient failure must not brick the admin UI permanently — the
      // status query still gates the page, and the next heartbeat retries.
      setState((s) => (s === "verified" ? "verified" : "error"));
    }
  }, [enabled, token]);

  useEffect(() => {
    if (!enabled || token === null) return;
    // Defer the first verify off the effect's synchronous body (the linter
    // forbids setState there); a microtask is plenty — the fetch itself is
    // async anyway, and the Admin page gates on adminIpStatus meanwhile.
    queueMicrotask(() => void run());
    const heartbeat = setInterval(() => void run(), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    const onOnline = () => void run();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, token, run]);

  // While the gate is disabled the state is meaningless — expose "idle" so
  // callers never treat a stale "verified" as current after sign-out.
  return enabled && token !== null ? state : "idle";
}
