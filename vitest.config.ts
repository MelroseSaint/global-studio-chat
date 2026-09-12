import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure unit tests of src/lib logic — no DOM, no network, no Convex.
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fail loudly rather than hanging if a solver ever regresses.
    testTimeout: 15_000,
  },
});
