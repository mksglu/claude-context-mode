import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // macOS CI has been intermittently crashing in worker_threads while loading
    // the native better-sqlite3 path during npm test. Use forks on darwin
    // (like Windows) to keep native-addon isolation stable.
    pool: process.platform === "win32" || process.platform === "darwin"
      ? "forks"
      : "threads",
  },
});
