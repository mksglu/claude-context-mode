/**
 * Intent Search vs Smart Truncation — Comparative Test
 *
 * Proves that intent-driven FTS5 search outperforms naive 60/40 head/tail
 * truncation for finding specific information buried in large output.
 *
 * Smart truncation keeps the first 60% and last 40% of bytes, dropping
 * the middle. Intent search indexes the full content via ContentStore
 * and retrieves only the chunks matching the user's intent.
 */

import { strict as assert } from "node:assert";
import { ContentStore } from "../src/store.js";

// ─────────────────────────────────────────────────────────
// Test harness (same pattern as store.test.ts)
// ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: {
  name: string;
  status: "PASS" | "FAIL";
  time: number;
  error?: string;
}[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
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

// ─────────────────────────────────────────────────────────
// Smart Truncation simulation (60% head + 40% tail)
// ─────────────────────────────────────────────────────────

function simulateSmartTruncation(raw: string, max: number): string {
  if (Buffer.byteLength(raw) <= max) return raw;
  const lines = raw.split("\n");
  const headBudget = Math.floor(max * 0.6);
  const tailBudget = max - headBudget;

  const headLines: string[] = [];
  let headBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1;
    if (headBytes + lineBytes > headBudget) break;
    headLines.push(line);
    headBytes += lineBytes;
  }

  const tailLines: string[] = [];
  let tailBytes = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const lineBytes = Buffer.byteLength(lines[i]) + 1;
    if (tailBytes + lineBytes > tailBudget) break;
    tailLines.unshift(lines[i]);
    tailBytes += lineBytes;
  }

  return headLines.join("\n") + "\n...[truncated]...\n" + tailLines.join("\n");
}

// ─────────────────────────────────────────────────────────
// Intent Search simulation (ContentStore + FTS5 BM25)
// ─────────────────────────────────────────────────────────

