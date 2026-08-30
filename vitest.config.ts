import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{mjs,ts}"],
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
