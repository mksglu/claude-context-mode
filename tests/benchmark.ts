import Database from "better-sqlite3";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sentinelPathForPid } from "../hooks/core/mcp-ready.mjs";
import { PolyglotExecutor } from "../src/executor.js";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
  type Language,
} from "../src/runtime.js";
import { ContentStore } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const START_SCRIPT = resolve(REPO_ROOT, "start.mjs");
const BASELINE_PATH = resolve(__dirname, "perf-baseline.json");

const ARGV = process.argv.slice(2);
const JSON_MODE = ARGV.includes("--json");
const log = (...args: unknown[]) => {
  if (!JSON_MODE) console.log(...args);
};

const runtimes = detectRuntimes();
const executor = new PolyglotExecutor({ runtimes });

interface BenchResult {
  name: string;
  language: string;
  iterations: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

async function bench(
  name: string,
  language: Language,
  code: string,
  iterations: number = 10,
): Promise<BenchResult | null> {
  // Check if runtime is available
  const runtimeMap: Record<string, string | null> = runtimes;
  if (
    language !== "javascript" &&
    language !== "shell" &&
    !runtimeMap[language]
  ) {
    log(`  - ${name} [${language}] SKIP (runtime not available)`);
    return null;
  }

  const times: number[] = [];

  // Warmup (2 rounds)
  for (let i = 0; i < 2; i++) {
    await executor.execute({ language, code, timeout: 15000 });
  }

  // Measure
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await executor.execute({ language, code, timeout: 15000 });
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const result = {
    name,
    language,
    iterations,
    avgMs: +(times.reduce((s, t) => s + t, 0) / times.length).toFixed(1),
    minMs: +times[0].toFixed(1),
    maxMs: +times[times.length - 1].toFixed(1),
    p50Ms: +times[Math.floor(times.length * 0.5)].toFixed(1),
    p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(1),
  };

  log(
    `  ${name} [${language}]: avg=${result.avgMs}ms min=${result.minMs}ms p95=${result.p95Ms}ms`,
  );
  return result;
}

// ═══ Search-path micro-benchmarks ═══════════════════════════════════════════
// Measures wall-clock cost on the FTS5 search hot path:
//   - fuzzy-correct LRU cache: repeat-typo lookup, cold vs warm
//   - token dedup: FTS5 MATCH cost with/without duplicated query tokens
// Uses the real ContentStore for the cache path and raw FTS5 for the dedup
// path (raw FTS5 isolates the engine-side cost without hitting ContentStore's
// pre-deduped sanitize).

const SEARCH_N_DOCS = 5000;
const SEARCH_N_ITERS = 2000;
const SEARCH_TOPICS = [
  "error", "database", "connection", "timeout", "server", "authentication",
  "middleware", "handler", "controller", "endpoint", "request", "response",
  "session", "cookie", "token", "signature", "encryption", "compression",
  "throttle", "retry", "backoff", "deadline", "cancelled", "succeeded",
  "failed", "warning", "notice", "debug", "trace", "panic", "fatal",
];

function usPerCall(fn: () => void, iters: number): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e3 / iters;
}

function cleanupSearchDB(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try { rmSync(p); } catch { /* ignore */ }
  }
}

function benchFuzzyCache(): { cold: number; warm: number } {
  const dbPath = join(tmpdir(), `bench-fuzzy-${Date.now()}.db`);
  const store = new ContentStore(dbPath);
  try {
    for (let i = 0; i < SEARCH_N_DOCS; i++) {
      const body = SEARCH_TOPICS.map((w) => `${w}${i % 13}`).join(" ") + ` doc_${i}`;
      store.indexPlainText(body, `src_${i}`);
    }
    const typo = "erorr"; // edit distance 2 from "error"
    const t0 = process.hrtime.bigint();
    store.fuzzyCorrect(typo);
    const cold = Number(process.hrtime.bigint() - t0) / 1e3;
    const warm = usPerCall(() => { store.fuzzyCorrect(typo); }, SEARCH_N_ITERS);
    return { cold, warm };
  } finally {
    (store as unknown as { close?: () => void }).close?.();
    cleanupSearchDB(dbPath);
  }
}