function simulateIntentSearch(
  content: string,
  intent: string,
  maxResults: number = 5,
): { found: string; bytes: number } {
  const store = new ContentStore(":memory:");
  try {
    store.indexPlainText(content, "test-output");
    const results = store.search(intent, maxResults);
    const text = results.map((r) => r.content).join("\n\n");
    return { found: text, bytes: Buffer.byteLength(text) };
  } finally {
    store.close();
  }
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const MAX_BYTES = 5000; // Same as INTENT_SEARCH_THRESHOLD

// ─────────────────────────────────────────────────────────
// Comparison tracking for summary table
// ─────────────────────────────────────────────────────────

interface ScenarioResult {
  name: string;
  truncationFound: string;
  intentFound: string;
  intentBytes: number;
  truncationBytes: number;
}

const scenarioResults: ScenarioResult[] = [];

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

async function main() {
  console.log("\nContext Mode — Intent Search vs Smart Truncation");
  console.log("=================================================\n");

  // ===== SCENARIO 1: Server Log — Error Buried in Middle =====
  console.log("--- Scenario 1: Server Log Error (line 347 of 500) ---\n");

  await test("server log: intent search finds error buried in middle", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      if (i === 346) {
        lines.push(
          "[ERROR] 2024-01-15T14:23:45Z Connection refused to database at 10.0.0.5:5432 - retry 3/3 failed",
        );
      } else {
        const minute = String(Math.floor(i / 60)).padStart(2, "0");
        const ms = (10 + (i % 90)).toString();
        lines.push(
          `[INFO] 2024-01-15T14:${minute}:${String(i % 60).padStart(2, "0")}Z Request processed in ${ms}ms - /api/endpoint-${i}`,
        );
      }
    }
    const logContent = lines.join("\n");

    // Smart truncation
    const truncated = simulateSmartTruncation(logContent, MAX_BYTES);
    const truncationFoundError = truncated
      .toLowerCase()
      .includes("connection refused");

    // Intent search
    const intentResult = simulateIntentSearch(
      logContent,
      "connection refused database error",
    );
    const intentFoundError = intentResult.found
      .toLowerCase()
      .includes("connection refused");

    console.log(
      `    Truncation found error: ${truncationFoundError ? "YES" : "NO"}`,
    );
    console.log(`    Intent search found error: ${intentFoundError ? "YES" : "NO"}`);
    console.log(`    Intent result size: ${intentResult.bytes} bytes`);
    console.log(
      `    Truncation result size: ${Buffer.byteLength(truncated)} bytes`,
    );

    scenarioResults.push({
      name: "Server Log Error",
      truncationFound: truncationFoundError ? "YES" : "NO",
      intentFound: intentFoundError ? "YES" : "NO",
      intentBytes: intentResult.bytes,
      truncationBytes: Buffer.byteLength(truncated),
    });

    // Intent search MUST find the error
    assert.ok(
      intentFoundError,
      "Intent search should find 'connection refused' error",
    );
  });

  // ===== SCENARIO 2: Test Results — 3 Failures Among 200 =====
  console.log(
    "\n--- Scenario 2: Test Failures (3 among 200 tests) ---\n",
  );

  await test("test results: intent search finds all 3 failures", () => {
    const failureLines: Record<number, string> = {
      67: "  \u2717 AuthSuite::testTokenExpiry FAILED - Expected 401 but got 200",
      134: "  \u2717 PaymentSuite::testRefundFlow FAILED - Expected 'refunded' but got 'pending'",
      189: "  \u2717 SearchSuite::testFuzzyMatch FAILED - Expected 5 results but got 0",
    };

    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (failureLines[i]) {
        lines.push(failureLines[i]);
      } else {
        const suite = ["AuthSuite", "PaymentSuite", "SearchSuite", "UserSuite", "APISuite"][i % 5];
        const ms = (5 + (i % 45)).toString();
        lines.push(`  \u2713 ${suite}::testMethod${i} (${ms}ms)`);
      }
    }
    const testOutput = lines.join("\n");

    // Smart truncation
    const truncated = simulateSmartTruncation(testOutput, MAX_BYTES);
    let truncationFailCount = 0;
    if (truncated.includes("testTokenExpiry")) truncationFailCount++;
    if (truncated.includes("testRefundFlow")) truncationFailCount++;
    if (truncated.includes("testFuzzyMatch")) truncationFailCount++;

    // Intent search — use terms that actually appear in the failure lines
    const intentResult = simulateIntentSearch(
      testOutput,
      "FAILED Expected but got",
    );
    let intentFailCount = 0;
    if (intentResult.found.includes("testTokenExpiry")) intentFailCount++;
    if (intentResult.found.includes("testRefundFlow")) intentFailCount++;
    if (intentResult.found.includes("testFuzzyMatch")) intentFailCount++;

    console.log(
      `    Truncation found: ${truncationFailCount}/3 failures`,
    );
    console.log(`    Intent search found: ${intentFailCount}/3 failures`);
    console.log(`    Intent result size: ${intentResult.bytes} bytes`);
    console.log(
      `    Truncation result size: ${Buffer.byteLength(truncated)} bytes`,
    );

    scenarioResults.push({
      name: "Test Failures (3)",
      truncationFound: `${truncationFailCount}/3`,
      intentFound: `${intentFailCount}/3`,
      intentBytes: intentResult.bytes,
      truncationBytes: Buffer.byteLength(truncated),
    });

    // Intent search MUST find all 3 failures
    assert.equal(
      intentFailCount,
      3,
      `Intent search should find all 3 failures, found ${intentFailCount}`,
    );
  });

  // ===== SCENARIO 3: Build Output — Warnings in Middle =====
  console.log(
    "\n--- Scenario 3: Build Warnings (2 among 300 lines) ---\n",
  );

  await test("build output: intent search finds both deprecation warnings", () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      if (i === 88) {
        lines.push(
          "  WARNING: 'left-pad' has been deprecated. Use 'string.prototype.padStart' instead.",
        );
      } else if (i === 200) {
        lines.push(
          "  WARNING: 'request' has been deprecated. Use 'node-fetch' instead.",
        );
      } else {
        const ms = (20 + (i % 180)).toString();
        lines.push(
          `  [built] ./src/components/Component${i}.tsx (${ms}ms)`,
        );
      }
    }
    const buildOutput = lines.join("\n");

    // Smart truncation
    const truncated = simulateSmartTruncation(buildOutput, MAX_BYTES);
    let truncationWarningCount = 0;
    if (truncated.includes("left-pad")) truncationWarningCount++;
    if (truncated.includes("'request'")) truncationWarningCount++;

    // Intent search
    const intentResult = simulateIntentSearch(
      buildOutput,
      "WARNING deprecated",
    );
    let intentWarningCount = 0;
    if (intentResult.found.includes("left-pad")) intentWarningCount++;
    if (intentResult.found.includes("'request'")) intentWarningCount++;

    console.log(
      `    Truncation found: ${truncationWarningCount}/2 warnings`,
    );
    console.log(
      `    Intent search found: ${intentWarningCount}/2 warnings`,
    );
    console.log(`    Intent result size: ${intentResult.bytes} bytes`);
    console.log(
      `    Truncation result size: ${Buffer.byteLength(truncated)} bytes`,
    );

    scenarioResults.push({
      name: "Build Warnings (2)",
      truncationFound: `${truncationWarningCount}/2`,
      intentFound: `${intentWarningCount}/2`,
      intentBytes: intentResult.bytes,
      truncationBytes: Buffer.byteLength(truncated),
    });

    // Intent search MUST find both warnings
    assert.equal(
      intentWarningCount,
      2,
      `Intent search should find both warnings, found ${intentWarningCount}`,
    );
  });

  // ===== SCENARIO 4: API Response — Auth Error in Large JSON =====
  console.log(
    "\n--- Scenario 4: API Auth Error (line 743 of 1000) ---\n",
  );

  await test("API response: intent search finds authentication error", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i === 742) {
        lines.push('  {');
        lines.push('    "error": "authentication_failed",');
        lines.push('    "message": "authentication failed, token expired at 2024-01-15T12:00:00Z",');
        lines.push('    "code": 401');
        lines.push('  },');
      } else {
        lines.push(
          `  { "id": ${i}, "name": "user_${i}", "status": "active", "score": ${(i * 7) % 100} },`,
        );
      }
    }
    const apiResponse = lines.join("\n");

    // Smart truncation
    const truncated = simulateSmartTruncation(apiResponse, MAX_BYTES);
    const truncationFoundAuth = truncated
      .toLowerCase()
      .includes("authentication failed");

    // Intent search
    const intentResult = simulateIntentSearch(
      apiResponse,
      "authentication failed token expired",
    );
    const intentFoundAuth = intentResult.found
      .toLowerCase()
      .includes("authentication failed");

    console.log(
      `    Truncation found auth error: ${truncationFoundAuth ? "YES" : "NO"}`,
    );
    console.log(
      `    Intent search found auth error: ${intentFoundAuth ? "YES" : "NO"}`,
    );
    console.log(`    Intent result size: ${intentResult.bytes} bytes`);
    console.log(
      `    Truncation result size: ${Buffer.byteLength(truncated)} bytes`,
    );

    scenarioResults.push({
      name: "API Auth Error",
      truncationFound: truncationFoundAuth ? "YES" : "NO",
      intentFound: intentFoundAuth ? "YES" : "NO",
      intentBytes: intentResult.bytes,
      truncationBytes: Buffer.byteLength(truncated),
    });

    // Intent search MUST find the auth error
    assert.ok(
      intentFoundAuth,
      "Intent search should find 'authentication failed' error",
    );
  });

  // ===== SUMMARY TABLE =====
  console.log("\n");
  console.log("=== INTENT SEARCH vs SMART TRUNCATION ===");
  console.log(
    "Scenario              | Truncation Found? | Intent Found? | Intent Size | Truncation Size",
  );
  console.log(
    "----------------------|-------------------|---------------|-------------|----------------",
  );

  for (const r of scenarioResults) {
    const name = r.name.padEnd(22);
    const trunc = r.truncationFound.padEnd(17);
    const intent = r.intentFound.padEnd(13);
    const intentSize = `${r.intentBytes} bytes`.padEnd(11);
    const truncSize = `${r.truncationBytes} bytes`;
    console.log(
      `${name}| ${trunc} | ${intent} | ${intentSize} | ${truncSize}`,
    );
  }

  console.log("");

  // ===== FINAL RESULTS =====
  console.log("=".repeat(60));
  console.log(
    `Results: ${passed} passed, ${failed} failed (${passed + failed} total)`,
  );
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  \u2717 ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Intent search test runner error:", err);
  process.exit(1);
});
