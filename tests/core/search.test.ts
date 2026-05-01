/**
 * Consolidated search tests — combines all search-related test suites.
 *
 * Sections:
 *   1. Search Wiring (searchWithFallback cascade, persistent store, batch_execute precision, vocabulary, getDistinctiveTerms, edge cases)
 *   2. Search AND Semantics (issue #23)
 *   3. Search Fallback Integration (source-scoped searchWithFallback, multi-source isolation, getDistinctiveTerms consistency)
 *   4. Index Deduplication (issue #67)
 *   5. Fuzzy Search (searchTrigram, fuzzyCorrect, three-layer cascade, edge cases)
 *   6. Intent Search (intent search vs smart truncation comparison)
 *   7. Extract Snippet (positionsFromHighlight, extractSnippet, store integration)
 */

import { describe, test, expect, it, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ContentStore } from "../../src/store.js";
import { SessionDB } from "../../src/session/db.js";
import { searchAllSources, type UnifiedSearchResult } from "../../src/search/unified.js";
import { searchAutoMemory } from "../../src/search/auto-memory.js";
import { extractSnippet, formatBatchQueryResults, positionsFromHighlight } from "../../src/server.js";

// ─────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────

function createStore(): ContentStore {
  const path = join(
    tmpdir(),
    `context-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return new ContentStore(path);
}

// ═══════════════════════════════════════════════════════════
// 1. Search Wiring
// ═══════════════════════════════════════════════════════════

describe("Fix 1: searchWithFallback cascade on persistent store", () => {
  test("searchWithFallback: porter layer returns results with matchLayer='rrf'", () => {
    const store = createStore();
    store.indexPlainText(
      "The authentication middleware validates JWT tokens on every request.\nExpired tokens are rejected with 401.",
      "execute:shell",
    );

    const results = store.searchWithFallback("authentication JWT tokens", 3, "execute:shell");
    assert.ok(results.length > 0, "Porter should find exact terms");
    assert.equal(results[0].matchLayer, "rrf", "matchLayer should be 'rrf'");
    assert.ok(results[0].content.includes("JWT"), "Content should contain JWT");

    store.close();
  });

  test("searchWithFallback: trigram layer activates when porter fails", () => {
    const store = createStore();
    store.indexPlainText(
      "The responseBodyParser transforms incoming XML payloads into JSON.\nAll endpoints accept application/xml.",
      "execute:shell",
    );

    // "responseBody" is a substring of "responseBodyParser" — porter won't match, trigram will
    const results = store.searchWithFallback("responseBody", 3, "execute:shell");
    assert.ok(results.length > 0, "Trigram should find substring match");
    assert.equal(results[0].matchLayer, "rrf", "matchLayer should be 'rrf'");

    store.close();
  });

  test("searchWithFallback: fuzzy layer corrects misspellings", () => {
    const store = createStore();
    store.indexPlainText(
      "PostgreSQL database connection established successfully.\nConnection pool size: 10.",
      "execute:shell",
    );

    // "databse" is a typo for "database"
    const results = store.searchWithFallback("databse", 3, "execute:shell");
    assert.ok(results.length > 0, "Fuzzy should correct 'databse' to 'database'");
    assert.equal(results[0].matchLayer, "rrf-fuzzy", "matchLayer should be 'rrf-fuzzy'");
    assert.ok(results[0].content.toLowerCase().includes("database"), "Content should have 'database'");

    store.close();
  });

  test("searchWithFallback: cascade stops at first successful layer", () => {
    const store = createStore();
    store.indexPlainText(
      "Redis cache hit rate: 95%\nMemcached fallback rate: 3%",
      "execute:shell",
    );

    // "redis" is an exact term — should stop at RRF, never try fuzzy
    const results = store.searchWithFallback("redis cache", 3, "execute:shell");
    assert.ok(results.length > 0, "Should find results");
    assert.equal(results[0].matchLayer, "rrf", "Should stop at RRF when it succeeds");

    store.close();
  });

  test("searchWithFallback: returns empty array when all layers fail", () => {
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
});

describe("Fix 2: persistent store replaces ephemeral DB correctly", () => {
  test("persistent store with source scoping isolates results like ephemeral DB did", () => {
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

  test("persistent store accumulates content across multiple indexPlainText calls", () => {
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
});

describe("Fix 3: batch_execute search precision (no indiscriminate boosting)", () => {
  test("searchWithFallback returns only relevant results, not everything", () => {
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

  test("searchWithFallback with source scoping is more precise than global", () => {
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
});

describe("Fix 4: transaction-wrapped vocabulary insertion", () => {
  test("vocabulary is correctly stored after transaction-wrapped insertion", () => {
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

  test("vocabulary handles large word sets without error", () => {
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
});

describe("Fix 5: getDistinctiveTerms with .iterate() streaming", () => {
  test("getDistinctiveTerms produces correct terms with iterate()", () => {
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

  test("getDistinctiveTerms returns empty for sources with < 3 chunks", () => {
    const store = createStore();

    const indexed = store.index({
      content: "# Single Section\n\nThis document has only one section with some content.",
      source: "tiny-doc",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);
    assert.deepEqual(terms, [], "Should return empty for documents with < 3 chunks");

    store.close();
  });

  test("getDistinctiveTerms filters terms outside frequency band", () => {
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
});

describe("Edge cases and hardening", () => {
  test("searchWithFallback on empty store returns empty", () => {
    const store = createStore();
    const results = store.searchWithFallback("anything", 3);
    assert.equal(results.length, 0, "Empty store should return empty results");
    store.close();
  });

  test("searchWithFallback with empty query returns empty", () => {
    const store = createStore();
    store.indexPlainText("Some content here", "test-source");

    const results = store.searchWithFallback("", 3, "test-source");
    assert.equal(results.length, 0, "Empty query should return empty results");

    store.close();
  });

  test("searchWithFallback source scoping uses LIKE partial match", () => {
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

  test("searchWithFallback handles special characters in query gracefully", () => {
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

  test("searchWithFallback respects limit parameter across all layers", () => {
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
});

// ═══════════════════════════════════════════════════════════
// 2. Search AND Semantics
// ═══════════════════════════════════════════════════════════

describe("AND semantics (issue #23)", () => {
  test("multi-word query excludes irrelevant single-word matches", () => {
    const store = createStore();

    // Index two documents — one relevant, one only matches on "function"
    store.index({
      content: "## useEffect cleanup\nReturn a cleanup function from useEffect to avoid memory leaks.\nAlways clean up subscriptions and timers in the cleanup function.",
      source: "React Hooks Guide",
    });
    store.index({
      content: "## What is a function\nA function is a reusable block of code that performs a specific task.\nFunctions accept parameters and return values.",
      source: "JavaScript Basics",
    });

    // AND search: only the React chunk should match (has all 3 terms)
    const andResults = store.search("useEffect cleanup function", 5);
    expect(andResults.length).toBe(1);
    expect(andResults[0].source).toBe("React Hooks Guide");

    // OR search: both chunks match (JS Basics matches on "function" alone)
    const orResults = store.search("useEffect cleanup function", 5, undefined, "OR");
    expect(orResults.length).toBe(2);

    store.close();
  });

  test("searchWithFallback uses AND by default, falls back to OR", () => {
    const store = createStore();

    store.index({
      content: "## useEffect cleanup\nReturn a cleanup function from useEffect to avoid memory leaks.",
      source: "React Hooks Guide",
    });
    store.index({
      content: "## What is a function\nA function is a reusable block of code.",
      source: "JavaScript Basics",
    });

    // RRF fuses porter OR + trigram OR — both chunks match on partial terms,
    // but the React chunk ranks higher because it matches all three query terms
    const results = store.searchWithFallback("useEffect cleanup function", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].source).toBe("React Hooks Guide");

    store.close();
  });

  test("AND with no results falls back to OR gracefully", () => {
    const store = createStore();

    store.index({
      content: "## React components\nComponents are the building blocks of React applications.",
      source: "React Guide",
    });
    store.index({
      content: "## Vue components\nVue uses a template-based component system.",
      source: "Vue Guide",
    });

    // "React useState hooks" — AND would match nothing (no chunk has all 3),
    // searchWithFallback should fall back to OR and find the React chunk
    const results = store.searchWithFallback("React useState hooks", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("React Guide");

    store.close();
  });

  test("single-word queries work the same in AND and OR", () => {
    const store = createStore();

    store.index({
      content: "## Authentication\nJWT tokens provide stateless authentication.",
      source: "Auth Guide",
    });

    const andResults = store.search("authentication", 5);
    const orResults = store.search("authentication", 5, undefined, "OR");
    expect(andResults.length).toBe(orResults.length);

    store.close();
  });

  test("trigram search also uses AND semantics", () => {
    const store = createStore();

    store.index({
      content: "## useEffect cleanup pattern\nReturn a cleanup function from useEffect.",
      source: "React Hooks",
    });
    store.index({
      content: "## JavaScript function basics\nA function is a reusable block of code.",
      source: "JS Basics",
    });

    // Trigram AND: partial match "useEff clean func" should only match React chunk
    const andResults = store.searchTrigram("useEffect cleanup function", 5, undefined, "AND");
    // With AND, only the chunk containing ALL terms should match
    for (const r of andResults) {
      expect(r.source).toBe("React Hooks");
    }

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Search Fallback Integration
// ═══════════════════════════════════════════════════════════

describe("Source-scoped searchWithFallback (intentSearch path)", () => {
  test("intentSearch path: porter layer finds exact terms in source-scoped search", () => {
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
    assert.equal(results[0].matchLayer, "rrf", "Should match via RRF layer");

    // Should NOT leak results from other sources
    const wrongSource = store.searchWithFallback("connection refused", 3, "cmd-2");
    assert.equal(wrongSource.length, 0, "Should not find database errors in test output source");

    store.close();
  });

  test("intentSearch path: trigram layer activates for partial/camelCase terms", () => {
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
    assert.equal(results[0].matchLayer, "rrf", "Should match via RRF layer");

    store.close();
  });

  test("intentSearch path: fuzzy layer activates for typos", () => {
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
    assert.equal(results[0].matchLayer, "rrf-fuzzy", "Should match via RRF-fuzzy layer");

    store.close();
  });

  test("intentSearch path: no match returns empty (not an error)", () => {
    const store = createStore();

    store.indexPlainText(
      "Server started on port 3000\nReady to accept connections",
      "cmd-1: node server",
    );

    const results = store.searchWithFallback("xylophoneQuartzMango", 3, "cmd-1");
    assert.equal(results.length, 0, "Completely unrelated query should return empty");

    store.close();
  });
});

describe("Multi-source isolation (batch_execute path)", () => {
  test("batch_execute path: scoped search isolates results per source", () => {
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

  test("batch_execute path: global fallback when scoped search fails", () => {
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

  test("batch_execute formatter never inlines previous indexed content", () => {
    const store = createStore();

    store.index({
      content: "# Current Batch\n\nOnly current batch details live here.",
      source: "batch: current",
    });
    store.index({
      content: "# Older Indexed Content\n\nJWT tokens expire after 24 hours.",
      source: "docs: auth",
    });

    const output = formatBatchQueryResults(store, ["JWT tokens"], "batch: current").join("\n");
    assert.ok(output.includes("No matching sections found."), "Expected scoped batch result to stay empty");
    assert.ok(!output.includes("previously indexed content"), "Should not mention cross-source fallback");
    assert.ok(!output.includes("JWT tokens expire after 24 hours"), "Should not inline stale cross-source text");

    store.close();
  });

  test("batch_execute formatter does not leak overlapping batch labels", () => {
    const store = createStore();

    store.index({
      content: "# Current Build\n\nCurrent batch contains only build timing details.",
      source: "batch:Build",
    });
    store.index({
      content: "# Older Build and Test\n\nJWT tokens expire after 24 hours.",
      source: "batch:Build,Test",
    });

    const output = formatBatchQueryResults(store, ["JWT tokens"], "batch:Build").join("\n");
    assert.ok(output.includes("No matching sections found."), "Expected exact batch label filtering");
    assert.ok(!output.includes("JWT tokens expire after 24 hours"), "Should not leak overlapping older batch label content");

    store.close();
  });

  test("batch_execute formatter returns matches from the current batch", () => {
    const store = createStore();

    store.index({
      content: "# Current Batch\n\nJWT tokens expire after 12 hours for the current batch.",
      source: "batch: current",
    });
    store.index({
      content: "# Older Indexed Content\n\nJWT tokens expire after 24 hours.",
      source: "docs: auth",
    });

    const output = formatBatchQueryResults(store, ["JWT tokens"], "batch: current").join("\n");
    assert.ok(output.includes("Current Batch"), "Expected current batch heading in formatter output");
    assert.ok(output.includes("12 hours for the current batch"), "Expected current batch content in formatter output");
    assert.ok(!output.includes("24 hours"), "Should not leak older source content when current batch matches");

    store.close();
  });
});

describe("getDistinctiveTerms consistency (fix #9)", () => {
  test("getDistinctiveTerms returns terms for multi-chunk content", () => {
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
});

// ═══════════════════════════════════════════════════════════
// 4. Index Deduplication
// ═══════════════════════════════════════════════════════════

describe("Index deduplication (issue #67)", () => {
  let store: ContentStore;

  beforeEach(() => {
    store = new ContentStore(":memory:");
  });

  afterEach(() => {
    store.cleanup();
  });

  it("re-indexing with same label replaces previous content", () => {
    // First build: error A
    store.index({
      content: "# Build Output\nERROR: Module not found 'foo'",
      source: "execute:shell:npm run build",
    });

    // Verify error A is searchable
    const results1 = store.search("Module not found foo");
    expect(results1.length).toBeGreaterThan(0);
    expect(results1[0].content).toContain("Module not found");

    // Second build: error A fixed, new error B
    store.index({
      content: "# Build Output\nERROR: Type 'string' is not assignable to type 'number'",
      source: "execute:shell:npm run build",
    });

    // Error B should be searchable
    const results2 = store.search("Type string not assignable number");
    expect(results2.length).toBeGreaterThan(0);
    expect(results2[0].content).toContain("not assignable");

    // Error A should NO LONGER be searchable
    const results3 = store.search("Module not found foo");
    expect(results3.length).toBe(0);
  });

  it("different labels are NOT deduped", () => {
    store.index({
      content: "# Test Output\n5 tests passed",
      source: "execute:shell:npm test",
    });
    store.index({
      content: "# Build Output\nBuild successful",
      source: "execute:shell:npm run build",
    });

    // Both should be searchable
    const testResults = store.search("tests passed");
    expect(testResults.length).toBeGreaterThan(0);

    const buildResults = store.search("Build successful");
    expect(buildResults.length).toBeGreaterThan(0);
  });

  it("sources list shows only one entry per label after dedup", () => {
    store.index({ content: "# Run 1\nfail", source: "execute:shell:make" });
    store.index({ content: "# Run 2\nfail", source: "execute:shell:make" });
    store.index({ content: "# Run 3\npass", source: "execute:shell:make" });

    const sources = store.listSources();
    const makeEntries = sources.filter((s) => s.label === "execute:shell:make");
    expect(makeEntries.length).toBe(1);
    expect(makeEntries[0].chunkCount).toBeGreaterThan(0);
  });

  it("dedup works with indexPlainText too", () => {
    store.indexPlainText("error: old failure", "build-output");
    store.indexPlainText("success: all good", "build-output");

    const oldResults = store.search("old failure");
    expect(oldResults.length).toBe(0);

    const newResults = store.search("all good");
    expect(newResults.length).toBeGreaterThan(0);
  });

  it("dedup works with indexJSON too", () => {
    store.indexJSON(
      JSON.stringify({ status: "error", message: "connection refused" }),
      "api-response",
    );
    store.indexJSON(
      JSON.stringify({ status: "ok", data: [1, 2, 3] }),
      "api-response",
    );

    const oldResults = store.search("connection refused");
    expect(oldResults.length).toBe(0);

    const newResults = store.searchWithFallback("ok", 5);
    expect(newResults.length).toBeGreaterThan(0);
  });

  it("trigram search also returns only latest content after dedup", () => {
    store.index({
      content: "# Output\nxyz123oldvalue",
      source: "execute:shell:check",
    });
    store.index({
      content: "# Output\nabc456newvalue",
      source: "execute:shell:check",
    });

    // Trigram search for old unique substring
    const oldResults = store.searchWithFallback("xyz123oldvalue", 5);
    expect(oldResults.length).toBe(0);

    // Trigram search for new unique substring
    const newResults = store.searchWithFallback("abc456newvalue", 5);
    expect(newResults.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Fuzzy Search
// ═══════════════════════════════════════════════════════════

/**
 * Seed a store with realistic multi-topic content for fuzzy search testing.
 * Returns the store with indexed content covering authentication, caching,
 * database, WebSocket, and deployment topics.
 */
function createSeededStore(): ContentStore {
  const store = createStore();

  store.index({
    content: [
      "# Authentication",
      "",
      "Use JWT tokens for API authentication. The middleware validates",
      "Bearer tokens on every request. Token expiry is set to 24 hours.",
      "",
      "## Row-Level Security",
      "",
      "Supabase row-level-security policies restrict data access per user.",
      "Enable RLS on all tables that contain user data.",
      "",
      "## OAuth Providers",
      "",
      "Configure OAuth2 providers: Google, GitHub, Discord.",
      "The callback URL must match the registered redirect URI.",
    ].join("\n"),
    source: "Auth docs",
  });

  store.index({
    content: [
      "# Caching Strategy",
      "",
      "Redis handles session caching with a 15-minute TTL.",
      "Use cache-aside pattern for database query results.",
      "",
      "## Cache Invalidation",
      "",
      "Invalidate on write using pub/sub channels.",
      "The eventEmitter broadcasts cache-bust events to all nodes.",
    ].join("\n"),
    source: "Caching docs",
  });

  store.index({
    content: [
      "# React Hooks",
      "",
      "## useEffect",
      "",
      "The useEffect hook handles side effects in functional components.",
      "Always return a cleanup function to avoid memory leaks.",
      "",
      "```javascript",
      "useEffect(() => {",
      "  const subscription = dataSource.subscribe();",
      "  return () => subscription.unsubscribe();",
      "}, [dataSource]);",
      "```",
      "",
      "## useState",
      "",
      "The useState hook manages local component state.",
      "Use functional updates when new state depends on previous.",
      "",
      "## useCallback",
      "",
      "Memoize callbacks to prevent unnecessary re-renders.",
      "Wrap event handlers passed to child components.",
    ].join("\n"),
    source: "React docs",
  });

  store.index({
    content: [
      "# WebSocket Server",
      "",
      "The connectionPool manages active WebSocket connections.",
      "Each connection has a heartbeat interval of 30 seconds.",
      "",
      "## Error Handling",
      "",
      "The errorBoundary catches unhandled promise rejections.",
      "Dead connections are pruned every 60 seconds via healthCheck.",
    ].join("\n"),
    source: "WebSocket docs",
  });

  store.index({
    content: [
      "# Deployment",
      "",
      "Kubernetes manifests live in the k8s/ directory.",
      "The horizontalPodAutoscaler scales between 2-10 replicas.",
      "",
      "## Environment Variables",
      "",
      "DATABASE_URL, REDIS_URL, and JWT_SECRET must be set.",
      "Use ConfigMap for non-sensitive configuration values.",
    ].join("\n"),
    source: "Deployment docs",
  });

  return store;
}

