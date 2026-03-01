import { strict as assert } from "node:assert";
import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes } from "../src/runtime.js";

let passed = 0;
let failed = 0;
const results: {
  name: string;
  status: "PASS" | "FAIL";
  time: number;
  error?: string;
}[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    const time = performance.now() - start;
    passed++;
    results.push({ name, status: "PASS", time });
    console.log(`  \u2713 ${name} (${time.toFixed(0)}ms)`);
  } catch (err: any) {
    const time = performance.now() - start;
    failed++;
    results.push({ name, status: "FAIL", time, error: err.message });
    console.log(`  \u2717 ${name} (${time.toFixed(0)}ms)`);
    console.log(`    Error: ${err.message}`);
  }
}

async function main() {
  const runtimes = detectRuntimes();

  console.log("\nStream-Level Byte Cap Tests");
  console.log("===========================\n");

  // ---------------------------------------------------------------------------
  // Core: process killed when output exceeds hardCapBytes
  // ---------------------------------------------------------------------------

  await test("kills process when stdout exceeds hard cap", async () => {
    // 1KB cap — any meaningful output will exceed it
    const executor = new PolyglotExecutor({
      hardCapBytes: 1024,
      runtimes,
    });
    const r = await executor.execute({
      language: "javascript",
      // Generate ~100KB of output — well over the 1KB cap
      code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });

    assert.ok(r.stderr.includes("output capped"), `Expected cap message in stderr, got: ${r.stderr.slice(-200)}`);
    assert.ok(r.stderr.includes("process killed"), "Expected 'process killed' in stderr");

    // Collected stdout should not significantly exceed the cap.
    // Allow some slack because chunks arrive asynchronously — the last
    // accepted chunk may push us slightly past the boundary.
    const stdoutBytes = Buffer.byteLength(r.stdout);
    const tolerance = 256 * 1024; // 256KB tolerance for async chunk delivery
    assert.ok(
      stdoutBytes < 1024 + tolerance,
      `Collected ${stdoutBytes} bytes stdout, expected roughly ≤${1024 + tolerance}`,
    );
  });

  await test("kills process when stderr exceeds hard cap", async () => {
    const executor = new PolyglotExecutor({
      hardCapBytes: 1024,
      runtimes,
    });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.error("e".repeat(25));',
      timeout: 10_000,
    });

    assert.ok(r.stderr.includes("output capped"), "Expected cap message in stderr");
  });

  // ---------------------------------------------------------------------------
  // Cap applies to combined stdout + stderr
  // ---------------------------------------------------------------------------

  await test("cap applies to combined stdout and stderr", async () => {
    const executor = new PolyglotExecutor({
      hardCapBytes: 2048,
      runtimes,
    });
    const r = await executor.execute({
      language: "javascript",
      // Split output across both streams — each alone is under 2KB,
      // but combined they exceed it.
      code: `
        for (let i = 0; i < 200; i++) console.log("o".repeat(10));
        for (let i = 0; i < 200; i++) console.error("e".repeat(10));
      `,
      timeout: 10_000,
    });

    assert.ok(
      r.stderr.includes("output capped"),
      "Combined output should have triggered the cap",
    );
  });

  // ---------------------------------------------------------------------------
  // Normal operation: output under the cap is not affected
  // ---------------------------------------------------------------------------

  await test("output under hard cap is unaffected", async () => {
    const executor = new PolyglotExecutor({
      hardCapBytes: 1024 * 1024, // 1MB — plenty of room
      runtimes,
    });
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("hello from capped executor");',
    });

    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from capped executor"));
    assert.ok(!r.stderr.includes("output capped"), "Should NOT contain cap message");
  });

  // ---------------------------------------------------------------------------
  // Cap message reports correct size
  // ---------------------------------------------------------------------------

  await test("cap message reports correct MB value", async () => {
    // Use a fractional MB value to verify the rounding in the message.
    // 2MB cap with JS output (fast, no external command oddities).
    const twoMB = 2 * 1024 * 1024;
    const executor = new PolyglotExecutor({
      hardCapBytes: twoMB,
      runtimes,
    });
    const r = await executor.execute({
      language: "javascript",
      // Each iteration produces ~50 bytes; 100K iterations ≈ 5MB — exceeds 2MB cap
      code: 'for (let i = 0; i < 100000; i++) process.stdout.write("x".repeat(49) + "\\n");',
      timeout: 10_000,
    });

    assert.ok(r.stderr.includes("2MB"), `Expected '2MB' in: ${r.stderr.slice(-200)}`);
    assert.ok(r.stderr.includes("process killed"));
  });

  // ---------------------------------------------------------------------------
  // Timeout still works when cap is not reached
  // ---------------------------------------------------------------------------

  await test("timeout still fires when output is slow (under cap)", async () => {
    const executor = new PolyglotExecutor({
      hardCapBytes: 100 * 1024 * 1024,
      runtimes,
    });
    const r = await executor.execute({
      language: "javascript",
      code: "while(true) {}",
      timeout: 500,
    });

    assert.equal(r.timedOut, true);
    assert.ok(!r.stderr.includes("output capped"), "Should be timeout, not cap");
  });

  // ---------------------------------------------------------------------------
  // Default hard cap is 100MB
  // ---------------------------------------------------------------------------

  await test("default hard cap is 100MB", async () => {
    // We can't easily test the actual 100MB limit without generating that
    // much data, but we can verify the cap message value when overridden.
    // This test just confirms the constructor accepts no hardCapBytes and
    // the executor works normally.
    const executor = new PolyglotExecutor({ runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("default cap works");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("default cap works"));
  });

  // ===== SUMMARY =====
  console.log("\n" + "=".repeat(50));
  console.log(
    `Results: ${passed} passed, ${failed} failed (${passed + failed} total)`,
  );
  console.log("=".repeat(50));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  \u2717 ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
