import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // Native addons (better-sqlite3) can segfault in worker_threads during
    // process cleanup. Use forks on all platforms for stable isolation.
    pool: "forks",
    // Several suites spawn Node subprocesses via spawnSync (hook runners)
    // that load the better-sqlite3 native addon. When vitest ran those
    // files concurrently in separate fork workers, the child processes
    // intermittently received SIGKILL (empty stdout/stderr, status=null) —
    // likely from worker-teardown signal propagation under load.
    // Serializing files eliminates the race deterministically; tests
    // within a file still run sequentially as before (spawnSync is sync).
    fileParallelism: false,
  },
});