function benchTokenDedup(): { dup: number; deduped: number } {
  const dbPath = join(tmpdir(), `bench-dedup-${Date.now()}.db`);
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(`CREATE VIRTUAL TABLE fts USING fts5(content, source);`);
    const insert = db.prepare("INSERT INTO fts (content, source) VALUES (?, ?)");
    const tx = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        const body = SEARCH_TOPICS.map((w) => `${w}${i % 13}`).join(" ") + ` doc_${i}`;
        insert.run(body, `src_${i}`);
      }
    });
    tx(SEARCH_N_DOCS);
    const stmt = db.prepare(
      `SELECT source FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT 10`,
    );
    const dupQuery = `"error" AND "error" AND "error" AND "error" AND "error"`;
    const oneQuery = `"error"`;
    for (let i = 0; i < 100; i++) { stmt.all(dupQuery); stmt.all(oneQuery); }
    const dup = usPerCall(() => { stmt.all(dupQuery); }, SEARCH_N_ITERS);
    const deduped = usPerCall(() => { stmt.all(oneQuery); }, SEARCH_N_ITERS);
    return { dup, deduped };
  } finally {
    db.close();
    cleanupSearchDB(dbPath);
  }
}

function printTable(results: BenchResult[]) {
  console.log(
    "\n| Benchmark                     | Lang       | Avg (ms) | Min (ms) | P50 (ms) | P95 (ms) | Max (ms) |",
  );
  console.log(
    "|-------------------------------|------------|----------|----------|----------|----------|----------|",
  );
  for (const r of results) {
    console.log(
      `| ${r.name.padEnd(29)} | ${r.language.padEnd(10)} | ${String(r.avgMs).padStart(8)} | ${String(r.minMs).padStart(8)} | ${String(r.p50Ms).padStart(8)} | ${String(r.p95Ms).padStart(8)} | ${String(r.maxMs).padStart(8)} |`,
    );
  }
}

interface ConcurrentResult {
  concurrency: number;
  totalMs: number;
  perTaskMs: number;
}

interface ScenarioResult {
  name: string;
  outputBytes: number;
  rawBytes: number;
  savingsPct: number;
}