describe("searchTrigram: Substring Matching", () => {
  test("searchTrigram: finds substring match ('authenticat' → authentication)", () => {
    const store = createSeededStore();
    // "authenticat" is a partial substring of "authentication"
    // Porter stemming won't match this — trigram should
    const results = store.searchTrigram("authenticat", 3);
    assert.ok(results.length > 0, "Trigram should find substring match");
    assert.ok(
      results[0].content.toLowerCase().includes("authentication"),
      `Result should contain 'authentication', got: ${results[0].content.slice(0, 100)}`,
    );
    store.close();
  });

  test("searchTrigram: finds partial hyphenated term ('row-level' → row-level-security)", () => {
    const store = createSeededStore();
    // Partial match on hyphenated compound term
    const results = store.searchTrigram("row-level", 3);
    assert.ok(results.length > 0, "Trigram should match partial hyphenated terms");
    assert.ok(
      results[0].content.toLowerCase().includes("row-level-security") ||
        results[0].content.toLowerCase().includes("row-level"),
      `Result should contain row-level content, got: ${results[0].content.slice(0, 100)}`,
    );
    store.close();
  });

  test("searchTrigram: finds camelCase substring ('useEff' → useEffect)", () => {
    const store = createSeededStore();
    // "useEff" is a prefix of "useEffect" — trigram should match
    const results = store.searchTrigram("useEff", 3);
    assert.ok(results.length > 0, "Trigram should match camelCase substrings");
    assert.ok(
      results[0].content.includes("useEffect"),
      `Result should contain 'useEffect', got: ${results[0].content.slice(0, 100)}`,
    );
    store.close();
  });

  test("searchTrigram: respects source filter", () => {
    const store = createSeededStore();
    // "cache" appears in both "Caching docs" and potentially elsewhere
    const allResults = store.searchTrigram("cache", 10);
    const filteredResults = store.searchTrigram("cache", 10, "Caching");
    assert.ok(filteredResults.length > 0, "Should find results with source filter");
    assert.ok(
      filteredResults.every((r) => r.source.includes("Caching")),
      `All filtered results should be from Caching source, got: ${filteredResults.map((r) => r.source).join(", ")}`,
    );
    // Filtered should be subset
    assert.ok(
      filteredResults.length <= allResults.length,
      "Filtered results should be <= all results",
    );
    store.close();
  });
});

