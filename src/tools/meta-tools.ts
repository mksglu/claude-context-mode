import type { DatabaseAdapter } from "../session/analytics.js";

/**
 * Create a minimal in-memory DB adapter for when the session DB is unavailable.
 * All queries return empty results so AnalyticsEngine.queryAll() still works.
 */
export function createMinimalDbAdapter(): DatabaseAdapter {
  return {
    prepare: () => ({
      run: () => undefined,
      get: (..._args: unknown[]) => ({ cnt: 0, compact_count: 0, minutes: null, rate: 0, avg: 0, outcome: "exploratory" }),
      all: () => [],
    }),
  };
}