async function executorMain() {
  log("Context Mode — Performance Benchmarks");
  log("======================================\n");
  log("System:");
  log(getRuntimeSummary(runtimes));
  log(
    `\nBun detected: ${hasBunRuntime() ? "YES (fast path)" : "NO (using Node.js)"}`,
  );
  log();

  const results: BenchResult[] = [];
  const concurrentResults: ConcurrentResult[] = [];
  const scenarioResults: ScenarioResult[] = [];

  // === 1. Hello World (Cold Start Overhead) ===
  log("1. Hello World (measures cold start overhead):");
  const r1 = await bench(
    "hello-world",
    "javascript",
    'console.log("hello");',
  );
  if (r1) results.push(r1);

  const r2 = await bench(
    "hello-world",
    "typescript",
    'const m: string = "hello"; console.log(m);',
  );
  if (r2) results.push(r2);

  const r3 = await bench("hello-world", "python", 'print("hello")');
  if (r3) results.push(r3);

  const r4 = await bench("hello-world", "shell", 'echo "hello"');
  if (r4) results.push(r4);

  const r5 = await bench("hello-world", "ruby", 'puts "hello"');
  if (r5) results.push(r5);

  const r6 = await bench("hello-world", "perl", 'print "hello\\n";');
  if (r6) results.push(r6);

  const r7 = await bench("hello-world", "php", 'echo "hello\\n";');
  if (r7) results.push(r7);

  // === 2. JSON Processing ===
  log("\n2. JSON Processing (1000 items → summary):");
  const r8 = await bench(
    "json-process",
    "javascript",
    `
    const data = Array.from({length: 1000}, (_, i) => ({ id: i, v: Math.random() }));
    const sum = data.reduce((s, d) => s + d.v, 0);
    console.log(JSON.stringify({ count: data.length, sum: sum.toFixed(2) }));
  `,
  );
  if (r8) results.push(r8);

  const r9 = await bench(
    "json-process",
    "python",
    `
import json, random
data = [{"id": i, "v": random.random()} for i in range(1000)]
total = sum(d["v"] for d in data)
print(json.dumps({"count": len(data), "sum": round(total, 2)}))
  `,
  );
  if (r9) results.push(r9);

  const r10 = await bench(
    "json-process",
    "ruby",
    `
require 'json'
data = (0...1000).map { |i| { id: i, v: rand } }
total = data.sum { |d| d[:v] }
puts JSON.generate({ count: data.length, sum: total.round(2) })
  `,
  );
  if (r10) results.push(r10);

  // === 3. String Processing (10K lines) ===
  log("\n3. String Processing (10K lines → filter):");
  const r11 = await bench(
    "string-10k-filter",
    "javascript",
    `
    const lines = Array.from({length: 10000}, (_, i) => "line " + i + ": " + "x".repeat(80));
    const filtered = lines.filter(l => l.includes("999"));
    console.log("filtered:", filtered.length);
  `,
  );
  if (r11) results.push(r11);

  const r12 = await bench(
    "string-10k-filter",
    "python",
    `
lines = [f"line {i}: {'x' * 80}" for i in range(10000)]
filtered = [l for l in lines if "999" in l]
print(f"filtered: {len(filtered)}")
  `,
  );
  if (r12) results.push(r12);

  const r13 = await bench(
    "string-10k-filter",
    "shell",
    `seq 1 10000 | while read i; do echo "line $i"; done | grep "999" | wc -l | tr -d ' '`,
  );
  if (r13) results.push(r13);

  // === 4. Output Size ===
  log("\n4. Output Size (measures stream processing):");
  const r14 = await bench(
    "output-1kb",
    "javascript",
    'console.log("x".repeat(1024));',
  );
  if (r14) results.push(r14);

  const r15 = await bench(
    "output-10kb",
    "javascript",
    'console.log("x".repeat(10240));',
  );
  if (r15) results.push(r15);

  const r16 = await bench(
    "output-50kb",
    "javascript",
    'console.log("x".repeat(51200));',
  );
  if (r16) results.push(r16);

  const r17 = await bench(
    "output-100kb",
    "javascript",
    'console.log("x".repeat(102400));',
  );
  if (r17) results.push(r17);

  // === 5. Concurrent Execution ===
  log("\n5. Concurrent Execution:");
  for (const concurrency of [1, 5, 10, 20]) {
    const start = performance.now();
    const promises = Array.from({ length: concurrency }, (_, i) =>
      executor.execute({
        language: "javascript",
        code: `console.log("c${i}");`,
      }),
    );
    await Promise.all(promises);
    const total = performance.now() - start;
    const perTask = total / concurrency;
    concurrentResults.push({
      concurrency,
      totalMs: +total.toFixed(1),
      perTaskMs: +perTask.toFixed(1),
    });
    log(
      `  ${concurrency} concurrent: ${total.toFixed(0)}ms total, ${perTask.toFixed(1)}ms/task`,
    );
  }

  // === 6. Context Savings Simulation ===
  log("\n6. Context Savings (simulated real workloads):");

  const scenarios = [
    {
      name: "API Response (200 users)",
      rawSize: 50_000,
      code: `
        const data = Array.from({length: 200}, (_, i) => ({
          id: i, name: "User " + i, email: "u" + i + "@example.com",
          role: i % 5 === 0 ? "admin" : "user",
          meta: { logins: Math.floor(Math.random() * 100) }
        }));
        const admins = data.filter(u => u.role === "admin");
        console.log("Total:", data.length, "Admins:", admins.length);
      `,
    },
    {
      name: "Build Output (500 lines)",
      rawSize: 25_000,
      code: `
        const lines = Array.from({length: 500}, (_, i) => {
          const type = ["OK", "WARN", "ERROR"][Math.floor(Math.random() * 3)];
          return type + " module" + i;
        });
        const errors = lines.filter(l => l.startsWith("ERROR")).length;
        const warns = lines.filter(l => l.startsWith("WARN")).length;
        console.log("Total:", lines.length, "Errors:", errors, "Warnings:", warns);
      `,
    },
    {
      name: "Log File (1000 entries)",
      rawSize: 80_000,
      code: `
        const entries = Array.from({length: 1000}, (_, i) => ({
          ts: new Date(Date.now() - i * 60000).toISOString(),
          level: ["INFO","WARN","ERROR"][Math.floor(Math.random() * 3)],
          msg: "Event " + i
        }));
        const errors = entries.filter(e => e.level === "ERROR");
        console.log("Entries:", entries.length, "Errors:", errors.length);
        console.log("Recent errors:", errors.slice(0, 3).map(e => e.msg).join(", "));
      `,
    },
    {
      name: "npm ls output",
      rawSize: 40_000,
      code: `
        const deps = Array.from({length: 150}, (_, i) => ({
          name: "pkg-" + i,
          version: Math.floor(Math.random()*10) + "." + Math.floor(Math.random()*20) + ".0",
          depth: Math.floor(Math.random() * 4)
        }));
        const top = deps.filter(d => d.depth === 0);
        console.log("Total:", deps.length, "Top-level:", top.length);
      `,
    },
  ];

  for (const s of scenarios) {
    const r = await executor.execute({
      language: "javascript",
      code: s.code,
    });
    const savings = +((1 - r.stdout.length / s.rawSize) * 100).toFixed(0);
    scenarioResults.push({
      name: s.name,
      outputBytes: r.stdout.length,
      rawBytes: s.rawSize,
      savingsPct: savings,
    });
    log(
      `  ${s.name}: ${r.stdout.length} bytes output (was ~${(s.rawSize / 1024).toFixed(0)}KB) → ${savings}% context saved`,
    );
  }

  // === Search Path Performance (FTS5 hot path) ===
  log("\n=== Search Path Performance ===");
  log(
    `Setup: ${SEARCH_N_DOCS} seeded documents, ${SEARCH_N_ITERS} iterations per measurement`,
  );

  const fuzzy = benchFuzzyCache();
  log("\nfuzzy-correct LRU cache (ContentStore)");
  log(`  cold (1st call, levenshtein over vocab) : ${fuzzy.cold.toFixed(1)} µs`);
  log(`  warm (cache hit, avg of ${SEARCH_N_ITERS})      : ${fuzzy.warm.toFixed(2)} µs`);
  log(`  speedup                                  : ${(fuzzy.cold / fuzzy.warm).toFixed(0)}×`);

  const dedup = benchTokenDedup();
  log(`\ntoken dedup (raw FTS5, ${SEARCH_N_DOCS} docs)`);
  log(`  5× duplicate tokens (pre-dedup) : ${dedup.dup.toFixed(1)} µs/query`);
  log(`  1 token (post-dedup)            : ${dedup.deduped.toFixed(1)} µs/query`);
  log(`  speedup from dedup              : ${(dedup.dup / dedup.deduped).toFixed(2)}×`);

  // === Print Summary Table ===
  log("\n=== Full Results Table ===");
  if (!JSON_MODE) printTable(results);

  // === Comparison Note ===
  log("\n=== Comparison: context-mode vs raw cat/bash ===");
  log(
    "When Claude Code uses cat/head/Read to view a 50KB file, ALL 50KB enters context.",
  );
  log(
    "With context-mode execute_file, only the summary (typically 100-500 bytes) enters context.",
  );
  log("This means 95-99% context savings on large files.\n");

  if (JSON_MODE) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: "ctx-bench/v1",
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          benchmarks: results,
          concurrent: concurrentResults,
          search: {
            fuzzyColdUs: +fuzzy.cold.toFixed(2),
            fuzzyWarmUs: +fuzzy.warm.toFixed(2),
            dedupDupUs: +dedup.dup.toFixed(2),
            dedupDedupedUs: +dedup.deduped.toFixed(2),
          },
          scenarios: scenarioResults,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

// ═══ Cold-start mode (--cold-start) ════════════════════════════════════════
// Spawns N fresh `node start.mjs` processes, polls for MCP-ready sentinel,
// records elapsed wall-clock per iteration, prints p50/p95/p99 + skip count.
// Requires `server.bundle.mjs` for representative numbers (run `npm run bundle`).

const COLD_ITERATIONS = Number(process.env.ITERATIONS ?? 10);
const COLD_WARMUP = Number(process.env.WARMUP ?? 1);
const COLD_TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30000);
const COLD_POLL_MS = Number(process.env.POLL_MS ?? 10);

