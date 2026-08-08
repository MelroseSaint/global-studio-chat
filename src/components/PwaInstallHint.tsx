import { motion } from "framer-motion";
import { Download, X } from "lucide-react";
import { useState } from "react";

import { useDevice } from "@/lib/device";

const HINT_KEY = "purewire_install_hint_dismissed";

/**
 * Dismissible "Add to Home Screen" hint.
 *
 * Shows ONLY on iOS devices (iPhone/iPad — real iPads included, thanks to
 * the iPadOS Mac-masquerade detection in src/lib/device.ts) that are NOT
 * already running as an installed PWA (`isStandalone`). On everything else
 * — Android, desktop, or an already-installed app — it renders nothing, so
 * an installed member never sees install nags again.
 *
 * Dismissal persists in localStorage (same discipline as the SharingTip);
 * private mode just re-shows it.
 */
export function PwaInstallHint() {
  const { isIOS, isIPad, isStandalone } = useDevice();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Only meaningful on non-standalone iOS — installed PWAs and every other
  // platform get nothing.
  if (!isIOS || isStandalone || dismissed) return null;

  const target = isIPad ? "iPad" : "iPhone";

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="relative mx-4 mt-2 flex items-start gap-2.5 rounded-lg border border-l-[3px] border-l-primary bg-muted/40 px-3 py-2.5 text-sm sm:mx-5"
      role="note"
    >
      <Download className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Add PureWire to your Home Screen
        </span>
        <p className="mt-0.5 leading-snug text-muted-foreground">
          {isIPad ? (
            <>
              Tap the <b className="font-semibold text-foreground">Share</b>{" "}
              button in Safari, then{" "}
              <b className="font-semibold text-foreground">
                Add to Home Screen
              </b>{" "}
              — PureWire runs full-screen, with notifications and no browser
              chrome.
            </>
          ) : (
            <>
              Tap the <b className="font-semibold text-foreground">Share</b>{" "}
              button in Safari, then{" "}
              <b className="font-semibold text-foreground">
                Add to Home Screen
              </b>{" "}
              — PureWire opens like an app, with the notch tucked out of the
              way.
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(HINT_KEY, "1");
          } catch {
            /* private mode — fine, it just re-shows */
          }
          setDismissed(true);
        }}
        className="-mr-1 -mt-1 shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={`Dismiss ${target} install hint`}
      >
        <X className="size-3.5" />
      </button>
    </motion.div>
  );
}
