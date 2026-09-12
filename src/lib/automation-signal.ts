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

/**
 * The small slice of browser state the detector reads. Injectable for QA:
 * a clean profile and a simulated Playwright profile are unit-tested with
 * the same code path the browser runs.
 */
export interface AutomationBrowser {
  navigator: {
    webdriver?: boolean;
    userAgent?: string;
    plugins?: { length: number };
    mimeTypes?: { length: number };
    permissions?: unknown;
    maxTouchPoints?: number;
  };
  window: {
    getOwnPropertyNames?: (obj: object) => string[];
    chrome?: Record<string, unknown>;
    outerWidth?: number;
    outerHeight?: number;
    innerWidth?: number;
    innerHeight?: number;
  };
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
 * Run every check against a browser environment and return the scored
 * result. Defaults to the real browser globals; QA passes in synthetic
 * navigator/window objects to simulate clean and driven-browser profiles.
 * Checks that throw (older browsers, exotic embeddings) are simply
 * skipped — a failure to fingerprint never blocks a real user.
 */
export function detectAutomation(
  env: AutomationBrowser = {
    navigator: navigator as AutomationBrowser["navigator"],
    window: window as AutomationBrowser["window"],
  },
): AutomationResult {
  const signals: string[] = [];
  const { navigator: nav, window: win } = env;

  // 1. navigator.webdriver — the single most reliable automation flag.
  //    Set true by Chrome/Edge/Firefox when an automation driver owns the
  //    browser; real users' browsers never set it.
  try {
    if (nav.webdriver === true) {
      signals.push("webdriver");
    }
  } catch {
    /* skip */
  }

  // 2. CDP-injected globals. Puppeteer/Playwright leave `cdc_`-prefixed
  //    objects on window, and the automation runtime usually patches
  //    window.chrome differently than a real browser.
  try {
    const keys = (win.getOwnPropertyNames ?? Object.getOwnPropertyNames).call(
      null,
      win,
    );
    if (keys.some((k) => k.startsWith("cdc_"))) {
      signals.push("cdpInjected");
    }
  } catch {
    /* skip */
  }

  // 3. Known automation globals.
  try {
    const w = win as unknown as Record<string, unknown>;
    if (
      typeof w.__playwright !== "undefined" ||
      typeof w.__pw_manual_eval !== "undefined"
    ) {
      signals.push("playwright");
    }
    if (
      typeof w._phantom !== "undefined" ||
      typeof w.callPhantom !== "undefined"
    ) {
      signals.push("puppeteer");
    }
  } catch {
    /* skip */
  }

  // 4. Headless user agent marker.
  try {
    const ua = nav.userAgent ?? "";
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
      nav.plugins !== undefined &&
      nav.plugins.length === 0 &&
      nav.mimeTypes?.length === 0
    ) {
      signals.push("noPlugins");
    }
  } catch {
    /* skip */
  }

  // 6. Chrome API surface. Real Chrome exposes chrome.csi / chrome.loadTimes;
  //    headless and CDP-spawned browsers often strip or patch them.
  try {
    const chromeLike = /Chrome\//.test(nav.userAgent ?? "");
    const c = win.chrome;
    if (
      chromeLike &&
      !/Edg\//.test(nav.userAgent ?? "") &&
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
    if (typeof nav.permissions === "undefined") {
      signals.push("missingPermissions");
    }
  } catch {
    /* skip */
  }

  // 8. Viewport sanity. Some headless drivers report outer===inner (no
  //    chrome frame); real desktop browsers differ by > 30 px. Weak signal.
  try {
    if (
      (win.outerWidth ?? 0) > 0 &&
      (win.outerHeight ?? 0) > 0 &&
      Math.abs((win.outerWidth ?? 0) - (win.innerWidth ?? 0)) < 10 &&
      Math.abs((win.outerHeight ?? 0) - (win.innerHeight ?? 0)) < 10
    ) {
      signals.push("dimensionClue");
    }
  } catch {
    /* skip */
  }

  // 9. Touch consistency. A touch-capable UA reporting zero touch points is
  //    a common headless/emulator tell.
  try {
    const ua = (nav.userAgent ?? "").toLowerCase();
    const touchPoints = nav.maxTouchPoints;
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
    if (nav.webdriver === true && signals.includes("webdriver")) {
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