type IterationStatus = "ok" | "timeout" | "spawn-error";

interface IterationResult {
  status: IterationStatus;
  elapsedMs: number;
  stderr: string;
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
      resolveResult({ status, elapsedMs, stderr: stderrBuf.trim() });
    };

    child.once("error", () => {
      void settle("spawn-error", performance.now() - start);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
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
    }, COLD_POLL_MS);

    timeoutTimer = setTimeout(() => {
      void settle("timeout", performance.now() - start);
    }, COLD_TIMEOUT_MS);
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function fmtMs(ms: number): string {
  return ms.toFixed(1);
}

async function coldStartMain(): Promise<void> {
  log("Context Mode — Cold-Start Benchmark");
  log("====================================");
  log(`Node:        ${process.version}`);
  log(`Platform:    ${process.platform} (${process.arch})`);
  log(`Bundle:      ${existsSync(resolve(REPO_ROOT, "server.bundle.mjs")) ? "PRESENT" : "MISSING (will trigger build path)"}`);
  log(`Iterations:  ${COLD_ITERATIONS} (warmup: ${COLD_WARMUP})`);
  log(`Timeout:     ${COLD_TIMEOUT_MS}ms per iteration`);
  log("");

  const sigintHandler = async () => {
    console.error("\nSIGINT received — killing live children...");
    await Promise.all(Array.from(liveChildren).map(killChild));
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  if (COLD_WARMUP > 0) {
    log(`Warming up (${COLD_WARMUP} iteration${COLD_WARMUP === 1 ? "" : "s"}, discarded)...`);
    for (let i = 0; i < COLD_WARMUP; i++) {
      const r = await measureSingleColdStart();
      log(`  warmup ${i + 1}: ${r.status === "ok" ? `${fmtMs(r.elapsedMs)}ms` : `SKIP (${r.status})`}`);
    }
    log("");
  }

  const results: IterationResult[] = [];
  for (let i = 0; i < COLD_ITERATIONS; i++) {
    const r = await measureSingleColdStart();
    results.push(r);
    if (r.status === "ok") {
      log(`  iteration ${i + 1}: ${fmtMs(r.elapsedMs)}ms`);
    } else {
      const tail = r.stderr ? ` — stderr: ${r.stderr.split("\n").pop()}` : "";
      log(`  iteration ${i + 1}: SKIP (${r.status})${tail}`);
    }
  }

  const okTimes = results
    .filter((r) => r.status === "ok")
    .map((r) => r.elapsedMs)
    .sort((a, b) => a - b);
  const skipCount = results.length - okTimes.length;

  log("");
  log("=== Summary ===");
  if (okTimes.length === 0) {
    if (JSON_MODE) {
      process.stdout.write(
        JSON.stringify(
          {
            schema: "ctx-coldstart/v1",
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            iterations: COLD_ITERATIONS,
            warmup: COLD_WARMUP,
            timeoutMs: COLD_TIMEOUT_MS,
            okCount: 0,
            skipCount,
            allSkipped: true,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      log("All iterations skipped — no successful measurements.");
    }
    process.off("SIGINT", sigintHandler);
    process.exit(1);
  }

  const min = okTimes[0];
  const max = okTimes[okTimes.length - 1];
  const p50 = percentile(okTimes, 0.5);
  const p95 = percentile(okTimes, 0.95);
  const p99 = percentile(okTimes, 0.99);

  log("| Metric    | Value (ms) |");
  log("|-----------|------------|");
  log(`| ok-count  | ${String(okTimes.length).padStart(10)} |`);
  log(`| skip-count| ${String(skipCount).padStart(10)} |`);
  log(`| min       | ${fmtMs(min).padStart(10)} |`);
  log(`| p50       | ${fmtMs(p50).padStart(10)} |`);
  log(`| p95       | ${fmtMs(p95).padStart(10)} |`);
  log(`| p99       | ${fmtMs(p99).padStart(10)} |`);
  log(`| max       | ${fmtMs(max).padStart(10)} |`);

  if (JSON_MODE) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: "ctx-coldstart/v1",
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          iterations: COLD_ITERATIONS,
          warmup: COLD_WARMUP,
          timeoutMs: COLD_TIMEOUT_MS,
          okCount: okTimes.length,
          skipCount,
          minMs: +min.toFixed(1),
          p50Ms: +p50.toFixed(1),
          p95Ms: +p95.toFixed(1),
          p99Ms: +p99.toFixed(1),
          maxMs: +max.toFixed(1),
        },
        null,
        2,
      ) + "\n",
    );
  }

  process.off("SIGINT", sigintHandler);
}

