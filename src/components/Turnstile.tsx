import { useEffect, useRef, useState } from "react";

/**
 * Cloudflare Turnstile human-check widget.
 *
 * Rendered only when VITE_TURNSTILE_SITE_KEY is configured (set it in
 * .env.production / your deploy env). When unconfigured it renders nothing
 * and the server-side check (api.security.verifyBotChallenge) reports the
 * challenge as disabled — so signups are never blocked by a missing key, and
 * the widget (a third-party script) is never loaded on the page.
 *
 * The token is delivered through onToken. Call reset() after a successful
 * submit so the widget is ready for the next attempt.
 */

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          theme?: string;
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? "";

export function Turnstile({
  onToken,
  onError,
}: {
  onToken: (token: string | null) => void;
  onError?: (error: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!SITE_KEY) return;
    let cancelled = false;

    const render = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      const id = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        theme: "dark",
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onError?.(true),
      });
      widgetIdRef.current = id;
      setReady(true);
    };

    if (window.turnstile) {
      render();
    } else {
      const script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = render;
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          // Remove, not reset — Auth.tsx mounts this component per form and
          // switches steps, so stale widgets must not linger on the page.
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // The widget may already be gone on unmount — safe to ignore.
        }
      }
    };
    // onToken / onError are stable via useCallback from the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!SITE_KEY) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div ref={containerRef} className="cf-turnstile" />
      {!ready ? (
        <p className="text-xs text-muted-foreground">Loading security check…</p>
      ) : null}
    </div>
  );
}
