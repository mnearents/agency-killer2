import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Tier 1 evals only — the model boundary tests
    include: ["tests/evals/**/*.test.ts"],
    passWithNoTests: false,
    // Evals are slow — longer timeout
    testTimeout: 60_000,
  },
});