// ═══ Regression-check mode (--check / --update / --self-test) ══════════════
// Runs cold-start + executor benches in subprocesses, parses --json output,
// compares vs tests/perf-baseline.json for current platform, prints delta
// table or updates baseline. Reporting-only — never gates merge.

type Unit = "ms" | "us";
interface MetricValue { value: number; unit: Unit }
interface PlatformBaseline {
  node?: string;
  notes?: string;
  metrics: Record<string, MetricValue>;
}
interface Baseline {
  schemaVersion: string;
  lastUpdated: string;
  thresholds: { relPct: number; absFloorMs: number; absFloorUs: number };
  platforms: Record<string, PlatformBaseline>;
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function validateBaseline(b: unknown): asserts b is Baseline {
  if (!b || typeof b !== "object") throw new Error("baseline: not an object");
  const x = b as Record<string, unknown>;
  if (x.schemaVersion !== "ctx-perf-baseline/v1") {
    throw new Error(`baseline: unsupported schemaVersion ${String(x.schemaVersion)} (expected ctx-perf-baseline/v1)`);
  }
  const t = x.thresholds as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") throw new Error("baseline: thresholds missing or not object");
  for (const k of ["relPct", "absFloorMs", "absFloorUs"] as const) {
    const v = t[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`baseline: thresholds.${k} must be a positive finite number, got ${String(v)}`);
    }
  }
  if (!x.platforms || typeof x.platforms !== "object") throw new Error("baseline: platforms missing or not object");
}

function loadBaseline(): Baseline {
  const raw: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  validateBaseline(raw);
  return raw;
}

