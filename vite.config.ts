import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
