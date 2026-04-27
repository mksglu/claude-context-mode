/**
 * Cold-start benchmark — measures spawn-to-ready latency for `node start.mjs`.
 *
 * Spawns N fresh node processes, polls for each child's MCP readiness sentinel
 * (`context-mode-mcp-ready-<pid>` in `sentinelDir()`), records elapsed time,
 * and prints p50/p95/p99 + skip count. Measurement only — no CI assertion.
 *
 * Usage:
 *   npm run bench:cold-start
 *   ITERATIONS=20 npm run bench:cold-start
 *   TIMEOUT_MS=10000 npm run bench:cold-start
 *
 * What it measures:
 *   process spawn → start.mjs self-heal → ensure-deps → import server.bundle.mjs
 *   → server.connect(transport) → writeFileSync(sentinel) appears.
 *
 * Caveats:
 *   - Requires `server.bundle.mjs` present for representative numbers. Without
 *     it, start.mjs falls into the `npx tsc --silent` first-build branch which
 *     dominates wall-clock. Run `npm run bundle` first if needed.
 *   - "Cold" here means fresh node process per iteration, NOT fresh disk state
 *     (no node_modules invalidation). Disk caches stay warm across iterations.
 *   - Wall-clock noise on shared-runner CI; p95 is the headline number.
 *   - SIGINT (Ctrl-C) cleanup is best-effort. If the bench script crashes
 *     mid-iteration, run `pgrep -f start.mjs` (Unix) and kill leaks manually.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sentinelPathForPid } from "../hooks/core/mcp-ready.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const START_SCRIPT = resolve(REPO_ROOT, "start.mjs");

const ITERATIONS = Number(process.env.ITERATIONS ?? 10);
const WARMUP = Number(process.env.WARMUP ?? 1);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30000);
const POLL_MS = Number(process.env.POLL_MS ?? 10);

type IterationStatus = "ok" | "timeout" | "spawn-error";

interface IterationResult {
  status: IterationStatus;
  elapsedMs: number;
  stderr: string;
  pid: number;
}

const liveChildren = new Set<ChildProcess>();

function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolveKill) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      liveChildren.delete(child);
      resolveKill();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      liveChildren.delete(child);
      resolveKill();
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (done) return;
      try {
        child.kill("SIGKILL");
      } catch { /* best effort */ }
      setTimeout(finish, 100);
    }, 500);
  });
}

function measureSingleColdStart(): Promise<IterationResult> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [START_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        // Force fresh project dir per iteration so each child gets isolated DB state.
        CONTEXT_MODE_PROJECT_DIR: REPO_ROOT,
      },
    });
    liveChildren.add(child);

    const start = performance.now();
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
    });

    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const settle = async (status: IterationStatus, elapsedMs: number) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      await killChild(child);
      resolveResult({
        status,
        elapsedMs,
        stderr: stderrBuf.trim(),
        pid: child.pid ?? -1,
      });
    };

    child.once("error", () => {
      void settle("spawn-error", performance.now() - start);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      // Premature exit before sentinel appeared.
      if (signal === null && code !== 0) {
        void settle("spawn-error", performance.now() - start);
      }
    });

    if (!child.pid) {
      void settle("spawn-error", 0);
      return;
    }

    const sentinelPath = sentinelPathForPid(child.pid);

    pollTimer = setInterval(() => {
      if (existsSync(sentinelPath)) {
        const elapsed = performance.now() - start;
        void settle("ok", elapsed);
      }
    }, POLL_MS);

    timeoutTimer = setTimeout(() => {
      void settle("timeout", performance.now() - start);
    }, TIMEOUT_MS);
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function fmt(ms: number): string {
  return ms.toFixed(1);
}

async function main(): Promise<void> {
  console.log("Context Mode — Cold-Start Benchmark");
  console.log("====================================");
  console.log(`Node:        ${process.version}`);
  console.log(`Platform:    ${process.platform} (${process.arch})`);
  console.log(`Bundle:      ${existsSync(resolve(REPO_ROOT, "server.bundle.mjs")) ? "PRESENT" : "MISSING (will trigger build path)"}`);
  console.log(`Iterations:  ${ITERATIONS} (warmup: ${WARMUP})`);
  console.log(`Timeout:     ${TIMEOUT_MS}ms per iteration`);
  console.log("");

  const sigintHandler = async () => {
    console.log("\nSIGINT received — killing live children...");
    await Promise.all(Array.from(liveChildren).map(killChild));
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  if (WARMUP > 0) {
    console.log(`Warming up (${WARMUP} iteration${WARMUP === 1 ? "" : "s"}, discarded)...`);
    for (let i = 0; i < WARMUP; i++) {
      const r = await measureSingleColdStart();
      console.log(`  warmup ${i + 1}: ${r.status === "ok" ? `${fmt(r.elapsedMs)}ms` : `SKIP (${r.status})`}`);
    }
    console.log("");
  }

  const results: IterationResult[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const r = await measureSingleColdStart();
    results.push(r);
    if (r.status === "ok") {
      console.log(`  iteration ${i + 1}: ${fmt(r.elapsedMs)}ms`);
    } else {
      const tail = r.stderr ? ` — stderr: ${r.stderr.split("\n").pop()}` : "";
      console.log(`  iteration ${i + 1}: SKIP (${r.status})${tail}`);
    }
  }

  const okTimes = results
    .filter((r) => r.status === "ok")
    .map((r) => r.elapsedMs)
    .sort((a, b) => a - b);
  const skipCount = results.length - okTimes.length;

  console.log("");
  console.log("=== Summary ===");
  if (okTimes.length === 0) {
    console.log("All iterations skipped — no successful measurements.");
    process.off("SIGINT", sigintHandler);
    process.exit(1);
  }

  const min = okTimes[0];
  const max = okTimes[okTimes.length - 1];
  const p50 = percentile(okTimes, 0.5);
  const p95 = percentile(okTimes, 0.95);
  const p99 = percentile(okTimes, 0.99);

  console.log("| Metric    | Value (ms) |");
  console.log("|-----------|------------|");
  console.log(`| ok-count  | ${String(okTimes.length).padStart(10)} |`);
  console.log(`| skip-count| ${String(skipCount).padStart(10)} |`);
  console.log(`| min       | ${fmt(min).padStart(10)} |`);
  console.log(`| p50       | ${fmt(p50).padStart(10)} |`);
  console.log(`| p95       | ${fmt(p95).padStart(10)} |`);
  console.log(`| p99       | ${fmt(p99).padStart(10)} |`);
  console.log(`| max       | ${fmt(max).padStart(10)} |`);

  process.off("SIGINT", sigintHandler);
}

main().catch(async (err) => {
  console.error("Cold-start bench error:", err);
  await Promise.all(Array.from(liveChildren).map(killChild));
  process.exit(1);
});
