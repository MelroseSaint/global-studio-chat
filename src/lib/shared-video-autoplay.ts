import { useEffect, useState } from "react";

import { useDevice } from "@/lib/device";

/**
 * Shared-post video autoplay policy.
 *
 * Shared posts (DMs, comment cards) currently autoplay muted video with
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
 *      flip it in Settings ("Play videos in shared posts automatically").
 *
 * The device detection runs through useDevice(), so the iPadOS
 * Mac-masquerade case lands in the iOS bucket too.
 */
const AUTOPLAY_KEY = "purewire_shared_video_autoplay";

export type AutoplayPreference = boolean | "auto";

/** What the user chose, if anything. "auto" = follow the device policy. */
export function readAutoplayPreference(): AutoplayPreference {
  try {
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
 * The resolved autoplay decision for shared-post videos, plus a setter
 * that persists the user's choice.
 */
export function useSharedVideoAutoplay(): {
  autoplay: boolean;
  /** "auto" (follow device) or an explicit true/false the user chose. */
  preference: AutoplayPreference;
  setPreference: (p: AutoplayPreference) => void;
} {
  const { isIOS } = useDevice();
  const [preference, setPreferenceState] = useState<AutoplayPreference>(
    readAutoplayPreference,
  );

  // Re-evaluate the conservative default when the device detection changes
  // (e.g. install/uninstall changes isIOS? it doesn't, but the hook stays
  // honest) or when the user flips the preference.
  const autoplay =
    preference === "auto" ? conservativeDefault(isIOS) : preference;

  const setPreference = (p: AutoplayPreference) => {
    setPreferenceState(p);
    try {
      if (p === "auto") localStorage.removeItem(AUTOPLAY_KEY);
      else localStorage.setItem(AUTOPLAY_KEY, String(p));
    } catch {
      /* private mode — preference just won't persist */
    }
  };

  // Keep the resolved decision live if a tab changes the preference.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTOPLAY_KEY) {
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
