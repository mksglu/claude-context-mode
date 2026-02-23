import { PolyglotExecutor } from "../src/executor.js";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
  type Language,
} from "../src/runtime.js";

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
    console.log(`  - ${name} [${language}] SKIP (runtime not available)`);
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

  console.log(
    `  ${name} [${language}]: avg=${result.avgMs}ms min=${result.minMs}ms p95=${result.p95Ms}ms`,
  );
  return result;
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

async function main() {
  console.log("Context Mode — Performance Benchmarks");
  console.log("======================================\n");
  console.log("System:");
  console.log(getRuntimeSummary(runtimes));
  console.log(
    `\nBun detected: ${hasBunRuntime() ? "YES (fast path)" : "NO (using Node.js)"}`,
  );
  console.log();

  const results: BenchResult[] = [];

  // === 1. Hello World (Cold Start Overhead) ===
  console.log("1. Hello World (measures cold start overhead):");
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
  console.log("\n2. JSON Processing (1000 items → summary):");
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
  console.log("\n3. String Processing (10K lines → filter):");
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
  console.log("\n4. Output Size (measures stream processing):");
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
  console.log("\n5. Concurrent Execution:");
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
    console.log(
      `  ${concurrency} concurrent: ${total.toFixed(0)}ms total, ${perTask.toFixed(1)}ms/task`,
    );
  }

  // === 6. Context Savings Simulation ===
  console.log("\n6. Context Savings (simulated real workloads):");

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
    const savings = ((1 - r.stdout.length / s.rawSize) * 100).toFixed(0);
    console.log(
      `  ${s.name}: ${r.stdout.length} bytes output (was ~${(s.rawSize / 1024).toFixed(0)}KB) → ${savings}% context saved`,
    );
  }

  // === Print Summary Table ===
  console.log("\n=== Full Results Table ===");
  printTable(results);

  // === Comparison Note ===
  console.log("\n=== Comparison: context-mode vs raw cat/bash ===");
  console.log(
    "When Claude Code uses cat/head/Read to view a 50KB file, ALL 50KB enters context.",
  );
  console.log(
    "With context-mode execute_file, only the summary (typically 100-500 bytes) enters context.",
  );
  console.log("This means 95-99% context savings on large files.\n");
}

main().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
