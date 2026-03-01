/**
 * Search Fallback Integration Tests
 *
 * Regression tests for fixes #2 and #3: verifying that `searchWithFallback`
 * works correctly with source-scoped persistent stores — the exact code path
 * used by `intentSearch` and `batch_execute` after eliminating the ephemeral
 * ContentStore(":memory:") pattern.
 *
 * These tests exercise the production search path:
 *   1. Index content into a persistent store via `indexPlainText`
 *   2. Search with `searchWithFallback(query, limit, source)` (source-scoped)
 *   3. Verify fallback cascade: porter → trigram → fuzzy
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../src/store.js";

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

function createStore(): ContentStore {
  const path = join(
    tmpdir(),
    `context-mode-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return new ContentStore(path);
}

// ─────────────────────────────────────────────────────────
// Mirrors the production intentSearch code path:
//   persistent.indexPlainText(stdout, source)
//   persistent.searchWithFallback(intent, maxResults, source)
// ─────────────────────────────────────────────────────────

async function main() {
  console.log("\nContext Mode — Search Fallback Integration Tests");
  console.log("================================================\n");

  // ===== SOURCE-SCOPED searchWithFallback via indexPlainText =====
  console.log("--- Source-scoped searchWithFallback (intentSearch path) ---\n");

  await test("intentSearch path: porter layer finds exact terms in source-scoped search", () => {
    const store = createStore();

    // Index two different sources (simulates multiple execute calls)
    store.indexPlainText(
      "ERROR: connection refused to database at 10.0.0.5:5432\nRetry 3/3 failed",
      "cmd-1: psql status",
    );
    store.indexPlainText(
      "All 42 tests passed in 3.2s\nCoverage: 87%",
      "cmd-2: npm test",
    );

    // Source-scoped search should only find results from the target source
    const results = store.searchWithFallback("connection refused", 3, "cmd-1");
    assert.ok(results.length > 0, "Should find results in cmd-1");
    assert.ok(
      results[0].content.includes("connection refused"),
      "Result should contain the search term",
    );
    assert.equal(results[0].matchLayer, "porter", "Should match via porter layer");

    // Should NOT leak results from other sources
    const wrongSource = store.searchWithFallback("connection refused", 3, "cmd-2");
    assert.equal(wrongSource.length, 0, "Should not find database errors in test output source");

    store.close();
  });

  await test("intentSearch path: trigram layer activates for partial/camelCase terms", () => {
    const store = createStore();

    store.indexPlainText(
      "The horizontalPodAutoscaler scaled deployment to 5 replicas\nCPU usage at 78%",
      "cmd-1: kubectl status",
    );

    // "horizontalPod" is a partial camelCase term — porter won't match, trigram will
    const results = store.searchWithFallback("horizontalPod", 3, "cmd-1");
    assert.ok(results.length > 0, "Trigram should find partial camelCase match");
    assert.ok(
      results[0].content.includes("horizontalPodAutoscaler"),
      "Should find the full term",
    );
    assert.equal(results[0].matchLayer, "trigram", "Should match via trigram layer");

    store.close();
  });

  await test("intentSearch path: fuzzy layer activates for typos", () => {
    const store = createStore();

    store.indexPlainText(
      "Kubernetes deployment rolled out successfully\nAll pods healthy",
      "cmd-1: kubectl rollout",
    );

    // "kuberntes" is a typo for "kubernetes" — fuzzy layer should correct
    const results = store.searchWithFallback("kuberntes", 3, "cmd-1");
    assert.ok(results.length > 0, "Fuzzy should correct typo and find match");
    assert.ok(
      results[0].content.toLowerCase().includes("kubernetes"),
      "Should find kubernetes content",
    );
    assert.equal(results[0].matchLayer, "fuzzy", "Should match via fuzzy layer");

    store.close();
  });

  await test("intentSearch path: no match returns empty (not an error)", () => {
    const store = createStore();

    store.indexPlainText(
      "Server started on port 3000\nReady to accept connections",
      "cmd-1: node server",
    );

    const results = store.searchWithFallback("xylophoneQuartzMango", 3, "cmd-1");
    assert.equal(results.length, 0, "Completely unrelated query should return empty");

    store.close();
  });

  // ===== MULTI-SOURCE ISOLATION =====
  console.log("\n--- Multi-source isolation (batch_execute path) ---\n");

  await test("batch_execute path: scoped search isolates results per source", () => {
    const store = createStore();

    // Simulate batch_execute indexing multiple command outputs
    store.index({
      content: "# Git Status\n\nOn branch main\n3 files changed, 42 insertions",
      source: "batch: git status",
    });
    store.index({
      content: "# Test Results\n\nAll 100 tests passed\n0 failures, 0 skipped",
      source: "batch: npm test",
    });
    store.index({
      content: "# Build Output\n\nCompiled 47 files in 2.3s\nBundle size: 142KB",
      source: "batch: npm build",
    });

    // Each scoped search should only return results from its source
    const gitResults = store.searchWithFallback("files changed", 3, "batch: git status");
    assert.ok(gitResults.length > 0, "Should find git status results");
    assert.ok(gitResults.every(r => r.source.includes("git status")), "All results should be from git status");

    const testResults = store.searchWithFallback("tests passed", 3, "batch: npm test");
    assert.ok(testResults.length > 0, "Should find test results");
    assert.ok(testResults.every(r => r.source.includes("npm test")), "All results should be from npm test");

    // Global fallback (no source filter) should search across all sources
    const globalResults = store.searchWithFallback("files", 10);
    assert.ok(globalResults.length > 0, "Global search should find results");

    store.close();
  });

  await test("batch_execute path: global fallback when scoped search fails", () => {
    const store = createStore();

    // Index content into one source
    store.index({
      content: "# Authentication\n\nJWT tokens expire after 24 hours\nRefresh tokens last 7 days",
      source: "docs: auth",
    });

    // Scoped search against wrong source returns empty
    const wrongScope = store.searchWithFallback("JWT tokens", 3, "docs: nonexistent");
    assert.equal(wrongScope.length, 0, "Wrong source scope should return empty");

    // Global fallback (no source) should find it
    const globalFallback = store.searchWithFallback("JWT tokens", 3);
    assert.ok(globalFallback.length > 0, "Global fallback should find the content");

    store.close();
  });

  // ===== getDistinctiveTerms after .iterate() change =====
  console.log("\n--- getDistinctiveTerms consistency (fix #9) ---\n");

  await test("getDistinctiveTerms returns terms for multi-chunk content", () => {
    const store = createStore();

    // getDistinctiveTerms requires chunk_count >= 3 and terms appearing in
    // at least 2 chunks. Use markdown with multiple headings to force chunking.
    const indexed = store.index({
      content: [
        "# Kubernetes Overview",
        "",
        "The horizontalPodAutoscaler manages Kubernetes pod replicas.",
        "Kubernetes clusters run containerized workloads.",
        "",
        "# Kubernetes Networking",
        "",
        "Kubernetes services expose pods via ClusterIP or LoadBalancer.",
        "The horizontalPodAutoscaler scales based on CPU metrics.",
        "",
        "# Kubernetes Storage",
        "",
        "PersistentVolumeClaims request storage from Kubernetes.",
        "The horizontalPodAutoscaler can also use custom metrics.",
        "",
        "# Monitoring",
        "",
        "Prometheus scrapes metrics from Kubernetes pods.",
        "Alerts fire when horizontalPodAutoscaler hits max replicas.",
      ].join("\n"),
      source: "k8s-docs",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should extract distinctive terms, got ${terms.length}`);

    // Terms appearing in ALL chunks are filtered as too common; terms in
    // only 1 chunk are filtered as too rare. The middle band survives.
    // "replicas", "pods", "metrics" appear in 2-3 of 4 chunks — distinctive.
    for (const term of terms) {
      assert.ok(term.length >= 3, `Term "${term}" should be at least 3 chars`);
    }

    store.close();
  });

  // ===== SUMMARY =====
  console.log("\n" + "=".repeat(60));
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
  console.error("Search fallback integration test runner error:", err);
  process.exit(1);
});
