/**
 * extractSnippet — Tests for FTS5 highlight-aware snippet extraction
 *
 * Verifies that extractSnippet uses FTS5 highlight() markers (STX/ETX)
 * to find match positions, falling back to indexOf when markers are
 * absent. Also includes store integration tests confirming that
 * stemmed queries produce populated `highlighted` fields.
 */

import { strict as assert } from "node:assert";
import { extractSnippet, positionsFromHighlight } from "../src/server.js";
import { ContentStore } from "../src/store.js";

const STX = "\x02";
const ETX = "\x03";

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
    console.log(`  ✓ ${name} (${time.toFixed(0)}ms)`);
  } catch (err: any) {
    const time = performance.now() - start;
    failed++;
    results.push({ name, status: "FAIL", time, error: err.message });
    console.log(`  ✗ ${name} (${time.toFixed(0)}ms)`);
    console.log(`    Error: ${err.message}`);
  }
}

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

async function main() {
  console.log("\nContext Mode — extractSnippet Tests");
  console.log("====================================\n");

  // ==============================================================================
  // positionsFromHighlight unit tests
  // ==============================================================================
  console.log("--- positionsFromHighlight ---\n");

  await test("finds single marker position", () => {
    const highlighted = `some text ${STX}match${ETX} more text`;
    const positions = positionsFromHighlight(highlighted);
    assert.deepEqual(positions, [10]);
  });

  await test("finds multiple marker positions", () => {
    // "aa \x02bb\x03 cc \x02dd\x03"
    // clean: "aa bb cc dd"  → positions 3 and 9
    const highlighted = `aa ${STX}bb${ETX} cc ${STX}dd${ETX}`;
    const positions = positionsFromHighlight(highlighted);
    assert.deepEqual(positions, [3, 9]);
  });

  await test("returns empty array when no markers", () => {
    const positions = positionsFromHighlight("no markers here");
    assert.deepEqual(positions, []);
  });

  await test("handles adjacent markers correctly", () => {
    // Two markers right next to each other
    const highlighted = `${STX}first${ETX}${STX}second${ETX}`;
    const positions = positionsFromHighlight(highlighted);
    assert.deepEqual(positions, [0, 5]);
  });

  // ==============================================================================
  // extractSnippet with highlighted parameter
  // ==============================================================================
  console.log("\n--- extractSnippet with highlight markers ---\n");

  await test("returns full content when under maxLen", () => {
    const content = "Short content about connections.";
    const result = extractSnippet(content, "connections");
    assert.equal(result, content);
  });

  await test("prefers highlight-derived positions over indexOf", () => {
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

  await test("multi-term query produces windows from highlight markers", () => {
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

  await test("falls back to indexOf when highlighted is absent", () => {
    const relevant = "The server connect pool handles all requests efficiently.";
    const content = buildContent("Introduction to the system architecture.", relevant);
    const result = extractSnippet(content, "connect");
    assert.ok(
      result.includes("connect pool"),
      `Expected snippet to include "connect pool", got: ${result.slice(0, 200)}`,
    );
  });

  await test("returns prefix when no matches found at all", () => {
    const content = buildContent("Nothing relevant here.", "Still nothing relevant.");
    const result = extractSnippet(content, "xylophone");
    assert.ok(
      result.endsWith("…"),
      `Expected snippet to end with ellipsis (prefix fallback)`,
    );
  });

  await test("short query terms (<=2 chars) are filtered in indexOf fallback", () => {
    const relevant = "The API endpoint returns a JSON response with status codes.";
    const content = buildContent("Filler content about nothing in particular.", relevant);
    const result = extractSnippet(content, "an endpoint");
    assert.ok(
      result.includes("endpoint"),
      `Expected snippet to include "endpoint", got: ${result.slice(0, 200)}`,
    );
  });

  // ==============================================================================
  // Store integration: stemmed queries populate highlighted field
  // ==============================================================================
  console.log("\n--- Store integration: highlighted field ---\n");

  await test("search returns highlighted field with STX/ETX markers", () => {
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

  await test("highlighted markers surround stemmed matches", () => {
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

  await test("searchTrigram returns highlighted field", () => {
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

  await test("extractSnippet with store-produced highlighted finds stemmed region", () => {
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

  // ===== SUMMARY =====
  console.log(`\n====================================`);
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results) {
      if (r.status === "FAIL") console.log(`  ✗ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main();
