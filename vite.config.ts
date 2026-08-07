import path from "path";
import { readFileSync } from "fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Resolve the canonical site URL baked into index.html's SEO tags
 * (canonical, og:url, og:image, twitter:image, JSON-LD).
 *
 * The previous mechanism read Vite's `%VITE_SITE_URL%` token, which picked
 * up a stale build env var and shipped the Convex static-hosting host in
 * the canonical/OG tags of the production site — cross-host duplicate
 * content. This plugin substitutes the repo-owned `%PUREWIRE_SITE_URL%`
 * token from an explicit PUREWIRE_SITE_URL override only when set, and
 * defaults to the production host otherwise, so the canonical can never
 * silently regress. A future custom domain is one env var away:
 *
 *   PUREWIRE_SITE_URL=https://purewire.example npx vite build
 */
const SITE_URL_DEFAULT = "https://purewire.vercel.app";

function siteUrl(): Plugin {
  return {
    name: "purewire-site-url",
    configResolved() {
      // The stale dashboard var is what shipped the Convex host in the
      // canonical/OG tags. It is deliberately NOT read anymore — but if it
      // still exists in the Vercel project env (or a local env file), say so
      // loudly so it gets removed instead of confusing the next operator.
      if (process.env.VITE_SITE_URL) {
        console.warn(
          "[purewire-site-url] VITE_SITE_URL is set but ignored — the canonical " +
            "host is repo-owned (PUREWIRE_SITE_URL or the default). Remove " +
            "VITE_SITE_URL from the Vercel project env to avoid confusion.",
        );
      }
    },
    transformIndexHtml(html) {
      // process.env, not loadEnv: the override is an environment variable
      // (CI/Vercel), and hardcoding a mode would misbehave under `vite dev`.
      const url = (
        process.env.PUREWIRE_SITE_URL ??
        SITE_URL_DEFAULT
      ).replace(/\/+$/, "");
      return html.replaceAll("%PUREWIRE_SITE_URL%", url);
    },
  };
}

/**
 * Build-time PWA wiring. Two outputs:
 *
 * 1. precache-manifest.json — lists every hashed JS/CSS asset the build
 *    emitted plus a content-derived `version`. The service worker reads it
 *    at install to precache each chunk (so lazy routes like the Admin
 *    dashboard open offline), and the version keys the SW's cache name.
 *
 * 2. sw.js — the service worker itself, rendered from sw-template.js with
 *    the build version baked into the cache name. Because the version is a
 *    hash of the asset list, EVERY deploy emits a different sw.js: the
 *    browser reinstalls it, the new cache is precached fresh, and the
 *    activate handler purges the previous deploy's cache — eliminating the
 *    post-deploy stale-chunk crash where an open tab lazily imports a chunk
 *    by an old hash that no longer exists.
 *
 * The template lives at the repo root (sw-template.js), not in public/, so
 * Vite never serves a raw template or conflicts with the emitted artifact.
 */
function precacheManifest(): Plugin {
  return {
    name: "purewire-precache-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => /^assets\/.*\.(js|css)$/.test(name))
        .map((name) => `/${name}`)
        .sort();
      // Content-derived version: identical rebuilds reuse the same cache,
      // any asset change rotates it (old caches are purged on activate).
      const version = assets
        .join("|")
        .split("")
        .reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
        .toString(36);
      this.emitFile({
        type: "asset",
        fileName: "precache-manifest.json",
        source: JSON.stringify({ version, assets }, null, 2),
      });
      const template = readFileSync(
        path.resolve(__dirname, "sw-template.js"),
        "utf8",
      );
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template.replaceAll("__PUREWIRE_CACHE__", version),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), siteUrl(), precacheManifest()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the big shared libraries out of the entry bundle so the
        // initial load is lean and long-lived vendor chunks cache well
        // across deploys. Page routes are already code-split via lazy().
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@convex-dev") || id.includes("convex/")) {
            return "convex";
          }
          if (id.includes("framer-motion")) return "motion";
          if (id.includes("lucide-react")) return "icons";
          if (
            id.includes("radix") ||
            id.includes("sonner") ||
            id.includes("next-themes")
          ) {
            return "ui";
          }
          // Keep the whole react ecosystem in one chunk: react, react-dom,
          // react-router (and its deps), scheduler, react-is,
          // use-sync-external-store, react-intersection-observer, and the
          // react-adjacent scroll/ref helpers radix pulls in. Splitting any
          // of these across chunks creates a vendor -> react -> vendor
          // circular chunk, so they must all travel together. The broad
          // `react` match is intentional: react-router, react-dom and the
          // react-adjacent helpers all contain "react" — don't narrow it.
          if (
            id.includes("react") ||
            id.includes("react-router") ||
            id.includes("scheduler") ||
            id.includes("react-is") ||
            id.includes("use-sync-external-store") ||
            id.includes("react-intersection-observer") ||
            id.includes("react-remove-scroll") ||
            id.includes("react-style-singleton") ||
            id.includes("use-callback-ref") ||
            id.includes("use-sidecar") ||
            id.includes("cookie") ||
            id.includes("set-cookie-parser") ||
            id.includes("path-to-regexp")
          ) {
            return "react";
          }
          return "vendor";
        },
      },
    },
  },
});
