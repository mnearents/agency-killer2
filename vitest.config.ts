import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Tier 0 (default): fast deterministic tests only — excludes evals
    exclude: ["tests/evals/**", "node_modules/**"],
    // Fail if a test file matches but contains zero assertions
    passWithNoTests: false,
  },
});
