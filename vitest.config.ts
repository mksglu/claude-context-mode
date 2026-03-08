import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    pool: process.platform === "win32" ? "forks" : "threads",
  },
});