const BENCH_TIMEOUT_MS = 600_000; // 10 min ceiling — cold-start can run ~5min on Windows.

function runJsonBench(
  relPath: string,
  env: Record<string, string> = {},
  extraArgs: string[] = [],
): Record<string, unknown> {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(REPO_ROOT, relPath), ...extraArgs, "--json"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: BENCH_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (r.signal === "SIGKILL") {
    throw new Error(`${relPath} ${extraArgs.join(" ")} timed out (>${BENCH_TIMEOUT_MS / 1000}s)\n${r.stderr ?? ""}`);
  }
  if (r.status !== 0) {
    throw new Error(`${relPath} ${extraArgs.join(" ")} failed (exit ${r.status}):\n${r.stderr}`);
  }
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function extractMetrics(
  coldStart: Record<string, unknown>,
  executor: Record<string, unknown>,
): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};

  if (typeof coldStart.p95Ms === "number") {
    out["coldStart.p95Ms"] = { value: coldStart.p95Ms, unit: "ms" };
  }

  const benches = executor.benchmarks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(benches)) {
    for (const b of benches) {
      if (b.language !== "javascript") continue;
      const key = `executor.${b.name}/javascript.p95Ms`;
      if (typeof b.p95Ms === "number") {
        out[key] = { value: b.p95Ms, unit: "ms" };
      }
    }
  }

  const search = executor.search as Record<string, number> | undefined;
  if (search && typeof search.fuzzyWarmUs === "number") {
    out["search.fuzzyWarmUs"] = { value: search.fuzzyWarmUs, unit: "us" };
  }
  if (search && typeof search.dedupDedupedUs === "number") {
    out["search.dedupDedupedUs"] = { value: search.dedupDedupedUs, unit: "us" };
  }

  return out;
}

function regressionThreshold(baselineValue: number, unit: Unit, t: Baseline["thresholds"]): number {
  const floor = unit === "ms" ? t.absFloorMs : t.absFloorUs;
  return Math.max(baselineValue * t.relPct, floor);
}

interface DeltaRow {
  metric: string;
  unit: Unit;
  baseline: number | null;
  current: number;
  deltaAbs: number | null;
  deltaPct: number | null;
  status: "ok" | "regression" | "improved" | "new";
}

function checkRegressions(
  baseline: Baseline,
  platform: string,
  current: Record<string, MetricValue>,
): { rows: DeltaRow[]; regressions: DeltaRow[] } {
  const platformBaseline = baseline.platforms[platform];
  const rows: DeltaRow[] = [];

  for (const [metric, cur] of Object.entries(current)) {
    const base = platformBaseline?.metrics[metric];
    if (!base) {
      rows.push({
        metric, unit: cur.unit, baseline: null, current: cur.value,
        deltaAbs: null, deltaPct: null, status: "new",
      });
      continue;
    }
    const deltaAbs = cur.value - base.value;
    const deltaPct = (deltaAbs / base.value) * 100;
    const threshold = regressionThreshold(base.value, base.unit, baseline.thresholds);
    let status: DeltaRow["status"] = "ok";
    if (deltaAbs > threshold) status = "regression";
    else if (deltaAbs < -threshold) status = "improved";
    rows.push({
      metric, unit: cur.unit, baseline: base.value, current: cur.value,
      deltaAbs, deltaPct, status,
    });
  }

  rows.sort((a, b) => a.metric.localeCompare(b.metric));
  return { rows, regressions: rows.filter((r) => r.status === "regression") };
}

function fmtUnit(n: number, unit: Unit): string {
  return unit === "ms" ? `${n.toFixed(1)}ms` : `${n.toFixed(2)}µs`;
}

const STATUS_ICON: Record<DeltaRow["status"], string> = {
  ok: "OK  ",
  regression: "FAIL",
  improved: "FAST",
  new: "NEW ",
};

function printRegressionTable(rows: DeltaRow[]): void {
  console.log("");
  console.log(
    "| Status | Metric                                          | Baseline      | Current       | Δ (abs)       | Δ (%)    |",
  );
  console.log(
    "|--------|-------------------------------------------------|---------------|---------------|---------------|----------|",
  );
  for (const r of rows) {
    const icon = STATUS_ICON[r.status];
    const baseline = r.baseline === null ? "—" : fmtUnit(r.baseline, r.unit);
    const current = fmtUnit(r.current, r.unit);
    const dAbs = r.deltaAbs === null ? "—" : (r.deltaAbs >= 0 ? "+" : "") + fmtUnit(r.deltaAbs, r.unit);
    const dPct = r.deltaPct === null ? "—" : (r.deltaPct >= 0 ? "+" : "") + r.deltaPct.toFixed(1) + "%";
    console.log(
      `| ${icon}   | ${r.metric.padEnd(47)} | ${baseline.padStart(13)} | ${current.padStart(13)} | ${dAbs.padStart(13)} | ${dPct.padStart(8)} |`,
    );
  }
}

