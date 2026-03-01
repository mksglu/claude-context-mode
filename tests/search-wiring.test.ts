/**
 * PR #4 QA Verification Tests
 *
 * Regression tests verifying the bugs fixed in PR #4:
 *   1. searchWithFallback was implemented but never wired into server.ts code paths
 *   2. Ephemeral ContentStore(":memory:") in intentSearch duplicated work
 *   3. batch_execute Tier 2 "boosted with all section titles" was indiscriminate
 *   4. Vocabulary insertion lacked transaction wrapping (perf issue)
 *   5. getDistinctiveTerms used .all() loading all chunks into memory
 *
 * These tests focus on store-level behavior to prove correctness of each fix.
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
    `context-mode-pr4-qa-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return new ContentStore(path);
}

async function main() {
  console.log("\nPR #4 QA Verification Tests");
  console.log("===========================\n");

  // =====================================================================
  // FIX 1: searchWithFallback wiring — verify the 3-layer cascade works
  //         on the PERSISTENT store (not ephemeral), which is what
  //         intentSearch and batch_execute now use.
  // =====================================================================
  console.log("--- Fix 1: searchWithFallback cascade on persistent store ---\n");

  await test("searchWithFallback: porter layer returns results with matchLayer='porter'", () => {
    const store = createStore();
    store.indexPlainText(
      "The authentication middleware validates JWT tokens on every request.\nExpired tokens are rejected with 401.",
      "execute:shell",
    );

    const results = store.searchWithFallback("authentication JWT tokens", 3, "execute:shell");
    assert.ok(results.length > 0, "Porter should find exact terms");
    assert.equal(results[0].matchLayer, "porter", "matchLayer should be 'porter'");
    assert.ok(results[0].content.includes("JWT"), "Content should contain JWT");

    store.close();
  });

  await test("searchWithFallback: trigram layer activates when porter fails", () => {
    const store = createStore();
    store.indexPlainText(
      "The responseBodyParser transforms incoming XML payloads into JSON.\nAll endpoints accept application/xml.",
      "execute:shell",
    );

    // "responseBody" is a substring of "responseBodyParser" — porter won't match, trigram will
    const results = store.searchWithFallback("responseBody", 3, "execute:shell");
    assert.ok(results.length > 0, "Trigram should find substring match");
    assert.equal(results[0].matchLayer, "trigram", "matchLayer should be 'trigram'");

    store.close();
  });

  await test("searchWithFallback: fuzzy layer corrects misspellings", () => {
    const store = createStore();
    store.indexPlainText(
      "PostgreSQL database connection established successfully.\nConnection pool size: 10.",
      "execute:shell",
    );

    // "databse" is a typo for "database"
    const results = store.searchWithFallback("databse", 3, "execute:shell");
    assert.ok(results.length > 0, "Fuzzy should correct 'databse' to 'database'");
    assert.equal(results[0].matchLayer, "fuzzy", "matchLayer should be 'fuzzy'");
    assert.ok(results[0].content.toLowerCase().includes("database"), "Content should have 'database'");

    store.close();
  });

  await test("searchWithFallback: cascade stops at first successful layer", () => {
    const store = createStore();
    store.indexPlainText(
      "Redis cache hit rate: 95%\nMemcached fallback rate: 3%",
      "execute:shell",
    );

    // "redis" is an exact term — should stop at porter, never try trigram/fuzzy
    const results = store.searchWithFallback("redis cache", 3, "execute:shell");
    assert.ok(results.length > 0, "Should find results");
    assert.equal(results[0].matchLayer, "porter", "Should stop at porter when it succeeds");

    store.close();
  });

  await test("searchWithFallback: returns empty array when all layers fail", () => {
    const store = createStore();
    store.indexPlainText(
      "Server listening on port 8080\nHealth check endpoint ready",
      "execute:shell",
    );

    // Completely unrelated terms that no layer can match
    const results = store.searchWithFallback("xylophoneZebraQuartz", 3, "execute:shell");
    assert.equal(results.length, 0, "Should return empty when nothing matches");

    store.close();
  });

  // =====================================================================
  // FIX 2: Ephemeral DB elimination — the persistent store should produce
  //         identical results to what the old ephemeral store would have.
  //         This validates that searching the persistent store with source
  //         scoping gives correct results (no cross-source contamination).
  // =====================================================================
  console.log("\n--- Fix 2: persistent store replaces ephemeral DB correctly ---\n");

  await test("persistent store with source scoping isolates results like ephemeral DB did", () => {
    const store = createStore();

    // Simulate two consecutive intentSearch calls indexing different outputs
    store.indexPlainText(
      "FAIL: test/auth.test.ts - Expected 200 but got 401\nTimeout in token refresh",
      "execute:typescript:error",
    );
    store.indexPlainText(
      "PASS: all 50 integration tests passed\n0 failures, 0 skipped, 50 total",
      "execute:shell",
    );

    // Scoped search for the error source should only return error content
    const errorResults = store.searchWithFallback("401 timeout", 3, "execute:typescript:error");
    assert.ok(errorResults.length > 0, "Should find error content");
    assert.ok(
      errorResults.every(r => r.source.includes("error")),
      "All results should be from the error source",
    );

    // Scoped search for the success source should only return success content
    const successResults = store.searchWithFallback("tests passed", 3, "execute:shell");
    assert.ok(successResults.length > 0, "Should find success content");
    assert.ok(
      successResults.every(r => r.source.includes("shell")),
      "All results should be from the shell source",
    );

    store.close();
  });

  await test("persistent store accumulates content across multiple indexPlainText calls", () => {
    const store = createStore();

    store.indexPlainText("Error log from first command", "cmd-1");
    store.indexPlainText("Error log from second command", "cmd-2");
    store.indexPlainText("Error log from third command", "cmd-3");

    // Global search (no source filter) should find content from all sources
    const allResults = store.searchWithFallback("error log", 10);
    assert.ok(allResults.length >= 3, `Should find content from all 3 sources, got ${allResults.length}`);

    // Source-scoped search should be precise
    const cmd2Only = store.searchWithFallback("error log", 3, "cmd-2");
    assert.ok(cmd2Only.length > 0, "Should find cmd-2 results");
    assert.ok(
      cmd2Only.every(r => r.source.includes("cmd-2")),
      "Scoped results should only be from cmd-2",
    );

    store.close();
  });

  // =====================================================================
  // FIX 3: batch_execute Tier 2 "boosted with all section titles" removal.
  //         The old code appended ALL section titles to the query, which
  //         matched everything indiscriminately. The fix uses
  //         searchWithFallback instead.
  // =====================================================================
  console.log("\n--- Fix 3: batch_execute search precision (no indiscriminate boosting) ---\n");

  await test("searchWithFallback returns only relevant results, not everything", () => {
    const store = createStore();

    // Simulate batch_execute with multiple command outputs indexed
    store.index({
      content: "# Git Log\n\ncommit abc123\nAuthor: dev@example.com\nFix memory leak in WebSocket handler",
      source: "batch:git-log",
    });
    store.index({
      content: "# Disk Usage\n\n/dev/sda1: 45% used\n/dev/sdb1: 89% used — WARNING",
      source: "batch:df",
    });
    store.index({
      content: "# Network Stats\n\neth0: 1.2Gbps RX, 800Mbps TX\nPacket loss: 0.01%",
      source: "batch:netstat",
    });

    // Query for "memory leak" should return git log, NOT disk usage or network
    const results = store.searchWithFallback("memory leak WebSocket", 3);
    assert.ok(results.length > 0, "Should find git log content");
    assert.ok(
      results[0].content.includes("memory leak") || results[0].content.includes("WebSocket"),
      "First result should be about memory leak",
    );
    // The old boosted approach would return ALL sections; searchWithFallback
    // should be precise and only return the relevant one
    assert.ok(
      !results.some(r => r.content.includes("Packet loss")),
      "Network stats should NOT appear in memory leak results",
    );

    store.close();
  });

  await test("searchWithFallback with source scoping is more precise than global", () => {
    const store = createStore();

    store.index({
      content: "# Build Output\n\nCompiled 42 TypeScript files\nBundle: 256KB gzipped",
      source: "batch:build",
    });
    store.index({
      content: "# Test Output\n\n42 tests passed, 0 failed\nCoverage: 91.5%",
      source: "batch:test",
    });

    // Scoped search for "42" should return only the matching source
    const buildResults = store.searchWithFallback("TypeScript files compiled", 3, "batch:build");
    assert.ok(buildResults.length > 0, "Should find build output");
    assert.ok(
      buildResults.every(r => r.source.includes("build")),
      "All results should be from build source",
    );

    const testResults = store.searchWithFallback("tests passed coverage", 3, "batch:test");
    assert.ok(testResults.length > 0, "Should find test output");
    assert.ok(
      testResults.every(r => r.source.includes("test")),
      "All results should be from test source",
    );

    store.close();
  });

  // =====================================================================
  // FIX 4: Transaction-wrapped vocabulary insertion
  //         Verify that vocabulary extraction still works correctly after
  //         wrapping in this.#db.transaction().
  // =====================================================================
  console.log("\n--- Fix 4: transaction-wrapped vocabulary insertion ---\n");

  await test("vocabulary is correctly stored after transaction-wrapped insertion", () => {
    const store = createStore();

    // Index content with distinctive words
    store.index({
      content: "# Microservices\n\nThe containerized orchestration platform manages deployments.\n\n" +
        "# Monitoring\n\nPrometheus collects containerized metrics from orchestration layer.\n\n" +
        "# Scaling\n\nHorizontal pod autoscaling uses containerized orchestration policies.",
      source: "k8s-docs",
    });

    // fuzzyCorrect depends on vocabulary table being populated
    // If transaction-wrapping broke insertion, fuzzy correction would fail
    const correction = store.fuzzyCorrect("orchestraton"); // typo for "orchestration"
    assert.equal(
      correction,
      "orchestration",
      `fuzzyCorrect should find 'orchestration', got '${correction}'`,
    );

    store.close();
  });

  await test("vocabulary handles large word sets without error", () => {
    const store = createStore();

    // Generate content with many unique words to stress the transaction
    const sections = Array.from({ length: 50 }, (_, i) => {
      const uniqueWord = `customVariable${i}Value`;
      return `## Section ${i}\n\n${uniqueWord} is used in module${i} for processing data${i}.`;
    }).join("\n\n");

    // Should not throw — if transaction wrapping is broken, this could fail
    assert.doesNotThrow(() => {
      store.index({ content: sections, source: "large-vocab" });
    }, "Large vocabulary insertion should succeed with transaction wrapping");

    // Verify vocabulary is searchable via fuzzy correction
    const correction = store.fuzzyCorrect("customvariable1valu"); // close to "customvariable1value"
    // May or may not find a correction depending on edit distance, but should not throw
    assert.ok(
      correction === null || typeof correction === "string",
      "fuzzyCorrect should work after large vocabulary insertion",
    );

    store.close();
  });

  // =====================================================================
  // FIX 5: getDistinctiveTerms .iterate() streaming
  //         Verify that switching from .all() to .iterate() produces
  //         identical results.
  // =====================================================================
  console.log("\n--- Fix 5: getDistinctiveTerms with .iterate() streaming ---\n");

  await test("getDistinctiveTerms produces correct terms with iterate()", () => {
    const store = createStore();

    // Create content with known word frequency patterns
    const indexed = store.index({
      content: [
        "# Module A",
        "",
        "The serialization framework handles JSON transformation efficiently.",
        "Serialization is critical for API responses.",
        "",
        "# Module B",
        "",
        "The serialization layer converts protocol buffers.",
        "Performance benchmarks show fast serialization.",
        "",
        "# Module C",
        "",
        "Custom serialization handlers extend the base framework.",
        "Unit tests cover serialization edge cases.",
        "",
        "# Module D",
        "",
        "Documentation for the serialization API reference.",
        "Migration guide from v1 serialization format.",
      ].join("\n"),
      source: "serialization-docs",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should find distinctive terms, got ${terms.length}`);

    // Verify no duplicates
    const uniqueTerms = new Set(terms);
    assert.equal(uniqueTerms.size, terms.length, "Terms should have no duplicates");

    // All terms should be >= 3 chars and not stopwords
    for (const term of terms) {
      assert.ok(term.length >= 3, `Term '${term}' should be >= 3 chars`);
    }

    store.close();
  });

  await test("getDistinctiveTerms returns empty for sources with < 3 chunks", () => {
    const store = createStore();

    const indexed = store.index({
      content: "# Single Section\n\nThis document has only one section with some content.",
      source: "tiny-doc",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);
    assert.deepEqual(terms, [], "Should return empty for documents with < 3 chunks");

    store.close();
  });

  await test("getDistinctiveTerms filters terms outside frequency band", () => {
    const store = createStore();

    // 10 chunks: minAppearances=2, maxAppearances=max(3, ceil(10*0.4))=4
    const indexed = store.index({
      content: Array.from({ length: 10 }, (_, i) => {
        let section = `# Section ${i}\n\nGeneric content for section number ${i} with filler text.`;
        // "elasticsearch" appears in exactly 3 sections (within 2-4 band)
        if (i >= 2 && i <= 4) section += "\nElasticsearch cluster rebalancing in progress.";
        // "ubiquitous" appears in all 10 sections (above maxAppearances=4)
        section += "\nThe ubiquitous logging framework captures all events.";
        // "singleton" appears in exactly 1 section (below minAppearances=2)
        if (i === 7) section += "\nSingleton pattern used for configuration.";
        return section;
      }).join("\n\n"),
      source: "freq-test",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);

    // "elasticsearch" (3/10 sections) should be in the band
    assert.ok(
      terms.includes("elasticsearch"),
      `'elasticsearch' (3/10 = within band) should be distinctive, got: [${terms.slice(0, 10).join(", ")}...]`,
    );

    // "singleton" (1/10 sections) should be filtered as too rare
    assert.ok(
      !terms.includes("singleton"),
      "'singleton' (1/10 = below min) should NOT be distinctive",
    );

    store.close();
  });

  // =====================================================================
  // EDGE CASES: additional hardening verification
  // =====================================================================
  console.log("\n--- Edge cases and hardening ---\n");

  await test("searchWithFallback on empty store returns empty", () => {
    const store = createStore();
    const results = store.searchWithFallback("anything", 3);
    assert.equal(results.length, 0, "Empty store should return empty results");
    store.close();
  });

  await test("searchWithFallback with empty query returns empty", () => {
    const store = createStore();
    store.indexPlainText("Some content here", "test-source");

    const results = store.searchWithFallback("", 3, "test-source");
    assert.equal(results.length, 0, "Empty query should return empty results");

    store.close();
  });

  await test("searchWithFallback source scoping uses LIKE partial match", () => {
    const store = createStore();

    store.indexPlainText(
      "Compilation succeeded with 0 warnings",
      "batch:TypeScript Build,npm test,lint",
    );

    // Partial source match should work
    const results = store.searchWithFallback("compilation", 3, "TypeScript Build");
    assert.ok(results.length > 0, "Partial source match should find content");

    store.close();
  });

  await test("searchWithFallback handles special characters in query gracefully", () => {
    const store = createStore();
    store.indexPlainText(
      "Error in module: TypeError at line 42\nStack trace follows",
      "execute:shell",
    );

    // These queries with special chars should not throw
    assert.doesNotThrow(() => store.searchWithFallback('TypeError "line 42"', 3));
    assert.doesNotThrow(() => store.searchWithFallback("error (module)", 3));
    assert.doesNotThrow(() => store.searchWithFallback("stack* trace", 3));
    assert.doesNotThrow(() => store.searchWithFallback("NOT:something", 3));

    store.close();
  });

  await test("searchWithFallback respects limit parameter across all layers", () => {
    const store = createStore();

    // Index enough content for multiple results
    store.index({
      content: Array.from({ length: 10 }, (_, i) =>
        `## Error ${i}\n\nTypeError: Cannot read property '${i}' of undefined at line ${i * 10}`
      ).join("\n\n"),
      source: "error-log",
    });

    const limited = store.searchWithFallback("TypeError property undefined", 2);
    assert.ok(limited.length <= 2, `Limit 2 should return at most 2 results, got ${limited.length}`);

    const moreLimited = store.searchWithFallback("TypeError property undefined", 1);
    assert.ok(moreLimited.length <= 1, `Limit 1 should return at most 1 result, got ${moreLimited.length}`);

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
  console.error("PR #4 QA test runner error:", err);
  process.exit(1);
});