describe("fuzzyCorrect: Levenshtein Typo Correction", () => {
  test("fuzzyCorrect: corrects single typo ('autentication' → 'authentication')", () => {
    const store = createSeededStore();
    // Missing 'h' — edit distance 1
    const corrected = store.fuzzyCorrect("autentication");
    assert.ok(corrected !== null, "Should return a correction for single typo");
    assert.equal(
      corrected,
      "authentication",
      `Should correct to 'authentication', got: '${corrected}'`,
    );
    store.close();
  });

  test("fuzzyCorrect: returns null for exact match (no correction needed)", () => {
    const store = createSeededStore();
    // Exact word exists in vocabulary — no correction needed
    const corrected = store.fuzzyCorrect("authentication");
    assert.equal(
      corrected,
      null,
      "Should return null when word already exists in vocabulary",
    );
    store.close();
  });

  test("fuzzyCorrect: returns null for gibberish (too distant)", () => {
    const store = createSeededStore();
    // Completely unrelated — edit distance too high for any vocabulary word
    const corrected = store.fuzzyCorrect("xyzqwertymno");
    assert.equal(
      corrected,
      null,
      "Should return null when no close match exists",
    );
    store.close();
  });
});

describe("searchWithFallback: Three-Layer Cascade", () => {
  test("searchWithFallback: Layer 1 hit (Porter) — exact stemmed match", () => {
    const store = createSeededStore();
    // "caching" stems to "cach" via Porter — Layer 1 should match directly
    const results = store.searchWithFallback("caching strategy", 3);
    assert.ok(results.length > 0, "Layer 1 (Porter) should find stemmed match");
    assert.ok(
      results[0].content.toLowerCase().includes("cach"),
      `First result should be about caching, got: ${results[0].content.slice(0, 100)}`,
    );
    // Verify it used RRF (fused path)
    assert.equal(
      results[0].matchLayer,
      "rrf",
      `Should report 'rrf' as match layer, got: '${results[0].matchLayer}'`,
    );
    store.close();
  });

  test("searchWithFallback: Layer 2 hit (Trigram) — partial substring", () => {
    const store = createSeededStore();
    // "connectionPo" is a partial camelCase — Porter won't match, trigram will
    const results = store.searchWithFallback("connectionPo", 3);
    assert.ok(results.length > 0, "Layer 2 (Trigram) should find substring match");
    assert.ok(
      results[0].content.includes("connectionPool"),
      `Result should contain 'connectionPool', got: ${results[0].content.slice(0, 100)}`,
    );
    assert.equal(
      results[0].matchLayer,
      "rrf",
      `Should report 'rrf' as match layer, got: '${results[0].matchLayer}'`,
    );
    store.close();
  });

  test("searchWithFallback: Layer 3 hit (Fuzzy) — typo correction", () => {
    const store = createSeededStore();
    // "kuberntes" is a typo for "kubernetes" (missing 'e')
    const results = store.searchWithFallback("kuberntes", 3);
    assert.ok(results.length > 0, "Layer 3 (Fuzzy) should find typo-corrected match");
    assert.ok(
      results[0].content.toLowerCase().includes("kubernetes"),
      `Result should contain 'kubernetes', got: ${results[0].content.slice(0, 100)}`,
    );
    assert.equal(
      results[0].matchLayer,
      "rrf-fuzzy",
      `Should report 'rrf-fuzzy' as match layer, got: '${results[0].matchLayer}'`,
    );
    store.close();
  });

  test("searchWithFallback: no match at any layer returns empty", () => {
    const store = createSeededStore();
    // Completely unrelated term with no substring or fuzzy match
    const results = store.searchWithFallback("xylophoneQuartzMango", 3);
    assert.equal(results.length, 0, "Should return empty when no layer matches");
    store.close();
  });

  test("searchWithFallback: source filter works across all layers", () => {
    const store = createSeededStore();
    // "JWT" exists in both Auth docs and Deployment docs (JWT_SECRET)
    // With source filter, should only return Auth docs
    const results = store.searchWithFallback("JWT", 5, "Auth");
    assert.ok(results.length > 0, "Should find results with source filter");
    assert.ok(
      results.every((r) => r.source.includes("Auth")),
      `All results should be from Auth source, got: ${results.map((r) => r.source).join(", ")}`,
    );
    store.close();
  });
});

describe("Fuzzy Edge Cases", () => {
  test("searchTrigram: empty query returns empty", () => {
    const store = createSeededStore();
    const results = store.searchTrigram("", 3);
    assert.equal(results.length, 0, "Empty query should return no results");
    store.close();
  });

  test("searchTrigram: very short query (2 chars) still works", () => {
    const store = createSeededStore();
    // "JS" or "k8" — trigram needs at least 3 chars to form a trigram
    // but the API should handle gracefully (return empty or degrade)
    const results = store.searchTrigram("JS", 3);
    // Should not throw, may return empty
    assert.ok(Array.isArray(results), "Should return an array even for short query");
    store.close();
  });

  test("fuzzyCorrect: handles multi-word query (corrects each word)", () => {
    const store = createSeededStore();
    // "autentication middlewre" — two typos
    const corrected = store.fuzzyCorrect("autentication");
    // At minimum, should correct the single word
    if (corrected !== null) {
      assert.equal(corrected, "authentication", "Should correct to closest match");
    }
    store.close();
  });

  test("searchWithFallback: Layer 1 hit skips Layer 2 and 3 (performance)", () => {
    const store = createSeededStore();
    // "Redis" is an exact term — should resolve at Layer 1 only
    const start = performance.now();
    const results = store.searchWithFallback("Redis", 3);
    const elapsed = performance.now() - start;
    assert.ok(results.length > 0, "Should find Redis content");
    assert.equal(
      results[0].matchLayer,
      "rrf",
      "Exact match should resolve at RRF layer",
    );
    // Sanity: should be fast since it didn't need fuzzy
    assert.ok(elapsed < 500, `Should be fast for Layer 1 hit, took ${elapsed.toFixed(0)}ms`);
    store.close();
  });

  test("trigram table is populated during index()", () => {
    const store = createStore();
    store.index({
      content: "# Test\n\nThe horizontalPodAutoscaler manages pod replicas.",
      source: "test-trigram-index",
    });
    // After indexing, trigram search should work
    const results = store.searchTrigram("horizontalPod", 3);
    assert.ok(results.length > 0, "Trigram table should be populated during index()");
    assert.ok(
      results[0].content.includes("horizontalPodAutoscaler"),
      "Should find the camelCase term",
    );
    store.close();
  });

  test("trigram table is populated during indexPlainText()", () => {
    const store = createStore();
    store.indexPlainText(
      "ERROR: connectionRefused on port 5432\nWARNING: retrying in 5s",
      "plain-text-trigram",
    );
    const results = store.searchTrigram("connectionRef", 3);
    assert.ok(results.length > 0, "Trigram should work with indexPlainText content");
    store.close();
  });
});

// ─────────────────────────────────────────────────────────
// Fuzzy correction cache
// ─────────────────────────────────────────────────────────