function updateBaseline(baseline: Baseline, platform: string, current: Record<string, MetricValue>): Baseline {
  const next: Baseline = structuredClone(baseline);
  next.lastUpdated = new Date().toISOString().slice(0, 10);
  next.platforms[platform] = {
    ...(next.platforms[platform] ?? {}),
    node: process.version,
    metrics: current,
  };
  return next;
}

function regressionSelfTest(): void {
  const errors: string[] = [];
  const t = { relPct: 0.05, absFloorMs: 50, absFloorUs: 5 };

  const thresh100ms = regressionThreshold(100, "ms", t);
  if (thresh100ms !== 50) errors.push(`thresh(100ms) expected 50, got ${thresh100ms}`);

  const thresh2000ms = regressionThreshold(2000, "ms", t);
  if (thresh2000ms !== 100) errors.push(`thresh(2000ms) expected 100, got ${thresh2000ms}`);

  const thresh50us = regressionThreshold(50, "us", t);
  if (thresh50us !== 5) errors.push(`thresh(50us) expected 5, got ${thresh50us}`);

  const baseline: Baseline = {
    schemaVersion: "test", lastUpdated: "2026-01-01", thresholds: t,
    platforms: { "test-arch": { metrics: {
      "metric.fast": { value: 100, unit: "ms" },
      "metric.slow": { value: 2000, unit: "ms" },
      "metric.us":   { value: 50, unit: "us" },
    } } },
  };
  const current: Record<string, MetricValue> = {
    "metric.fast": { value: 160, unit: "ms" },
    "metric.slow": { value: 2050, unit: "ms" },
    "metric.us":   { value: 44, unit: "us" },
    "metric.new":  { value: 10, unit: "ms" },
  };
  const result = checkRegressions(baseline, "test-arch", current);
  const byMetric = Object.fromEntries(result.rows.map((r) => [r.metric, r.status]));
  if (byMetric["metric.fast"] !== "regression") errors.push(`metric.fast expected regression, got ${byMetric["metric.fast"]}`);
  if (byMetric["metric.slow"] !== "ok") errors.push(`metric.slow expected ok, got ${byMetric["metric.slow"]}`);
  if (byMetric["metric.us"] !== "improved") errors.push(`metric.us expected improved, got ${byMetric["metric.us"]}`);
  if (byMetric["metric.new"] !== "new") errors.push(`metric.new expected new, got ${byMetric["metric.new"]}`);
  if (result.regressions.length !== 1) errors.push(`expected 1 regression, got ${result.regressions.length}`);

  const empty = extractMetrics({}, {});
  if (Object.keys(empty).length !== 0) errors.push(`extractMetrics({},{}) should be empty`);

  const ext = extractMetrics(
    { p95Ms: 300 },
    {
      benchmarks: [
        { name: "hello-world", language: "javascript", p95Ms: 50 },
        { name: "hello-world", language: "python", p95Ms: 80 },
      ],
      search: { fuzzyWarmUs: 1.5, dedupDedupedUs: 30 },
    },
  );
  if (!("executor.hello-world/javascript.p95Ms" in ext))
    errors.push("javascript bench missing from extracted metrics");
  if ("executor.hello-world/python.p95Ms" in ext)
    errors.push("python bench should not be in extracted metrics");
  if (ext["coldStart.p95Ms"]?.value !== 300) errors.push("coldStart.p95Ms not extracted");
  if (ext["search.fuzzyWarmUs"]?.value !== 1.5) errors.push("search.fuzzyWarmUs not extracted");

  // e2e: baseline JSON round-trip (updateBaseline → write → read → validate).
  const tmpBaselinePath = resolve(tmpdir(), `bench-self-test-${Date.now()}.json`);
  try {
    const seed: Baseline = {
      schemaVersion: "ctx-perf-baseline/v1",
      lastUpdated: "2026-01-01",
      thresholds: { relPct: 0.05, absFloorMs: 50, absFloorUs: 5 },
      platforms: {},
    };
    const updated = updateBaseline(seed, "test-arch", {
      "metric.x": { value: 100, unit: "ms" },
    });
    writeFileSync(tmpBaselinePath, JSON.stringify(updated, null, 2));
    const reloaded: unknown = JSON.parse(readFileSync(tmpBaselinePath, "utf8"));
    try {
      validateBaseline(reloaded);
      if (reloaded.platforms["test-arch"]?.metrics["metric.x"]?.value !== 100) {
        errors.push("baseline round-trip lost metric value");
      }
    } catch (e) {
      errors.push(`baseline round-trip validate failed: ${(e as Error).message}`);
    }
  } finally {
    try { rmSync(tmpBaselinePath); } catch { /* ignore */ }
  }

  // e2e: printRegressionTable doesn't throw on mixed-status rows (output suppressed).
  const tableRows: DeltaRow[] = [
    { metric: "a", unit: "ms", baseline: 100, current: 150, deltaAbs: 50, deltaPct: 50, status: "regression" },
    { metric: "b", unit: "us", baseline: null, current: 5, deltaAbs: null, deltaPct: null, status: "new" },
    { metric: "c", unit: "ms", baseline: 200, current: 180, deltaAbs: -20, deltaPct: -10, status: "improved" },
  ];
  const origLog = console.log;
  console.log = () => { /* suppress table output during self-test */ };
  try {
    printRegressionTable(tableRows);
  } catch (e) {
    errors.push(`printRegressionTable threw: ${(e as Error).message}`);
  } finally {
    console.log = origLog;
  }

  if (errors.length > 0) {
    console.error("self-test FAILED:");
    for (const e of errors) console.error("  -", e);
    process.exit(1);
  }
  console.log("self-test PASSED (15 assertions)");
}

