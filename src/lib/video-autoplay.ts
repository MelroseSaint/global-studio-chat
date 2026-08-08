import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useDevice } from "@/lib/device";

/**
 * Video autoplay policy.
 *
 * Every inline video on the platform — the main feed's post cards and the
 * shared-post previews in DMs and comments — autoplays muted video with
 * controls. On cellular connections and low-power devices that traffic is
 * pure cost — the viewer never asked for it. The policy:
 *
 *   1. Default OFF on iOS. iOS Safari exposes neither the Network
 *      Information API (`navigator.connection` is undefined) nor Low
 *      Power Mode, and the overwhelming majority of iOS usage is
 *      cellular — so an iPhone/iPad user gets the conservative default
 *      (no autoplay; they tap play, which also satisfies Safari's
 *      user-gesture autoplay rule).
 *   2. Default ON elsewhere, unless the browser reports data-saving or a
 *      slow connection (`saveData`, effectiveType slow-2g/2g/3g) — then
 *      OFF.
 *   3. A persisted user preference overrides both defaults, so anyone can
 *      flip it in Settings ("Play videos automatically").
 *
 * The device detection runs through useDevice(), so the iPadOS
 * Mac-masquerade case lands in the iOS bucket too.
 *
 * The preference is ACCOUNT DATA: every change is mirrored to the users
 * row (users.setVideoAutoplay) so it survives across devices, is included
 * in the data export (exportMyData.preferences.videoAutoplay), and is
 * erased with the account. The localStorage copy is only a fast cache —
 * the server value wins whenever they disagree (see the sync effect).
 */
const AUTOPLAY_KEY = "purewire_video_autoplay";
// Pre-feed key, kept only for a one-time migration of existing choices.
const LEGACY_AUTOPLAY_KEY = "purewire_shared_video_autoplay";

export type AutoplayPreference = boolean | "auto";

/** What the user chose, if anything. "auto" = follow the device policy. */
export function readAutoplayPreference(): AutoplayPreference {
  try {
    // One-time migration: the policy used to be shared-posts-only under a
    // different key. Carry any existing choice forward so a user who opted
    // out of shared-post autoplay keeps it off on the feed too.
    if (localStorage.getItem(AUTOPLAY_KEY) === null) {
      const legacy = localStorage.getItem(LEGACY_AUTOPLAY_KEY);
      if (legacy !== null) {
        localStorage.setItem(AUTOPLAY_KEY, legacy);
        localStorage.removeItem(LEGACY_AUTOPLAY_KEY);
      }
    }
    const raw = localStorage.getItem(AUTOPLAY_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return "auto";
  } catch {
    return "auto";
  }
}

/** True when the current device/network would conservatively disable autoplay. */
function conservativeDefault(isIOS: boolean): boolean {
  if (isIOS) return false;
  // Non-iOS browsers can report data-saving and effective connection type.
  try {
    const nav = navigator as unknown as {
      connection?: { saveData?: boolean; effectiveType?: string };
    };
    const conn = nav.connection;
    if (conn?.saveData) return false;
    const eff = conn?.effectiveType;
    if (eff === "slow-2g" || eff === "2g" || eff === "3g") return false;
  } catch {
    // Unknown network — fall through to the default.
  }
  return true;
}

/**
 * The resolved autoplay decision for inline videos (feed cards and
 * shared-post previews alike), plus a setter that persists the user's
 * choice.
 */
/** Remove the browser-local preference cache (account erasure). */
export function clearAutoplayPreference(): void {
  try {
    localStorage.removeItem(AUTOPLAY_KEY);
    localStorage.removeItem(LEGACY_AUTOPLAY_KEY);
  } catch {
    /* private mode — nothing to clear */
  }
}

export function useVideoAutoplay(): {
  autoplay: boolean;
  /** "auto" (follow device) or an explicit true/false the user chose. */
  preference: AutoplayPreference;
  setPreference: (p: AutoplayPreference) => void;
} {
  const { isIOS } = useDevice();
  const { user } = useAuth();
  const setServerPreference = useMutation(api.users.setVideoAutoplay);
  // The server copy is the account truth (null while signed out or still
  // loading).
  const serverPref = user?.videoAutoplay ?? null;

  // Start from the fast local cache so the first paint never waits on the
  // server; the sync effect below adopts the server value once it loads.
  const [preference, setPreferenceState] = useState<AutoplayPreference>(
    readAutoplayPreference,
  );
  // When the user last changed the preference locally, so an in-flight
  // mutation echo (the reactive query briefly returning the old value) is
  // never mistaken for a cross-device change and reverted.
  const lastLocalChangeRef = useRef(0);

  // Re-evaluate the conservative default when the device detection changes
  // or when the user flips the preference.
  const autoplay =
    preference === "auto" ? conservativeDefault(isIOS) : preference;

  const setPreference = (p: AutoplayPreference) => {
    lastLocalChangeRef.current = Date.now();
    setPreferenceState(p);
    try {
      if (p === "auto") localStorage.removeItem(AUTOPLAY_KEY);
      else localStorage.setItem(AUTOPLAY_KEY, String(p));
    } catch {
      /* private mode — preference just won't persist */
    }
    // Mirror to the account (fire-and-forget; a failed write leaves the
    // local copy working and the next change retries).
    void setServerPreference({ preference: p });
  };

  // Adopt the server value: initial hydration and cross-device changes.
  // Guarded so a just-made local toggle isn't reverted by the mutation's
  // own echo (server queries update reactively within a round-trip).
  useEffect(() => {
    if (serverPref === null || serverPref === preference) return;
    if (Date.now() - lastLocalChangeRef.current < 1500) return;
    setPreferenceState(serverPref);
    try {
      if (serverPref === "auto") localStorage.removeItem(AUTOPLAY_KEY);
      else localStorage.setItem(AUTOPLAY_KEY, String(serverPref));
    } catch {
      /* private mode */
    }
  }, [serverPref, preference]);

  // Keep the resolved decision live if a tab changes the preference.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTOPLAY_KEY || e.key === LEGACY_AUTOPLAY_KEY) {
        setPreferenceState(readAutoplayPreference());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { autoplay, preference, setPreference };
}

/** The localStorage key, for the Settings toggle. */
export const AUTOPLAY_PREFERENCE_KEY = AUTOPLAY_KEY;
