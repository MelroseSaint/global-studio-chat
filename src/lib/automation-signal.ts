/**
 * Browser-automation detection for PureWire (original implementation).
 *
 * PureWire's Terms require every member to be a real person, and its abuse
 * defenses (proof-of-work, rate limits, session fingerprints) get stronger
 * when they know whether the browser is being driven by automation. This
 * module inspects the browser for the well-known markers of headless
 * browsers, Playwright/Puppeteer/Selenium drivers, and CDP (Chrome DevTools
 * Protocol) instrumentation — the same tell-tales bot operators try to
 * hide — and produces a one-way, coarse score plus a list of matched
 * signals. It stores nothing itself: the score is filed by the server via
 * `automation.report`, which feeds the existing silent-flag pipeline.
 *
 * Privacy: every check is local and stateless; no fingerprint is sent raw,
 * no PII is collected. Only a 0–100 automation-likelihood score and a list
 * of matched signal names ever leave the device.
 */

export interface AutomationResult {
  /** 0–100 automation likelihood (0 = clearly a real browser). */
  score: number;
  /** Human-readable names of the matched signals (for the admin panel). */
  signals: string[];
}

/** Automation-likelihood weight per matched signal. */
const WEIGHTS: Record<string, number> = {
  webdriver: 25,
  cdpInjected: 20,
  playwright: 30,
  puppeteer: 30,
  headlessChrome: 20,
  noPlugins: 15,
  noChromeApi: 15,
  missingPermissions: 10,
  dimensionClue: 10,
  zeroTouchOnTouchUa: 15,
  controlledByRuntime: 30,
};

/**
 * Run every check that is safe in this environment and return the scored
 * result. Checks that throw (older browsers, exotic embeddings) are simply
 * skipped — a failure to fingerprint never blocks a real user.
 */
export function detectAutomation(): AutomationResult {
  const signals: string[] = [];

  // 1. navigator.webdriver — the single most reliable automation flag.
  //    Set true by Chrome/Edge/Firefox when an automation driver owns the
  //    browser; real users' browsers never set it.
  try {
    if ((navigator as { webdriver?: boolean }).webdriver === true) {
      signals.push("webdriver");
    }
  } catch {
    /* skip */
  }

  // 2. CDP-injected globals. Puppeteer/Playwright leave `cdc_`-prefixed
  //    objects on window, and the automation runtime usually patches
  //    window.chrome differently than a real browser.
  try {
    const keys = Object.getOwnPropertyNames(window).filter((k) =>
      k.startsWith("cdc_"),
    );
    if (keys.length > 0) signals.push("cdpInjected");
  } catch {
    /* skip */
  }

  // 3. Known automation globals.
  try {
    const w = window as unknown as Record<string, unknown>;
    if (
      typeof (w as { __playwright?: unknown }).__playwright !== "undefined" ||
      typeof (w as { __pw_manual_eval?: unknown }).__pw_manual_eval !==
        "undefined"
    ) {
      signals.push("playwright");
    }
    if (
      typeof (w as { _phantom?: unknown })._phantom !== "undefined" ||
      typeof (w as { callPhantom?: unknown }).callPhantom !== "undefined"
    ) {
      signals.push("puppeteer");
    }
  } catch {
    /* skip */
  }

  // 4. Headless user agent marker.
  try {
    const ua = navigator.userAgent ?? "";
    if (/HeadlessChrome|PhantomJS|Headless/i.test(ua)) {
      signals.push("headlessChrome");
    }
  } catch {
    /* skip */
  }

  // 5. Plugin inventory. Real desktop browsers report plugins; headless
  //    builds and many automation drivers report none (and no mimeTypes).
  try {
    if (
      navigator.plugins !== undefined &&
      navigator.plugins.length === 0 &&
      (navigator as { mimeTypes?: { length: number } }).mimeTypes?.length === 0
    ) {
      signals.push("noPlugins");
    }
  } catch {
    /* skip */
  }

  // 6. Chrome API surface. Real Chrome exposes chrome.csi / chrome.loadTimes;
  //    headless and CDP-spawned browsers often strip or patch them.
  try {
    const chromeLike = /Chrome\//.test(navigator.userAgent ?? "");
    const c = (window as { chrome?: Record<string, unknown> }).chrome;
    if (
      chromeLike &&
      !/Edg\//.test(navigator.userAgent ?? "") &&
      c !== undefined &&
      typeof c.csi === "undefined" &&
      typeof c.loadTimes === "undefined"
    ) {
      signals.push("noChromeApi");
    }
  } catch {
    /* skip */
  }

  // 7. Permissions API presence. Automation runtimes sometimes run with a
  //    reduced permissions surface; absence alone is weak, so it's cheap.
  try {
    if (typeof navigator.permissions === "undefined") {
      signals.push("missingPermissions");
    }
  } catch {
    /* skip */
  }

  // 8. Viewport sanity. Some headless drivers report outer===inner (no
  //    chrome frame); real desktop browsers differ by > 30 px. Weak signal.
  try {
    if (
      window.outerWidth > 0 &&
      window.outerHeight > 0 &&
      Math.abs(window.outerWidth - window.innerWidth) < 10 &&
      Math.abs(window.outerHeight - window.innerHeight) < 10
    ) {
      signals.push("dimensionClue");
    }
  } catch {
    /* skip */
  }

  // 9. Touch consistency. A touch-capable UA reporting zero touch points is
  //    a common headless/emulator tell.
  try {
    const ua = (navigator.userAgent ?? "").toLowerCase();
    const touchPoints = (navigator as { maxTouchPoints?: number })
      .maxTouchPoints;
    if (
      (/mobile|android|iphone|ipad/i.test(ua) || (touchPoints ?? 0) > 0) &&
      typeof touchPoints === "number" &&
      touchPoints === 0 &&
      /mobile|android/i.test(ua)
    ) {
      signals.push("zeroTouchOnTouchUa");
    }
  } catch {
    /* skip */
  }

  // 10. WebDriver-controlled runtime hint (Selenium sets this on some
  //     browsers; harmless if absent).
  try {
    const r = (navigator as { webdriver?: boolean }).webdriver;
    if (r === true && signals.includes("webdriver")) {
      signals.push("controlledByRuntime");
    }
  } catch {
    /* skip */
  }

  // Score: sum the weights of matched signals, capped at 100. Multiple
  // independent markers compound — that's the point (one weak signal on its
  // own is noise; four together are a driver).
  const score = Math.min(
    100,
    signals.reduce((sum, s) => sum + (WEIGHTS[s] ?? 10), 0),
  );

  return { score, signals };
}