async function regressionMain(): Promise<void> {
  const wantCheck = ARGV.includes("--check");
  const wantUpdate = ARGV.includes("--update");
  if (!wantCheck && !wantUpdate) {
    console.error("usage: benchmark.ts [--check | --update | --self-test] [--json]");
    process.exit(2);
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`baseline file missing: ${BASELINE_PATH}`);
    process.exit(2);
  }

  const baseline = loadBaseline();
  const platform = platformKey();

  console.error(`[perf-check] platform=${platform} node=${process.version}`);
  console.error("[perf-check] running cold-start bench...");
  const coldStart = runJsonBench(
    "tests/benchmark.ts",
    {
      ITERATIONS: process.env.PERF_COLDSTART_ITER ?? "10",
      WARMUP: process.env.PERF_COLDSTART_WARMUP ?? "1",
    },
    ["--cold-start"],
  );
  console.error("[perf-check] running executor bench...");
  const executorOut = runJsonBench("tests/benchmark.ts");

  const current = extractMetrics(coldStart, executorOut);

  if (wantUpdate) {
    const next = updateBaseline(baseline, platform, current);
    const tmp = BASELINE_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, BASELINE_PATH);
    console.error(`[perf-check] baseline updated for ${platform} (${Object.keys(current).length} metrics)`);
    return;
  }

  const { rows, regressions } = checkRegressions(baseline, platform, current);
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      schema: "ctx-perf-check/v1",
      platform, node: process.version,
      baselinePresent: platform in baseline.platforms,
      regressionCount: regressions.length,
      newCount: rows.filter((r) => r.status === "new").length,
      rows,
    }, null, 2) + "\n");
  } else {
    if (!(platform in baseline.platforms)) {
      console.log(`[perf-check] no baseline yet for ${platform} — all metrics will show NEW`);
    }
    printRegressionTable(rows);
    console.log("");
    if (regressions.length > 0) {
      console.log(`${regressions.length} regression(s) detected (informational; CI does not fail).`);
    } else {
      console.log("No regressions vs baseline.");
    }
  }
}

// ═══ Dispatcher ══════════════════════════════════════════════════════════════

const dispatch = async (): Promise<void> => {
  if (ARGV.includes("--self-test")) { regressionSelfTest(); return; }
  if (ARGV.includes("--cold-start")) return coldStartMain();
  if (ARGV.includes("--check") || ARGV.includes("--update")) return regressionMain();
  return executorMain();
};

dispatch().catch(async (err) => {
  await Promise.all(Array.from(liveChildren).map(killChild));
  const message = err instanceof Error ? err.message : String(err);
  let schema: "ctx-bench/v1" | "ctx-coldstart/v1" | "ctx-perf-check/v1" = "ctx-bench/v1";
  if (ARGV.includes("--cold-start")) schema = "ctx-coldstart/v1";
  else if (ARGV.includes("--check") || ARGV.includes("--update") || ARGV.includes("--self-test")) schema = "ctx-perf-check/v1";
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      schema,
      ok: false,
      errorKind: "unknown",
      message,
    }, null, 2) + "\n");
  } else {
    console.error("Benchmark error:", err);
  }
  process.exit(1);
});
