import { useEffect, useState } from "react";

/**
 * Device detection for the app shell.
 *
 * PureWire adapts phones → tablets → desktops, and the shell needs to know
 * which family it's running on to adjust correctly:
 *
 *   - iPadOS 13+ reports a Mac user-agent with `maxTouchPoints > 1` — the
 *     classic "iPad masquerades as a Mac" trap, handled here so a real
 *     iPad is never mistaken for a desktop.
 *   - Installed-PWA (`display-mode: standalone`) changes what overlays the
 *     screen: the notch / Dynamic Island status bar in black-translucent
 *     mode sits on top of the web view, so safe-area padding applies.
 *
 * The detected state is written onto `<html>` as `data-device`,
 * `data-ios`, `data-touch`, `data-tablet`, and `data-standalone` so CSS
 * can hook the exact family (`html[data-device="ipad"] …`), and the
 * `useDevice()` hook exposes it to React for any JS-side adjustment.
 * Detection runs once at bootstrap (main.tsx) so the first paint already
 * carries the right attributes — no flash of the wrong layout.
 */

export interface DeviceInfo {
  /** iPhone or iPod touch. */
  isIPhone: boolean;
  /** Real iPad, including iPadOS 13+ masquerading as a Mac. */
  isIPad: boolean;
  /** Any iOS device (iPhone, iPod, iPad). */
  isIOS: boolean;
  isAndroid: boolean;
  /** Primary input is a touch screen (coarse pointer / no hover). */
  isTouch: boolean;
  /** Tablet-class: a real iPad or a large touch screen. */
  isTablet: boolean;
  /** Running as an installed PWA (standalone display mode). */
  isStandalone: boolean;
  /** Coarse family label for `data-device`. */
  device:
    | "iphone"
    | "ipad"
    | "ios"
    | "android"
    | "desktop"
    | "other";
}

function ua(): string {
  return typeof navigator !== "undefined" ? navigator.userAgent : "";
}

function platform(): string {
  return typeof navigator !== "undefined" ? navigator.platform : "";
}

export function detectDevice(): DeviceInfo {
  const u = ua();
  const maxTouch =
    typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0;
  // iPadOS 13+ pretends to be a Mac: a Mac agent with a touch screen is a
  // real iPad (Safari, or a browser that adopts the desktop agent).
  // `navigator.platform` is the classic tell, but it's unreliable (some
  // browsers report the OS they run on, e.g. "Linux x86_64", regardless
  // of the user agent), so a Mac *agent* + any touch capability is the
  // resilient signal. Real iPads report 5-10 touch points; a MacBook's
  // Touch Bar reports 1 (a "touch" device without being an iPad) — the
  // test harness's hasTouch also reports 1, and calling that an iPad is
  // the safe, touch-first classification for the app shell.
  const isIPad =
    /iPad/i.test(u) ||
    (/Macintosh/i.test(u) && maxTouch > 0) ||
    (platform() === "MacIntel" && maxTouch > 0);
  const isIPhone = /iPhone|iPod/i.test(u);
  const isIOS = isIPad || isIPhone;
  const isAndroid = /Android/i.test(u);

  const coarse =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(pointer: coarse)").matches;
  const hoverNone =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(hover: none)").matches;
  const isTouch = coarse || hoverNone || maxTouch > 0;

  // Installed PWA, or iOS's legacy `navigator.standalone` flag.
  const standalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true);

  const isTablet = isIPad || (isTouch && !isIPhone && !isAndroid);

  const device: DeviceInfo["device"] = isIPhone
    ? "iphone"
    : isIPad
      ? "ipad"
      : isAndroid
        ? "android"
        : isTouch
          ? "ios"
          : "desktop";

  return {
    isIPhone,
    isIPad,
    isIOS,
    isAndroid,
    isTouch,
    isTablet,
    isStandalone: standalone,
    device,
  };
}

/**
 * Write the detected state onto `<html>` as data-* attributes so CSS can
 * target the exact family. Returns the info for callers that want it.
 * Safe to call repeatedly (idempotent) — the `useDevice` hook re-applies
 * it whenever the display mode changes (install / uninstall).
 */
export function applyDeviceAttributes(): DeviceInfo {
  const d = detectDevice();
  const root = document.documentElement;
  root.dataset.device = d.device;
  root.dataset.ios = String(d.isIOS);
  root.dataset.touch = String(d.isTouch);
  root.dataset.tablet = String(d.isTablet);
  root.dataset.standalone = String(d.isStandalone);
  return d;
}

/**
 * Reactive view of the device: applies the `<html>` attributes on mount
 * (catching install/uninstall transitions) and re-renders when the
 * standalone display mode changes.
 */
export function useDevice(): DeviceInfo {
  const [info, setInfo] = useState<DeviceInfo>(() => detectDevice());

  useEffect(() => {
    const update = () => setInfo(applyDeviceAttributes());
    update();
    const mql =
      typeof window !== "undefined"
        ? window.matchMedia?.("(display-mode: standalone)")
        : undefined;
    mql?.addEventListener?.("change", update);
    return () => mql?.removeEventListener?.("change", update);
  }, []);

  return info;
}