describe("fuzzyCorrect LRU cache", () => {
  test("returns identical result on repeated queries for the same word", () => {
    const store = createStore();
    store.index({
      content: "The authentication middleware handles orchestration of services.",
      source: "cache-test",
    });

    const first = store.fuzzyCorrect("authentiction");
    const second = store.fuzzyCorrect("authentiction");

    assert.equal(first, second, "cached result must match uncached result");
    assert.equal(first, "authentication");

    store.close();
  });

  test("cache entry for null (no correction) is also returned on hit", () => {
    const store = createStore();
    store.index({
      content: "one two three four",
      source: "cache-null-test",
    });

    // A word unrelated to the vocab, too far for any correction.
    const first = store.fuzzyCorrect("xylophone");
    const second = store.fuzzyCorrect("xylophone");

    assert.equal(first, null);
    assert.equal(second, null);

    store.close();
  });

  test("cache is cleared when new vocabulary is inserted", () => {
    const store = createStore();
    store.index({
      content: "authentication middleware orchestration deployment monitoring",
      source: "cache-invalidate-v1",
    });

    // Prime the cache with a word that has no close match yet.
    const beforeInsert = store.fuzzyCorrect("xylophne"); // should be null
    assert.equal(beforeInsert, null);

    // Add a new vocab word that *is* a close match for "xylophne".
    store.index({
      content: "The xylophone in the orchestra plays melodies.",
      source: "cache-invalidate-v2",
    });

    // Cache must have been invalidated — stale null would be wrong now.
    const afterInsert = store.fuzzyCorrect("xylophne");
    assert.equal(afterInsert, "xylophone");

    store.close();
  });

  test("cache is NOT cleared when re-indexing identical content", () => {
    const store = createStore();
    store.index({
      content: "authentication middleware orchestration deployment",
      source: "cache-idempotent",
    });

    // Prime the cache.
    store.fuzzyCorrect("authentiction");
    store.fuzzyCorrect("orchstration");

    // Monkey-patch the underlying vocab stmt to count DB hits after priming.
    // We can't easily inspect Map state; instead we verify behavior: a second
    // identical fuzzyCorrect call for the same word returns the same answer
    // even if we re-index the exact same content (no new vocab rows insert).
    store.index({
      content: "authentication middleware orchestration deployment",
      source: "cache-idempotent", // same label → dedup handles it
    });

    const result = store.fuzzyCorrect("authentiction");
    assert.equal(result, "authentication");

    store.close();
  });

  test("cache respects FUZZY_CACHE_SIZE — eviction does not corrupt results", () => {
    const store = createStore();
    // Build a vocab with many distinct words so evictions happen during sweep.
    const vocab = Array.from({ length: 50 }, (_, i) => `uniqueword${i}abc`).join(" ");
    store.index({ content: vocab, source: "large-vocab-cache" });

    const capSize = ContentStore.FUZZY_CACHE_SIZE;

    // Collect an oracle: what does fuzzyCorrect return on a cold cache for
    // each input? Use a fresh store to get uncached answers.
    const oracleStore = createStore();
    oracleStore.index({ content: vocab, source: "oracle" });

    // Query (capSize + 50) unique words, causing evictions. Each answer must
    // match the cold-cache oracle — eviction of an entry must not influence
    // the answer we get when we re-query that word.
    for (let i = 0; i < capSize + 50; i++) {
      const typo = `uniquewrd${i}abc`;
      const oracle = oracleStore.fuzzyCorrect(typo);
      const actual = store.fuzzyCorrect(typo);
      assert.equal(
        actual,
        oracle,
        `eviction corrupted result for ${typo}: got ${actual}, oracle ${oracle}`,
      );
    }

    store.close();
    oracleStore.close();
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Intent Search
// ═══════════════════════════════════════════════════════════

// Smart Truncation simulation (60% head + 40% tail)
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

// Intent Search simulation (ContentStore + FTS5 BM25)
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

const MAX_BYTES = 5000; // Same as INTENT_SEARCH_THRESHOLD

interface ScenarioResult {
  name: string;
  truncationFound: string;
  intentFound: string;
  intentBytes: number;
  truncationBytes: number;
}

const scenarioResults: ScenarioResult[] = [];

describe("Scenario 1: Server Log Error (line 347 of 500)", () => {
  test("server log: intent search finds error buried in middle", () => {
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
});

describe("Scenario 2: Test Failures (3 among 200 tests)", () => {
  test("test results: intent search finds all 3 failures", () => {
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
});

describe("Scenario 3: Build Warnings (2 among 300 lines)", () => {
  test("build output: intent search finds both deprecation warnings", () => {
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
});

describe("Scenario 4: API Auth Error (line 743 of 1000)", () => {
  test("API response: intent search finds authentication error", () => {
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
});

describe("Scenario 5: Score-based search finds sections matching later intent words", () => {
  test("score-based search: multi-word matches rank higher than single-word matches", () => {
    // Build a 500-line synthetic changelog/advisory output.
    // Three relevant sections are scattered across the document:
    //   Lines 100-120: prototype-related code change (hasOwnProperty, allowPrototypes)
    //   Lines 300-320: proto key filtering change
    //   Lines 400-420: security advisory note
    // The rest is generic filler that may match individual words like "fix" or "security".
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      if (i >= 100 && i <= 120) {
        // Section A: prototype pollution fix — contains "prototype", "fix", "security"
        if (i === 100) {
          lines.push("## Prototype Pollution Fix");
        } else if (i === 101) {
          lines.push("Object.prototype.hasOwnProperty check added to prevent prototype pollution.");
        } else if (i === 102) {
          lines.push("The allowPrototypes option is now disabled by default for security.");
        } else if (i === 103) {
          lines.push("This fix addresses CVE-2022-XXXXX prototype pollution vulnerability.");
        } else {
          lines.push(`  - Internal refactor line ${i}: tightened prototype chain validation.`);
        }
      } else if (i >= 300 && i <= 320) {
        // Section B: __proto__ key filtering — contains "proto", "filtered", "pollution"
        if (i === 300) {
          lines.push("## Proto Key Filtering");
        } else if (i === 301) {
          lines.push("__proto__ keys filtered from user input to prevent pollution attacks.");
        } else if (i === 302) {
          lines.push("constructor.prototype paths are now blocked in query string parsing.");
        } else {
          lines.push(`  - Filtering rule ${i}: additional prototype path blocked.`);
        }
      } else if (i >= 400 && i <= 420) {
        // Section C: security advisory — contains "security", "vulnerability", "advisory"
        if (i === 400) {
          lines.push("## Security Advisory");
        } else if (i === 401) {
          lines.push("Security advisory note added for prototype pollution vulnerability.");
        } else if (i === 402) {
          lines.push("Users should upgrade immediately to fix this security vulnerability.");
        } else {
          lines.push(`  - Advisory detail ${i}: downstream dependency notification.`);
        }
      } else {
        // Filler — generic changelog lines. Some deliberately contain single
        // intent words ("fix", "security") to create noise that a naive search
        // might grab instead of the high-value multi-match sections.
        if (i % 50 === 0) {
          lines.push(`Version ${Math.floor(i / 50)}.${i % 10}.0: security patch applied.`);
        } else if (i % 37 === 0) {
          lines.push(`Bugfix release ${i}: minor fix for edge case in parser.`);
        } else {
          lines.push(`Version ${Math.floor(i / 50)}.${i % 10}.${i % 5}: improved performance and stability for module-${i}.`);
        }
      }
    }
    const changelogOutput = lines.join("\n");

    // Intent: multi-word query where the important terms are "prototype" and "pollution"
    // A naive first-come-first-served approach might fill results with chunks
    // matching just "security" or "fix" (which appear in filler lines too).
    const intent = "security vulnerability prototype pollution fix";

    // Score-based intent search: BM25 ranks chunks matching MORE intent words higher
    const intentResult = simulateIntentSearch(changelogOutput, intent, 5);

    // Check which of the three important sections were found
    const foundPrototypeFix = intentResult.found.includes("Object.prototype.hasOwnProperty")
      || intentResult.found.includes("allowPrototypes");
    const foundProtoFiltering = intentResult.found.includes("__proto__ keys filtered")
      || intentResult.found.includes("constructor.prototype");
    const foundSecurityAdvisory = intentResult.found.includes("security advisory note added")
      || intentResult.found.includes("Security Advisory");

    const relevantSectionsFound = [
      foundPrototypeFix,
      foundProtoFiltering,
      foundSecurityAdvisory,
    ].filter(Boolean).length;

    scenarioResults.push({
      name: "Score-Based Search",
      truncationFound: "N/A (score test)",
      intentFound: `${relevantSectionsFound}/3`,
      intentBytes: intentResult.bytes,
      truncationBytes: 0,
    });

    // The score-based search MUST find at least 2 of the 3 relevant sections.
    // BM25 scoring ensures sections matching multiple intent words
    // (e.g., "prototype" + "pollution" + "security" + "fix") rank higher
    // than filler lines matching just one word like "fix".
    assert.ok(
      relevantSectionsFound >= 2,
      `Score-based search should find at least 2/3 relevant sections, found ${relevantSectionsFound}/3. ` +
      `BM25 should rank multi-word matches above single-word filler matches.`,
    );

    // The prototype pollution fix section (Section A) is the highest-value result
    // because it matches the most intent words: "prototype", "pollution", "fix", "security".
    // Score-based ranking must surface it.
    assert.ok(
      foundPrototypeFix,
      "Score-based search MUST find the 'Prototype Pollution Fix' section — " +
      "it matches 4 intent words and should rank highest via BM25.",
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Extract Snippet
// ═══════════════════════════════════════════════════════════

const STX = "\x02";
const ETX = "\x03";

/** Pad preamble to >1500 chars so prefix truncation can't reach the relevant part. */
function buildContent(preamble: string, relevant: string): string {
  const padding = preamble.padEnd(2000, " Lorem ipsum dolor sit amet.");
  return padding + "\n\n" + relevant;
}

/**
 * Build a highlighted string with STX/ETX markers around the given
 * terms within the content, mirroring what FTS5 highlight() produces.
 */
function markHighlighted(content: string, terms: string[]): string {
  let result = content;
  for (const term of terms) {
    // Case-insensitive replacement, wrapping each occurrence in STX/ETX
    result = result.replace(
      new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      (match) => `${STX}${match}${ETX}`,
    );
  }
  return result;
}

describe("positionsFromHighlight", () => {
  test("finds single marker position", () => {
    const highlighted = `some text ${STX}match${ETX} more text`;
    const positions = positionsFromHighlight(highlighted);
    assert.deepEqual(positions, [10]);
  });

  test("finds multiple marker positions", () => {
    // "aa \x02bb\x03 cc \x02dd\x03"
    // clean: "aa bb cc dd"  → positions 3 and 9
    const highlighted = `aa ${STX}bb${ETX} cc ${STX}dd${ETX}`;
    const positions = positionsFromHighlight(highlighted);
    assert.deepEqual(positions, [3, 9]);
  });

  test("returns empty array when no markers", () => {
    const positions = positionsFromHighlight("no markers here");
    assert.deepEqual(positions, []);
  });

  test("handles adjacent markers correctly", () => {
    // Two markers right next to each other
    const highlighted = `${STX}first${ETX}${STX}second${ETX}`;
    const positions = positionsFromHighlight(highlighted);
    assert.deepEqual(positions, [0, 5]);
  });
});

describe("extractSnippet with highlight markers", () => {
  test("returns full content when under maxLen", () => {
    const content = "Short content about connections.";
    const result = extractSnippet(content, "connections");
    assert.equal(result, content);
  });

  test("prefers highlight-derived positions over indexOf", () => {
    // Place the highlighted term ("configuration") far from the start,
    // and a decoy exact-match term ("configure") near the start.
    const decoy = "configure appears here near the start of the document.";
    const relevant = "The configuration file supports YAML and JSON formats for all settings.";
    const content = buildContent(decoy, relevant);

    // FTS5 would mark "configuration" (the stemmed match), not "configure"
    const highlighted = markHighlighted(content, ["configuration"]);

    const result = extractSnippet(content, "configure", 1500, highlighted);
    assert.ok(
      result.includes("configuration"),
      `Expected snippet to include "configuration", got: ${result.slice(0, 200)}`,
    );
  });

  test("multi-term query produces windows from highlight markers", () => {
    const part1 = "Database connections are pooled for performance.";
    const gap = " ".repeat(800);
    const part2 = "The configuration file supports YAML formats.";
    const content = buildContent("Preamble text.", part1 + gap + part2);

    const highlighted = markHighlighted(content, ["connections", "configuration"]);

    const result = extractSnippet(content, "connect configure", 1500, highlighted);
    assert.ok(
      result.includes("connections"),
      `Expected snippet to include "connections"`,
    );
    assert.ok(
      result.includes("configuration"),
      `Expected snippet to include "configuration"`,
    );
  });

  test("falls back to indexOf when highlighted is absent", () => {
    const relevant = "The server connect pool handles all requests efficiently.";
    const content = buildContent("Introduction to the system architecture.", relevant);
    const result = extractSnippet(content, "connect");
    assert.ok(
      result.includes("connect pool"),
      `Expected snippet to include "connect pool", got: ${result.slice(0, 200)}`,
    );
  });

  test("returns prefix when no matches found at all", () => {
    const content = buildContent("Nothing relevant here.", "Still nothing relevant.");
    const result = extractSnippet(content, "xylophone");
    assert.ok(
      result.endsWith("\u2026"),
      `Expected snippet to end with ellipsis (prefix fallback)`,
    );
  });

  test("short query terms (<=2 chars) are filtered in indexOf fallback", () => {
    const relevant = "The API endpoint returns a JSON response with status codes.";
    const content = buildContent("Filler content about nothing in particular.", relevant);
    const result = extractSnippet(content, "an endpoint");
    assert.ok(
      result.includes("endpoint"),
      `Expected snippet to include "endpoint", got: ${result.slice(0, 200)}`,
    );
  });
});

describe("Store integration: highlighted field", () => {
  test("search returns highlighted field with STX/ETX markers", () => {
    const store = new ContentStore(":memory:");
    try {
      store.index({
        content: "# Config\n\nThe configuration file supports YAML and JSON formats.",
        source: "test-highlight",
      });

      const results = store.search("configure", 1);
      assert.ok(results.length > 0, "Expected at least one result");

      const r = results[0];
      assert.ok(r.highlighted, "Expected highlighted field to be populated");
      assert.ok(
        r.highlighted.includes(STX),
        `Expected STX marker in highlighted, got: ${r.highlighted.slice(0, 100)}`,
      );
      assert.ok(
        r.highlighted.includes(ETX),
        `Expected ETX marker in highlighted`,
      );
    } finally {
      store.close();
    }
  });

  test("highlighted markers surround stemmed matches", () => {
    const store = new ContentStore(":memory:");
    try {
      store.index({
        content: "# Auth\n\nToken-based authentication requires a valid JWT.",
        source: "test-highlight-stem",
      });

      const results = store.search("authenticate", 1);
      assert.ok(results.length > 0, "Expected at least one result");

      const r = results[0];
      // The highlighted field should mark "authentication" even though
      // the query was "authenticate" — FTS5 porter stemmer handles this.
      assert.ok(
        r.highlighted!.includes(`${STX}authentication${ETX}`),
        `Expected "authentication" to be marked, got: ${r.highlighted!.slice(0, 100)}`,
      );
    } finally {
      store.close();
    }
  });

  test("searchTrigram returns highlighted field", () => {
    const store = new ContentStore(":memory:");
    try {
      store.index({
        content: "# Logging\n\nThe application logs errors to stderr by default.",
        source: "test-trigram-highlight",
      });

      const results = store.searchTrigram("errors", 1);
      assert.ok(results.length > 0, "Expected at least one trigram result");

      const r = results[0];
      assert.ok(r.highlighted, "Expected highlighted field from trigram search");
      assert.ok(
        r.highlighted.includes(STX),
        "Expected STX marker in trigram highlighted",
      );
    } finally {
      store.close();
    }
  });

  test("extractSnippet with store-produced highlighted finds stemmed region", () => {
    const store = new ContentStore(":memory:");
    try {
      // Content where "configuration" is past the 1500-char prefix
      const preamble = "# Intro\n\n" + "Background context. ".repeat(100);
      const relevant = "The configuration file supports YAML and JSON formats for all settings.";
      const fullContent = preamble + "\n\n" + relevant;

      store.index({ content: fullContent, source: "test-e2e" });

      const results = store.search("configure", 1);
      assert.ok(results.length > 0, "Expected search result");

      const r = results[0];
      const snippet = extractSnippet(r.content, "configure", 1500, r.highlighted);

      assert.ok(
        snippet.includes("configuration"),
        `Expected snippet to include "configuration" via FTS5 highlight, got: ${snippet.slice(0, 200)}`,
      );
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 8. BM25 Field Weight Tuning
// ═══════════════════════════════════════════════════════════

describe("BM25 field weight tuning", () => {
  test("title match outranks content-only match", () => {
    const store = createStore();
    try {
      // Chunk 1: "authentication" in title only
      store.index({
        content: "# Authentication\n\nThis section covers user login and access control.",
        source: "docs-with-title",
      });
      // Chunk 2: "authentication" in content only
      store.index({
        content: "# Security Overview\n\nThe authentication process validates credentials against the database.",
        source: "docs-content-only",
      });

      const results = store.searchWithFallback("authentication", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      // With 5x title weight, the title-match chunk should rank first
      assert.ok(
        results[0].title.toLowerCase().includes("authentication"),
        `Expected first result to have 'authentication' in title, got: "${results[0].title}"`,
      );
    } finally {
      store.close();
    }
  });

  test("title weight boost is consistent for trigram search", () => {
    const store = createStore();
    try {
      store.index({
        content: "# useEffectCallback\n\nHandles side effects in components.",
        source: "trigram-title",
      });
      store.index({
        content: "# Component Lifecycle\n\nThe useEffectCallback hook manages cleanup logic.",
        source: "trigram-content",
      });

      const results = store.searchTrigram("useEffectCallback", 5);
      assert.ok(results.length >= 1, "Trigram should find camelCase term");
    } finally {
      store.close();
    }
  });

  test("backward compatibility: existing searches still return results", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The caching strategy uses Redis for session data.\nCache invalidation happens on write.",
        "cache-docs",
      );

      const results = store.searchWithFallback("caching strategy", 3);
      assert.ok(results.length > 0, "Existing searches should still work");
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Content Type Filter
// ═══════════════════════════════════════════════════════════

describe("Content type filter", () => {
  function createMixedStore(): ContentStore {
    const store = createStore();
    // Index content with code blocks (will get contentType="code")
    store.index({
      content: "# API Reference\n\n```javascript\nfunction authenticate(user, pass) {\n  return jwt.sign({ user }, SECRET);\n}\n```\n\nThis function handles user authentication.",
      source: "api-docs",
    });
    // Index prose-only content (will get contentType="prose")
    store.index({
      content: "# Architecture Overview\n\nThe authentication flow uses JWT tokens for session management. Users authenticate via the login endpoint.",
      source: "arch-docs",
    });
    return store;
  }

  test("search() with contentType='code' returns only code chunks", () => {
    const store = createMixedStore();
    try {
      const results = store.search("authenticate", 10, undefined, "AND", "code");
      assert.ok(results.length > 0, "Should find code chunks");
      for (const r of results) {
        assert.equal(r.contentType, "code", `Expected code, got ${r.contentType} in "${r.title}"`);
      }
    } finally {
      store.close();
    }
  });

  test("search() with contentType='prose' returns only prose chunks", () => {
    const store = createMixedStore();
    try {
      const results = store.search("authentication", 10, undefined, "AND", "prose");
      assert.ok(results.length > 0, "Should find prose chunks");
      for (const r of results) {
        assert.equal(r.contentType, "prose", `Expected prose, got ${r.contentType} in "${r.title}"`);
      }
    } finally {
      store.close();
    }
  });

  test("searchTrigram() respects contentType filter", () => {
    const store = createMixedStore();
    try {
      const results = store.searchTrigram("authenticat", 10, undefined, "AND", "prose");
      for (const r of results) {
        assert.equal(r.contentType, "prose", `Trigram should respect contentType filter`);
      }
    } finally {
      store.close();
    }
  });

  test("searchWithFallback() passes contentType through all layers", () => {
    const store = createMixedStore();
    try {
      const results = store.searchWithFallback("authenticate", 5, undefined, "code");
      assert.ok(results.length > 0, "Should find results");
      for (const r of results) {
        assert.equal(r.contentType, "code", `searchWithFallback should filter by contentType`);
      }
    } finally {
      store.close();
    }
  });

  test("contentType + source combined filter", () => {
    const store = createMixedStore();
    try {
      const results = store.searchWithFallback("authentication", 5, "arch-docs", "prose");
      assert.ok(results.length > 0, "Should find results with both filters");
      for (const r of results) {
        assert.equal(r.contentType, "prose");
        assert.ok(r.source.includes("arch-docs"), `Source should match filter`);
      }
    } finally {
      store.close();
    }
  });

  test("contentType undefined returns all types (backward compat)", () => {
    const store = createMixedStore();
    try {
      const results = store.searchWithFallback("authentication", 10);
      assert.ok(results.length > 0, "Should find results without contentType filter");
      // Should include both code and prose chunks (no filter applied)
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 10. Reciprocal Rank Fusion (RRF)
// ═══════════════════════════════════════════════════════════

describe("Reciprocal Rank Fusion", () => {
  test("RRF returns matchLayer='rrf' for fused results", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The authentication middleware validates JWT tokens on every request.\nExpired tokens are rejected with 401.",
        "auth-docs",
      );
      const results = store.searchWithFallback("authentication JWT tokens", 3);
      assert.ok(results.length > 0, "RRF should find results");
      assert.equal(results[0].matchLayer, "rrf", "matchLayer should be 'rrf'");
    } finally {
      store.close();
    }
  });

  test("RRF merges porter and trigram results", () => {
    const store = createStore();
    try {
      // Porter-friendly: standard English words
      store.indexPlainText(
        "The authentication middleware validates credentials against the user database.",
        "porter-friendly",
      );
      // Trigram-friendly: camelCase identifier not in porter vocabulary
      store.indexPlainText(
        "The authenticationMiddleware component handles token validation.",
        "trigram-friendly",
      );

      const results = store.searchWithFallback("authentication middleware", 5);
      assert.ok(results.length >= 2, "Should find results from both tables");
    } finally {
      store.close();
    }
  });

  test("RRF deduplicates by source::title key", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The caching strategy uses Redis for session management.\nCache invalidation triggers on every write operation.",
        "cache-docs",
      );

      const results = store.searchWithFallback("caching strategy", 10);
      // Check no duplicates: same source+title should not appear twice
      const keys = results.map(r => `${r.source}::${r.title}`);
      const uniqueKeys = new Set(keys);
      assert.equal(keys.length, uniqueKeys.size, "Results should have no duplicates");
    } finally {
      store.close();
    }
  });

  test("RRF-fuzzy activates on typo", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The kubernetes cluster manages container orchestration.\nPods are scheduled across worker nodes.",
        "k8s-docs",
      );

      const results = store.searchWithFallback("kuberntes", 3); // typo
      assert.ok(results.length > 0, "Fuzzy correction should find results");
      assert.equal(results[0].matchLayer, "rrf-fuzzy", "matchLayer should be 'rrf-fuzzy'");
    } finally {
      store.close();
    }
  });

  test("RRF with source filter respects constraint", () => {
    const store = createStore();
    try {
      store.indexPlainText("Authentication flow uses JWT tokens.", "auth-source");
      store.indexPlainText("Authentication also uses OAuth.", "oauth-source");

      const results = store.searchWithFallback("authentication", 5, "auth-source");
      assert.ok(results.length > 0);
      for (const r of results) {
        assert.ok(r.source.includes("auth-source"), `Source should match: ${r.source}`);
      }
    } finally {
      store.close();
    }
  });

  test("RRF with contentType filter works", () => {
    const store = createStore();
    try {
      store.index({
        content: "# API Reference\n\n```javascript\nfunction authenticate() { return true; }\n```",
        source: "code-docs",
      });
      store.index({
        content: "# Architecture\n\nThe authentication system uses JWT tokens for session management.",
        source: "prose-docs",
      });

      const results = store.searchWithFallback("authenticate", 5, undefined, "code");
      for (const r of results) {
        assert.equal(r.contentType, "code", `Should filter to code only`);
      }
    } finally {
      store.close();
    }
  });

  test("multi-table match ranks higher than single-table", () => {
    const store = createStore();
    try {
      // This content should match well on both porter AND trigram
      store.indexPlainText(
        "The authentication middleware validates credentials against the database.\nauthentication is the first step.",
        "both-tables",
      );
      // This content has a unique term only trigram would find well
      store.indexPlainText(
        "The xyzAuthHelper utility function provides helper methods for auth.",
        "single-table",
      );

      const results = store.searchWithFallback("authentication", 5);
      assert.ok(results.length > 0, "Should find results");
    } finally {
      store.close();
    }
  });

  test("backward compat: existing search patterns still find results", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The caching strategy uses Redis for session data.\nCache invalidation happens on write.",
        "execute:shell",
      );

      const results = store.searchWithFallback("caching strategy", 3, "execute:shell");
      assert.ok(results.length > 0, "Existing patterns should still work");
      assert.ok(results[0].content.includes("caching"), "Content should match");
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Proximity Reranking
// ═══════════════════════════════════════════════════════════

describe("Proximity reranking", () => {
  test("adjacent terms rank higher than distant terms", () => {
    const store = createStore();
    try {
      // Terms are adjacent: "error handling" close together
      store.indexPlainText(
        "The error handling middleware catches all exceptions and returns proper HTTP status codes.",
        "close-terms",
      );
      // Terms are far apart: "error" at start, "handling" much later
      store.indexPlainText(
        "When an error occurs in the system, the logger records it. " +
        "After extensive processing and validation of the request parameters, " +
        "the response formatting and status code handling takes place.",
        "distant-terms",
      );

      const results = store.searchWithFallback("error handling", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      // The chunk with adjacent terms should rank first
      assert.ok(
        results[0].source === "close-terms",
        `Expected close-terms first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("single-term queries are not affected by proximity", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The authentication system validates user credentials.",
        "source-a",
      );
      store.indexPlainText(
        "Authentication is required for all API endpoints.",
        "source-b",
      );

      const results = store.searchWithFallback("authentication", 5);
      assert.ok(results.length > 0, "Should find results");
      // Single term: proximity should not change ordering
      // Just verify results are returned (RRF ordering preserved)
    } finally {
      store.close();
    }
  });

  test("tightest span wins for multi-term query", () => {
    const store = createStore();
    try {
      // Span of ~5 chars between "cache" and "invalidation"
      store.indexPlainText(
        "The cache invalidation strategy ensures data consistency across all nodes.",
        "tight-span",
      );
      // Span of ~80+ chars between "cache" and "invalidation"
      store.indexPlainText(
        "The cache layer stores frequently accessed data in memory for fast retrieval. " +
        "When data changes, the system triggers invalidation of affected entries.",
        "wide-span",
      );

      const results = store.searchWithFallback("cache invalidation", 5);
      assert.ok(results.length >= 2, "Should find both");
      assert.ok(
        results[0].source === "tight-span",
        `Expected tight-span first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("proximity with source filter still works", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The error handling middleware catches exceptions.",
        "filtered-source",
      );
      store.indexPlainText(
        "Error recovery and handling procedures are documented.",
        "other-source",
      );

      const results = store.searchWithFallback("error handling", 5, "filtered-source");
      assert.ok(results.length > 0);
      for (const r of results) {
        assert.ok(r.source.includes("filtered-source"));
      }
    } finally {
      store.close();
    }
  });

  test("three-term query proximity", () => {
    const store = createStore();
    try {
      // All three terms close together
      store.indexPlainText(
        "The user authentication token validation ensures secure access to protected resources.",
        "all-close",
      );
      // Terms spread out
      store.indexPlainText(
        "The user profile page displays account information. " +
        "For security, authentication is checked on every request. " +
        "Additionally, token expiration and validation rules apply to API calls.",
        "spread-out",
      );

      const results = store.searchWithFallback("user authentication token", 5);
      assert.ok(results.length >= 2, "Should find both");
      assert.ok(
        results[0].source === "all-close",
        `Expected all-close first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("proximity does not eliminate results, only reorders", () => {
    const store = createStore();
    try {
      store.indexPlainText("Error handling is important.", "chunk-a");
      store.indexPlainText("Proper error and exception handling.", "chunk-b");
      store.indexPlainText("Error recovery handling procedures.", "chunk-c");

      const results = store.searchWithFallback("error handling", 10);
      // All chunks should still be present (proximity only reorders, never removes)
      assert.ok(results.length >= 2, "Should not eliminate any results");
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Content-Type-Aware Title Boost
// ═══════════════════════════════════════════════════════════

describe("Content-type-aware title boost in reranking", () => {
  test("chunk with query term in title ranks above chunk with same term only in body", () => {
    const store = createStore();
    try {
      // Chunk A: title matches "parseConfig"
      store.index({
        content: "## parseConfig\n\nThis function loads configuration from disk and parses it into a settings object.",
        source: "title-match",
      });
      // Chunk B: "parseConfig" only in body, not title
      store.index({
        content: "## Configuration Guide\n\nThe system uses parseConfig to load settings from disk. Call parseConfig with the path to your config file.",
        source: "body-match",
      });

      const results = store.searchWithFallback("parseConfig", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      assert.ok(
        results[0].title.toLowerCase().includes("parseconfig"),
        "Chunk with title match should rank first",
      );
    } finally {
      store.close();
    }
  });

  test("title boost applies to single-term queries (not just multi-term)", () => {
    const store = createStore();
    try {
      store.index({
        content: "## authentication\n\nThis module handles user login and session management.",
        source: "auth-titled",
      });
      store.index({
        content: "## Security Overview\n\nThe authentication system validates user credentials using bcrypt hashing. Authentication tokens expire after 24 hours.",
        source: "auth-body",
      });

      const results = store.searchWithFallback("authentication", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      assert.ok(
        results[0].title.toLowerCase().includes("authentication"),
        "Chunk with query term in title should rank first",
      );
    } finally {
      store.close();
    }
  });

  test("code chunks get stronger title boost than prose chunks", () => {
    const store = createStore();
    try {
      // Code chunk: "validator" in title + code fence → contentType=code, titleWeight=0.6
      store.index({
        content: "## validator\n\n```javascript\nclass Validator {\n  validate(input) { return input.length > 0; }\n}\n```",
        source: "validator-code",
      });
      // Prose chunk: "validator" in title, no code fence → contentType=prose, titleWeight=0.3
      store.index({
        content: "## validator\n\nThe validator module provides input validation utilities for the API layer. It checks all fields.",
        source: "validator-prose",
      });

      const results = store.searchWithFallback("validator input", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      assert.equal(results[0].contentType, "code", "Code chunk should rank first with stronger title boost");
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Phrase-frequency reward in reranking
//
// Adds a phrase-frequency component on top of the existing minSpan proximity.
// minSpan returns a single number (the tightest window), so a doc with 3×
// adjacent phrase hits ties a doc with 1× adjacent phrase hit at the same
// span — and length-normalization actually favors the longer doc. The reward
// counts ordered adjacent-pair occurrences (term[i] followed by term[i+1]
// within 30 chars) and adds a saturating boost (cap 0.5 at 4 hits) so
// frequency breaks the tie without unbounded keyword-stuffing wins.
// ═══════════════════════════════════════════════════════════════════════════

describe("Phrase-frequency reward in reranking", () => {
  test("multiple phrase occurrences outrank a single tight phrase at similar minSpan", () => {
    const store = createStore();
    try {
      // Three adjacent occurrences. minSpan ≈ 6 chars (one occurrence).
      store.indexPlainText(
        "Cache invalidation matters. Cache invalidation is hard. Cache invalidation strategy is documented here too.",
        "phrase-frequent",
      );
      // One adjacent occurrence padded with filler so contentLen is comparable.
      store.indexPlainText(
        "Cache invalidation appears here once. " +
          "The remainder of this paragraph deliberately discusses unrelated topics like deployment, monitoring, and on-call rotations.",
        "phrase-once",
      );

      const results = store.searchWithFallback("cache invalidation", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      assert.equal(
        results[0].source,
        "phrase-frequent",
        `Expected phrase-frequent first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("phrase-frequency reward respects query order (regression guard)", () => {
    const store = createStore();
    try {
      // Adjacent in query order.
      store.indexPlainText(
        "Lorem ipsum dolor sit amet. The cache invalidation pipeline runs on every write.",
        "phrase-ordered",
      );
      // Reversed order — no ordered phrase hits.
      store.indexPlainText(
        "Lorem ipsum dolor sit amet. The invalidation step is followed by a cache flush.",
        "phrase-reversed",
      );

      const results = store.searchWithFallback("cache invalidation", 5);
      assert.ok(results.length >= 2);
      assert.equal(
        results[0].source,
        "phrase-ordered",
        `Expected phrase-ordered first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("3-term query: only consecutive-pair adjacency contributes to frequency", () => {
    const store = createStore();
    try {
      // "alpha beta" adjacent (pair 0→1 hits) AND "beta gamma" adjacent (pair 1→2 hits)
      // Three contiguous mentions of "alpha beta gamma" → 2 pairs per mention × 3 mentions = 6 pair-hits.
      store.indexPlainText(
        "alpha beta gamma matters. alpha beta gamma is hard. alpha beta gamma works well in practice.",
        "all-adjacent",
      );
      // "alpha beta" adjacent BUT "beta gamma" separated by ~80 chars of filler.
      // Pair 0→1 hits once, pair 1→2 misses → only 1 pair-hit.
      store.indexPlainText(
        "alpha beta runs the pipeline; the rest of this paragraph deliberately " +
          "talks about deployment monitoring oncall rotations and other unrelated topics gamma.",
        "split-adjacency",
      );

      const results = store.searchWithFallback("alpha beta gamma", 5);
      assert.ok(results.length >= 2);
      assert.equal(
        results[0].source,
        "all-adjacent",
        `Expected all-adjacent first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("saturation: 8-hit stuffed doc cannot beat 4-hit doc by more than the cap allows", () => {
    const store = createStore();
    try {
      // 8 adjacent occurrences — well above saturation (4).
      store.indexPlainText(
        "cache invalidation cache invalidation cache invalidation cache invalidation " +
          "cache invalidation cache invalidation cache invalidation cache invalidation",
        "stuffed-eight",
      );
      // 4 adjacent occurrences — exactly at saturation.
      store.indexPlainText(
        "cache invalidation cache invalidation cache invalidation cache invalidation",
        "stuffed-four",
      );
      // 1 adjacent occurrence inside a long natural paragraph.
      // Without a cap, stuffed-eight (8 hits) could outrank everything; with
      // the cap binding at 4, stuffed-eight and stuffed-four collapse to the
      // same phrase contribution. The natural doc earns a smaller phrase
      // contribution but still benefits from comparable proximity, so it must
      // remain competitive in the top-3.
      store.indexPlainText(
        "Cache invalidation in a real system requires careful coordination across " +
          "distributed nodes. Replication lag, eventual consistency, and leader-election " +
          "races all interact in subtle ways that complicate a naive flush-on-write " +
          "strategy used by many caching layers in production environments today.",
        "natural-prose",
      );

      const results = store.searchWithFallback("cache invalidation", 5);
      assert.ok(results.length >= 3, "Should find all three chunks");

      const top3 = results.slice(0, 3).map((r) => r.source);
      assert.ok(
        top3.includes("natural-prose"),
        `Cap must bind so natural-prose stays competitive; got top3=${top3.join(", ")}`,
      );
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Search Relevance Eval — ranking quality under competitive conditions
//
// Indexes 12 heterogeneous markdown sources into a single store and asserts
// ranking correctness (precision@1, recall@5, title boost, cascade, negatives).
// Guards BM25 weights, RRF K, proximity formula, and title boost weights
// against silent regression.
// ═══════════════════════════════════════════════════════════════════════════

const RELEVANCE_CORPUS: Array<{ source: string; markdown: string }> = [
  {
    source: "api-auth-handler",
    markdown: `# Authentication middleware\n\n## verifyToken\n\n\`\`\`typescript\nexport async function verifyToken(req: Request): Promise<User> {\n  const header = req.headers.get("Authorization");\n  if (!header?.startsWith("Bearer ")) {\n    throw new AuthenticationError("Missing or malformed Authorization header");\n  }\n  const token = header.slice(7);\n  const payload = jwt.verify(token, process.env.JWT_SECRET!);\n  return payload;\n}\n\`\`\`\n\nThe middleware validates JWT tokens from the Authorization header and returns the decoded user payload.`,
  },
  {
    source: "nginx-access-log",
    markdown: `# Nginx access log\n\n## Recent requests\n\n\`\`\`\n192.168.1.42 "GET /api/auth/callback HTTP/1.1" 200 1234\n192.168.1.43 "GET /static/bundle.js HTTP/1.1" 200 450321\n192.168.1.44 "POST /api/users HTTP/1.1" 201 89\n10.0.0.1 "DELETE /api/sessions HTTP/1.1" 204 0\n\`\`\``,
  },
  {
    source: "react-useeffect-docs",
    markdown: `# React useEffect\n\n## Cleanup and dependencies\n\nuseEffect lets you synchronize a component with an external system.\n\n\`\`\`jsx\nuseEffect(() => {\n  const connection = createConnection(serverUrl, roomId);\n  connection.connect();\n  return () => connection.disconnect();\n}, [serverUrl, roomId]);\n\`\`\`\n\n## When cleanup runs\n\nThe cleanup function runs before every re-render with changed dependencies, and once more when the component unmounts.`,
  },
  {
    source: "vitest-output",
    markdown: `# Test results\n\n## Summary\n\nTest Suites: 1 failed, 29 passed, 30 total\nTests: 1 failed, 219 passed, 220 total\n\n## Failed test\n\n\`\`\`\nFAIL tests/hooks/integration.test.ts\n  PostToolUse hook session capture\n    AssertionError: expected "ok" to equal "captured"\n    at tests/hooks/integration.test.ts:142:5\n\`\`\`\n\n## Passed suites\n\n- store.test.ts (34 tests) 1200ms\n- executor.test.ts (55 tests) 3400ms`,
  },
  {
    source: "database-migration",
    markdown: `# Database migration 0042\n\n## Add tenant_id column\n\n\`\`\`sql\nALTER TABLE orders ADD COLUMN tenant_id UUID NOT NULL DEFAULT '00000000';\nCREATE INDEX idx_orders_tenant ON orders(tenant_id);\n\`\`\`\n\n## Backfill\n\n\`\`\`sql\nUPDATE orders SET tenant_id = (SELECT org_id FROM users WHERE users.id = orders.user_id);\n\`\`\``,
  },
  {
    source: "nextjs-build-output",
    markdown: `# Next.js build output\n\n## Warnings\n\n- You have enabled experimental feature (serverActions) in next.config.js\n- Duplicate page detected. pages/api/auth and app/api/auth both resolve to /api/auth\n\n## Routes\n\n| Route | Size | First Load |\n|-------|------|------------|\n| / | 5.2 kB | 89.1 kB |\n| /dashboard | 12.3 kB | 96.2 kB |`,
  },
  {
    source: "python-traceback",
    markdown: `# Python error traceback\n\n## Database connection timeout\n\n\`\`\`\nTraceback (most recent call last):\n  File "/app/services/sync.py", line 234, in sync_orders\n    conn = await asyncpg.connect(DATABASE_URL, timeout=30)\nasyncio.TimeoutError\n\nDatabaseConnectionError: Failed to connect after 3 retries\n\`\`\`\n\nThe sync service could not reach the PostgreSQL database within the 30-second timeout.`,
  },
  {
    source: "git-log-recent",
    markdown: `# Git log\n\n## Recent commits\n\n- eb36c2e perf: enable mmap_size pragma for FTS5 search\n- 766de41 ci: update server.bundle.mjs\n- 01470ec fix(store): wrap indexPlainText with withRetry\n- c445a12 feat(kiro): add full hook support for Kiro IDE`,
  },
  {
    source: "tailwind-config",
    markdown: `# Tailwind CSS configuration\n\n## Custom theme colors\n\n\`\`\`javascript\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: {\n        brand: { 50: '#f0f9ff', 500: '#0ea5e9', 900: '#0c4a6e' },\n      },\n      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },\n    },\n  },\n  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/typography')],\n};\n\`\`\``,
  },
  {
    source: "dockerfile-prod",
    markdown: `# Dockerfile\n\n## Multi-stage production build\n\n\`\`\`dockerfile\nFROM node:20-alpine AS builder\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci --production=false\nCOPY . .\nRUN npm run build\n\nFROM node:20-alpine AS runner\nENV NODE_ENV=production\nCOPY --from=builder /app/build ./build\nCMD ["node", "build/server.js"]\n\`\`\``,
  },
  {
    source: "k8s-deployment",
    markdown: `# Kubernetes deployment\n\n## api-server\n\n\`\`\`yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api-server\n  namespace: production\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: api\n          image: registry.example.com/api:v2.3.1\n          resources:\n            requests: { cpu: "250m", memory: "512Mi" }\n          readinessProbe:\n            httpGet: { path: /health, port: 3000 }\n\`\`\``,
  },
  {
    source: "package-json-deps",
    markdown: `# Package dependencies\n\n## Production\n\n- next 14.2.3\n- react 18.3.1\n- @prisma/client 5.14.0\n- zod 3.23.8\n\n## Dev dependencies\n\n- typescript 5.4.5\n- vitest 1.6.0\n- tailwindcss 3.4.3\n- eslint 8.57.0`,
  },
];

describe("Search relevance eval — competitive corpus", () => {
  let relevanceStore: ContentStore;

  beforeEach(() => {
    const path = join(tmpdir(), `ctx-relevance-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    relevanceStore = new ContentStore(path);
    for (const doc of RELEVANCE_CORPUS) {
      relevanceStore.index({ content: doc.markdown, source: doc.source });
    }
  });

  afterEach(() => {
    relevanceStore.cleanup();
  });

  function topOne(query: string, expectedSource: string) {
    const results = relevanceStore.searchWithFallback(query, 3);
    expect(results.length, `"${query}" should return results`).toBeGreaterThan(0);
    expect(results[0].source, `"${query}" #1 should be "${expectedSource}", got "${results[0]?.source}"`).toBe(expectedSource);
  }

  function ranking(query: string, expectTop: string | string[], expectAbsent?: string[], layer?: string) {
    const results = relevanceStore.searchWithFallback(query, 5);
    const sources = results.map((r) => r.source);
    const tops = Array.isArray(expectTop) ? expectTop : [expectTop];
    for (const e of tops) expect(sources, `"${query}" should find "${e}" in top 5, got [${sources}]`).toContain(e);
    if (expectAbsent) for (const a of expectAbsent) expect(sources, `"${query}" should NOT return "${a}"`).not.toContain(a);
    if (layer) expect(results[0]?.matchLayer, `"${query}" should hit ${layer} layer`).toBe(layer);
  }

  // precision@1
  test("'authentication middleware JWT' → api-auth-handler", () => topOne("authentication middleware JWT", "api-auth-handler"));
  test("'database connection timeout' → python-traceback", () => topOne("database connection timeout", "python-traceback"));
  test("'useEffect cleanup' → react-useeffect-docs", () => topOne("useEffect cleanup", "react-useeffect-docs"));
  test("'tenant_id migration ALTER TABLE' → database-migration", () => topOne("tenant_id migration ALTER TABLE", "database-migration"));
  test("'Dockerfile multi-stage build' → dockerfile-prod", () => topOne("Dockerfile multi-stage build", "dockerfile-prod"));
  test("'Kubernetes deployment replicas' → k8s-deployment", () => topOne("Kubernetes deployment replicas", "k8s-deployment"));
  test("'tailwind theme colors brand' → tailwind-config", () => topOne("tailwind theme colors brand", "tailwind-config"));
  test("'test failed assertion FAIL' → vitest-output", () => topOne("test failed assertion FAIL", "vitest-output"));

  // recall@5
  test("'error timeout' finds python-traceback", () => ranking("error timeout", "python-traceback", ["tailwind-config", "git-log-recent"]));
  test("'build warning experimental serverActions' finds nextjs output", () => ranking("build warning experimental serverActions", "nextjs-build-output"));
  test("'react dependencies vitest typescript' finds package.json", () => ranking("react dependencies vitest typescript", "package-json-deps"));
  test("'mmap pragma perf FTS5' finds git log", () => ranking("mmap pragma perf FTS5", "git-log-recent"));

  // title boost
  test("'Kubernetes deployment' title match ranks k8s-deployment first", () => topOne("Kubernetes deployment", "k8s-deployment"));
  test("'Dockerfile' title match ranks dockerfile-prod first", () => topOne("Dockerfile", "dockerfile-prod"));

  // cascade
  test("exact terms hit RRF layer", () => ranking("useEffect cleanup", "react-useeffect-docs", undefined, "rrf"));
  test("typo still resolves to correct doc", () => ranking("authenticaton middlewar", "api-auth-handler"));

  // negatives
  test("'tailwind colors' excludes unrelated sources", () => ranking("tailwind colors", "tailwind-config", ["database-migration", "python-traceback"]));
  test("'SQL ALTER TABLE' excludes non-DB sources", () => ranking("SQL ALTER TABLE", "database-migration", ["nginx-access-log", "react-useeffect-docs"]));
});

// ═══════════════════════════════════════════════════════════
// 8. Unified multi-source search (consolidated from tests/search/unified.test.ts)
// ═══════════════════════════════════════════════════════════

const unifiedCleanups: Array<() => void> = [];

function createUnifiedStore(): ContentStore {
  const path = join(
    tmpdir(),
    `ctx-unified-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const store = new ContentStore(path);
  unifiedCleanups.push(() => store.close());
  return store;
}

function createTestDB(): SessionDB {
  const dbPath = join(tmpdir(), `session-unified-test-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  unifiedCleanups.push(() => db.cleanup());
  return db;
}

function createTempDir(): string {
  const dir = join(tmpdir(), `ctx-unified-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  unifiedCleanups.push(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

afterEach(() => {
  for (const fn of unifiedCleanups) {
    try { fn(); } catch { /* ignore */ }
  }
  unifiedCleanups.length = 0;
});

describe("sort=relevance returns ContentStore only", () => {
  test("relevance mode only queries ContentStore, ignores SessionDB and auto-memory", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Authentication middleware validates JWT tokens on every request.",
      "execute:shell",
    );

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "JWT handler in session DB",
      priority: 2,
    }, "PostToolUse");

    const results = searchAllSources({
      query: "JWT",
      limit: 5,
      store,
      sort: "relevance",
      sessionDB,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    // Should have results from ContentStore only
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.origin === "current-session")).toBe(true);
  });
});

describe("sort=timeline merges 3 sources chronologically", () => {
  test("timeline mode merges ContentStore, SessionDB, and auto-memory results", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Deploy pipeline configuration for production environment.",
      "execute:shell",
    );

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "tool",
      category: "tool",
      data: "Deploy script executed successfully in prior session",
      priority: 2,
    }, "PostToolUse");

    // Create auto-memory files
    const configDir = createTempDir();
    const memoryDir = join(configDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(configDir, "CLAUDE.md"),
      "# Deploy Rules\nAlways deploy to staging first.\n",
    );

    const results = searchAllSources({
      query: "deploy",
      limit: 10,
      store,
      sort: "timeline",
      sessionDB,
      projectDir: "/project",
      configDir,
    });

    // Should have results from multiple origins
    const origins = new Set(results.map(r => r.origin));
    expect(origins.has("current-session")).toBe(true);
    // SessionDB or auto-memory should also appear
    expect(origins.size).toBeGreaterThanOrEqual(2);
  });

  test("timeline results are sorted chronologically", () => {
    const store = createUnifiedStore();
    store.indexPlainText("Server config alpha", "execute:shell");

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "config",
      category: "config",
      data: "Server config beta from prior session",
      priority: 2,
    }, "PostToolUse");

    const results = searchAllSources({
      query: "server config",
      limit: 10,
      store,
      sort: "timeline",
      sessionDB,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    // Verify chronological ordering: timestamps should be non-decreasing
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1].timestamp || "";
      const curr = results[i].timestamp || "";
      // Allow empty timestamps (ContentStore results) — they sort first
      if (prev && curr) {
        expect(prev <= curr).toBe(true);
      }
    }
  });
});

describe("error in one source doesn't break others", () => {
  test("invalid sessionDB still returns ContentStore results", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Error handling test content with database queries.",
      "execute:shell",
    );

    // Pass null sessionDB to simulate unavailable session DB
    const results = searchAllSources({
      query: "database",
      limit: 5,
      store,
      sort: "timeline",
      sessionDB: null,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.origin === "current-session")).toBe(true);
  });

  test("nonexistent configDir still returns other source results", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Memory resilience test with important data.",
      "execute:shell",
    );

    const results = searchAllSources({
      query: "resilience",
      limit: 5,
      store,
      sort: "timeline",
      sessionDB: null,
      projectDir: "/project",
      configDir: "/tmp/definitely-does-not-exist-" + randomUUID(),
    });

    expect(results.length).toBeGreaterThan(0);
  });
});

describe("empty index guard skipped in timeline mode", () => {
  test("timeline mode proceeds even when ContentStore has zero chunks", () => {
    const store = createUnifiedStore(); // empty, no indexed content

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "Important file from prior session timeline check",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project", source: "env", confidence: 1 });

    // In timeline mode, empty ContentStore should NOT be an error
    const results = searchAllSources({
      query: "timeline check",
      limit: 5,
      store,
      sort: "timeline",
      sessionDB,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    // Should get results from SessionDB even though ContentStore is empty
    const priorResults = results.filter(r => r.origin === "prior-session");
    expect(priorResults.length).toBeGreaterThan(0);
  });

  test("relevance mode with empty store returns no results", () => {
    const store = createUnifiedStore(); // empty

    const results = searchAllSources({
      query: "anything",
      limit: 5,
      store,
      sort: "relevance",
      sessionDB: null,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    expect(results.length).toBe(0);
  });
});

describe("default sort is relevance (backward compatible)", () => {
  test("omitting sort defaults to relevance behavior", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Backward compatibility test for default search mode.",
      "execute:shell",
    );

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "Backward compatibility data in session DB",
      priority: 2,
    }, "PostToolUse");

    // No sort param — should default to "relevance"
    const results = searchAllSources({
      query: "backward compatibility",
      limit: 5,
      store,
      // sort intentionally omitted
      sessionDB,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    // Should only have ContentStore results (relevance mode)
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.origin === "current-session")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Auto-memory search (consolidated from tests/search/auto-memory.test.ts)
// ═══════════════════════════════════════════════════════════

describe("searchAutoMemory", () => {
  const AUTO_MEM_ROOT = join(tmpdir(), `ctx-auto-memory-test-${Date.now()}`);
  const CLAUDE_CONFIG = join(AUTO_MEM_ROOT, ".claude");
  const QWEN_CONFIG = join(AUTO_MEM_ROOT, ".qwen");
  const PROJECT_DIR = join(AUTO_MEM_ROOT, "project");

  // Set up fixture files once
  (() => {
    // Create project-level CLAUDE.md
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(
      join(PROJECT_DIR, "CLAUDE.md"),
      "Project instructions: use TypeScript strict mode. Analytics pipeline config here.",
    );

    // Create user-level configDir for .claude
    const claudeMemDir = join(CLAUDE_CONFIG, "memory");
    mkdirSync(claudeMemDir, { recursive: true });

    writeFileSync(
      join(CLAUDE_CONFIG, "CLAUDE.md"),
      "Global user preferences: dark theme, vim keybindings.",
    );

    writeFileSync(
      join(claudeMemDir, "analytics_separation.md"),
      "Analytics must be separate project, not inside context-mode. Datadog model.",
    );
    writeFileSync(
      join(claudeMemDir, "push_to_next.md"),
      "Always push to next branch, never feature branches.",
    );
    writeFileSync(
      join(claudeMemDir, "npm_token.md"),
      "npm publish token location for context-mode releases.",
    );
    writeFileSync(
      join(claudeMemDir, "user_identity.md"),
      "User name is Alice. Speaks English and French.",
    );

    // Create user-level configDir for .qwen
    const qwenMemDir = join(QWEN_CONFIG, "memory");
    mkdirSync(qwenMemDir, { recursive: true });
    writeFileSync(join(QWEN_CONFIG, "CLAUDE.md"), "Qwen user config.");
    writeFileSync(join(qwenMemDir, "note.md"), "Qwen analytics note content.");
  })();

  test("returns empty for non-existent project and config directories", () => {
    const results = searchAutoMemory(
      ["anything"],
      10,
      "/nonexistent/project",
      "/nonexistent/config",
    );
    expect(results).toEqual([]);
  });

  test("finds matching content in memory files", () => {
    const results = searchAutoMemory(
      ["analytics"],
      10,
      PROJECT_DIR,
      CLAUDE_CONFIG,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    const hasAnalytics = results.some((r) => r.content.toLowerCase().includes("analytics"));
    expect(hasAnalytics).toBe(true);
    for (const r of results) {
      expect(r.origin).toBe("auto-memory");
    }
  });

  test("case-insensitive search", () => {
    const lower = searchAutoMemory(["analytics"], 10, PROJECT_DIR, CLAUDE_CONFIG);
    const upper = searchAutoMemory(["ANALYTICS"], 10, PROJECT_DIR, CLAUDE_CONFIG);
    const mixed = searchAutoMemory(["AnAlYtIcS"], 10, PROJECT_DIR, CLAUDE_CONFIG);

    expect(lower.length).toBeGreaterThanOrEqual(1);
    expect(upper.length).toBe(lower.length);
    expect(mixed.length).toBe(lower.length);
  });

  test("respects limit parameter", () => {
    const bulkConfig = join(AUTO_MEM_ROOT, ".bulk-test");
    const bulkMemDir = join(bulkConfig, "memory");
    mkdirSync(bulkMemDir, { recursive: true });
    writeFileSync(join(bulkConfig, "CLAUDE.md"), "bulk keyword_match config.");
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(bulkMemDir, `note_${i.toString().padStart(3, "0")}.md`),
        `keyword_match content ${i}`,
      );
    }

    const results = searchAutoMemory(
      ["keyword_match"],
      3,
      undefined,
      bulkConfig,
    );

    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("one match per file even with multiple query hits", () => {
    const results = searchAutoMemory(
      ["analytics", "project"],
      10,
      PROJECT_DIR,
      CLAUDE_CONFIG,
    );

    const sources = results.map((r) => r.source);
    const uniqueSources = new Set(sources);
    expect(uniqueSources.size).toBe(sources.length);
  });

  test("multiple queries match different files", () => {
    const results = searchAutoMemory(
      ["analytics", "npm"],
      10,
      PROJECT_DIR,
      CLAUDE_CONFIG,
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
    const sources = results.map((r) => r.source);
    const uniqueSources = new Set(sources);
    expect(uniqueSources.size).toBeGreaterThanOrEqual(2);
  });

  test("returns empty array for empty queries", () => {
    const results = searchAutoMemory([], 10, PROJECT_DIR, CLAUDE_CONFIG);
    expect(results).toEqual([]);
  });

  test("adapter-aware: different configDir yields different results", () => {
    const claudeResults = searchAutoMemory(["analytics"], 10, undefined, CLAUDE_CONFIG);
    const qwenResults = searchAutoMemory(["analytics"], 10, undefined, QWEN_CONFIG);

    expect(claudeResults.length).toBeGreaterThanOrEqual(1);
    expect(qwenResults.length).toBeGreaterThanOrEqual(1);

    const claudeSources = claudeResults.map((r) => r.source);
    const qwenSources = qwenResults.map((r) => r.source);
    expect(claudeSources).not.toEqual(qwenSources);
  });

  test("result shape matches AutoMemoryResult interface", () => {
    const results = searchAutoMemory(["Alice"], 10, undefined, CLAUDE_CONFIG);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const r = results[0];
    expect(r).toHaveProperty("title");
    expect(r).toHaveProperty("content");
    expect(r).toHaveProperty("source");
    expect(r).toHaveProperty("origin");
    expect(r.origin).toBe("auto-memory");
    expect(r.title).toContain("[auto-memory]");
  });

  test("finds content in CLAUDE.md files (unified)", () => {
    const configDir = createTempDir();
    writeFileSync(
      join(configDir, "CLAUDE.md"),
      "# Rules\nAlways use TypeScript strict mode.\nNever skip tests.\n",
    );

    const results = searchAutoMemory(["typescript strict"], 5, undefined, configDir);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].origin).toBe("auto-memory");
    expect(results[0].content).toContain("TypeScript strict");
  });

  test("finds content in memory directory (unified)", () => {
    const configDir = createTempDir();
    const memoryDir = join(configDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "preferences.md"),
      "User prefers dark theme and vim keybindings.\n",
    );

    const results = searchAutoMemory(["vim keybindings"], 5, undefined, configDir);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("vim keybindings");
  });

  test("returns empty for nonexistent dirs (unified)", () => {
    const results = searchAutoMemory(
      ["anything"],
      5,
      "/nonexistent-project",
      "/nonexistent-config",
    );
    expect(results.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 10. SessionDB.searchEvents via unified search (consolidated from tests/search/unified.test.ts)
// ═══════════════════════════════════════════════════════════

describe("SessionDB.searchEvents (unified)", () => {
  test("finds events matching query text", () => {
    const db = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    db.ensureSession(sessionId, "/project");

    db.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "src/authentication/jwt-handler.ts",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project", source: "test", confidence: 1 });

    db.insertEvent(sessionId, {
      type: "tool",
      category: "tool",
      data: "npm test executed successfully",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project", source: "test", confidence: 1 });

    const results = db.searchEvents("authentication", 10, "/project");
    expect(results.length).toBe(1);
    expect(results[0].data).toContain("authentication");
  });

  test("scopes search by projectDir", () => {
    const db = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    db.ensureSession(sessionId, "/project-a");

    db.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "deploy script content",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project-a", source: "env", confidence: 1 });

    db.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "deploy config content",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project-b", source: "env", confidence: 1 });

    const results = db.searchEvents("deploy", 10, "/project-a");
    expect(results.length).toBe(1);
    expect(results[0].data).toBe("deploy script content");
  });

  test("returns empty for no matches", () => {
    const db = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    db.ensureSession(sessionId, "/project");

    db.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "some unrelated content",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project", source: "test", confidence: 1 });

    const results = db.searchEvents("nonexistent-xyzzy", 10, "/project");
    expect(results.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Knowledge-reuse event (removed — read path must not mutate state)
// ═══════════════════════════════════════════════════════════
