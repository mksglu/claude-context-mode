/**
 * ContentStore — FTS5 BM25 Knowledge Base Tests
 *
 * Tests chunking, indexing, search, multi-source, and edge cases
 * using real fixtures from Context7 and MCP tools.
 */

import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ContentStore, cleanupStaleDBs } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");

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
    `context-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return new ContentStore(path);
}

async function main() {
  console.log("\nContext Mode — ContentStore (FTS5 BM25) Tests");
  console.log("==============================================\n");

  // ===== SCHEMA & LIFECYCLE =====
  console.log("--- Schema & Lifecycle ---\n");

  await test("creates store with empty stats", () => {
    const store = createStore();
    const stats = store.getStats();
    assert.equal(stats.sources, 0);
    assert.equal(stats.chunks, 0);
    assert.equal(stats.codeChunks, 0);
    store.close();
  });

  await test("close is idempotent", () => {
    const store = createStore();
    store.close();
    // second close should not throw
    assert.doesNotThrow(() => store.close());
  });

  // ===== BASIC INDEXING =====
  console.log("\n--- Basic Indexing ---\n");

  await test("index simple markdown content", () => {
    const store = createStore();
    const result = store.index({
      content: "# Hello\n\nThis is a test document.",
      source: "test-doc",
    });
    assert.equal(result.label, "test-doc");
    assert.equal(result.totalChunks, 1);
    assert.equal(result.codeChunks, 0);
    assert.ok(result.sourceId > 0);
    store.close();
  });

  await test("index content with code blocks", () => {
    const store = createStore();
    const result = store.index({
      content:
        "# API Guide\n\n```javascript\nconsole.log('hello');\n```\n\n## Usage\n\nSome text.",
      source: "api-guide",
    });
    assert.ok(result.totalChunks >= 1);
    assert.ok(result.codeChunks >= 1, "Should detect code chunks");
    store.close();
  });

  await test("index empty content throws (falsy content requires path)", () => {
    const store = createStore();
    // Empty string is falsy — same as not providing content
    assert.throws(() => store.index({ content: "", source: "empty" }), /Either content or path/);
    store.close();
  });

  await test("index whitespace-only content returns 0 chunks", () => {
    const store = createStore();
    const result = store.index({
      content: "   \n\n   \n",
      source: "whitespace",
    });
    assert.equal(result.totalChunks, 0);
    store.close();
  });

  await test("index from file path", () => {
    const store = createStore();
    const result = store.index({
      path: join(fixtureDir, "context7-react-docs.md"),
      source: "Context7: React useEffect",
    });
    assert.ok(result.totalChunks > 0, "Should chunk the fixture");
    assert.ok(result.codeChunks > 0, "React docs have code blocks");
    assert.equal(result.label, "Context7: React useEffect");
    store.close();
  });

  await test("index throws when neither content nor path provided", () => {
    const store = createStore();
    assert.throws(() => store.index({}), /Either content or path/);
    store.close();
  });

  await test("stats update after indexing", () => {
    const store = createStore();
    store.index({
      content: "# Title\n\nSome content.\n\n## Section\n\nMore content.",
      source: "doc-1",
    });
    const stats = store.getStats();
    assert.ok(stats.sources >= 1);
    assert.ok(stats.chunks >= 1);
    store.close();
  });

  // ===== CHUNKING =====
  console.log("\n--- Heading-Aware Chunking ---\n");

  await test("splits on H1-H4 headings", () => {
    const store = createStore();
    const result = store.index({
      content:
        "# H1\n\nContent 1\n\n## H2\n\nContent 2\n\n### H3\n\nContent 3\n\n#### H4\n\nContent 4",
      source: "headings",
    });
    assert.equal(result.totalChunks, 4, "Should split into 4 chunks");
    store.close();
  });

  await test("splits on --- separators (Context7 format)", () => {
    const store = createStore();
    const result = store.index({
      content:
        "### Section A\n\nContent A\n\n---\n\n### Section B\n\nContent B\n\n---\n\n### Section C\n\nContent C",
      source: "context7-style",
    });
    assert.equal(result.totalChunks, 3, "Should split on --- separators");
    store.close();
  });

  await test("keeps code blocks intact (never split mid-block)", () => {
    const store = createStore();
    const result = store.index({
      content:
        '# Example\n\n```javascript\nfunction hello() {\n  console.log("world");\n}\nhello();\n```\n\nMore text after code.',
      source: "code-intact",
    });
    assert.equal(result.totalChunks, 1, "Code block stays with heading");

    // Search should return the complete code block
    const results = store.search("hello function", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].content.includes("console.log"),
      "Code block should be intact",
    );
    assert.ok(
      results[0].content.includes("hello()"),
      "Full code block preserved",
    );
    store.close();
  });

  await test("tracks heading hierarchy in titles", () => {
    const store = createStore();
    store.index({
      content:
        "# React\n\n## Hooks\n\n### useEffect\n\nEffect documentation here.",
      source: "hierarchy",
    });
    const results = store.search("Effect documentation", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].title.includes("React"),
      `Title should include H1, got: ${results[0].title}`,
    );
    assert.ok(
      results[0].title.includes("Hooks"),
      `Title should include H2, got: ${results[0].title}`,
    );
    assert.ok(
      results[0].title.includes("useEffect"),
      `Title should include H3, got: ${results[0].title}`,
    );
    store.close();
  });

  await test("marks chunks with code as 'code' contentType", () => {
    const store = createStore();
    store.index({
      content:
        "# Prose\n\nJust text.\n\n# Code\n\n```python\nprint('hello')\n```",
      source: "mixed",
    });

    const proseResults = store.search("Just text", 1);
    assert.ok(proseResults.length > 0);
    assert.equal(proseResults[0].contentType, "prose");

    const codeResults = store.search("python print hello", 1);
    assert.ok(codeResults.length > 0);
    assert.equal(codeResults[0].contentType, "code");

    store.close();
  });

  // ===== BM25 SEARCH =====
  console.log("\n--- BM25 Search ---\n");

  await test("basic keyword search returns results", () => {
    const store = createStore();
    store.index({
      content:
        "# Authentication\n\nUse JWT tokens for API auth.\n\n# Caching\n\nRedis for session caching.",
      source: "docs",
    });
    const results = store.search("JWT authentication", 2);
    assert.ok(results.length > 0, "Should find results");
    assert.ok(
      results[0].content.includes("JWT"),
      "First result should be about JWT",
    );
    store.close();
  });

  await test("title match weighted higher than content match", () => {
    const store = createStore();
    store.index({
      content:
        "# useEffect\n\nThe effect hook.\n\n# useState\n\nuseEffect is mentioned here in passing.",
      source: "hooks",
    });
    const results = store.search("useEffect", 2);
    assert.ok(results.length >= 1);
    // The chunk with useEffect in the TITLE should rank first
    assert.ok(
      results[0].title.includes("useEffect"),
      `Title match should rank first, got title: ${results[0].title}`,
    );
    store.close();
  });

  await test("porter stemming matches word variants", () => {
    const store = createStore();
    store.index({
      content:
        "# Connecting\n\nEstablish connections to the database.\n\n# Caching\n\nCache your responses.",
      source: "stemming",
    });
    // "connect" should match "connecting" and "connections"
    const results = store.search("connect", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].content.includes("connections") ||
        results[0].title.includes("Connecting"),
      "Stemming should match variants",
    );
    store.close();
  });

  await test("search with no results returns empty array", () => {
    const store = createStore();
    store.index({
      content: "# React\n\nComponent lifecycle.",
      source: "react",
    });
    const results = store.search("kubernetes deployment yaml", 3);
    assert.equal(results.length, 0, "Should return empty for irrelevant query");
    store.close();
  });

  await test("limit parameter controls result count", () => {
    const store = createStore();
    store.index({
      content:
        "# A\n\nApple.\n\n# B\n\nBanana.\n\n# C\n\nCherry.\n\n# D\n\nDate.",
      source: "fruits",
    });
    const results1 = store.search("fruit", 1);
    assert.ok(results1.length <= 1);

    const results3 = store.search("fruit", 10);
    // May return less if not all match
    assert.ok(results3.length >= 0);
    store.close();
  });

  await test("results include source label", () => {
    const store = createStore();
    store.index({
      content: "# Setup\n\nInstall the package.",
      source: "Context7: React docs",
    });
    const results = store.search("Install package", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: React docs");
    store.close();
  });

  await test("results include rank score", () => {
    const store = createStore();
    store.index({
      content: "# Test\n\nSome test content here.",
      source: "ranked",
    });
    const results = store.search("test content", 1);
    assert.ok(results.length > 0);
    assert.equal(typeof results[0].rank, "number");
    store.close();
  });

  // ===== MULTI-SOURCE =====
  console.log("\n--- Multi-Source Indexing ---\n");

  await test("search across multiple indexed sources", () => {
    const store = createStore();
    store.index({
      content: "# React Hooks\n\nuseEffect for side effects.",
      source: "Context7: React",
    });
    store.index({
      content: "# Supabase Auth\n\nRow Level Security policies.",
      source: "Context7: Supabase",
    });
    store.index({
      content: "# Tailwind\n\nResponsive breakpoints with sm, md, lg.",
      source: "Context7: Tailwind",
    });

    const reactResults = store.search("useEffect", 1);
    assert.ok(reactResults.length > 0);
    assert.equal(reactResults[0].source, "Context7: React");

    const supaResults = store.search("Row Level Security", 1);
    assert.ok(supaResults.length > 0);
    assert.equal(supaResults[0].source, "Context7: Supabase");

    const twResults = store.search("responsive breakpoints", 1);
    assert.ok(twResults.length > 0);
    assert.equal(twResults[0].source, "Context7: Tailwind");

    const stats = store.getStats();
    assert.equal(stats.sources, 3);
    store.close();
  });

  await test("same source can be indexed multiple times", () => {
    const store = createStore();
    store.index({
      content: "# Part 1\n\nFirst batch.",
      source: "incremental",
    });
    store.index({
      content: "# Part 2\n\nSecond batch.",
      source: "incremental",
    });
    const stats = store.getStats();
    assert.equal(stats.sources, 2, "Each index call creates new source entry");
    assert.ok(stats.chunks >= 2);
    store.close();
  });

  // ===== FIXTURE-BASED TESTS =====
  console.log("\n--- Fixture-Based Tests (Real MCP Output) ---\n");

  await test("Context7 React docs: index and search code examples", () => {
    const store = createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-react-docs.md"),
      "utf-8",
    );
    const result = store.index({
      content,
      source: "Context7: React useEffect",
    });
    assert.ok(result.totalChunks >= 3, `Expected >=3 chunks, got ${result.totalChunks}`);
    assert.ok(result.codeChunks >= 1, "Should detect code chunks");

    // Search for specific code patterns
    const cleanup = store.search("cleanup function disconnect", 2);
    assert.ok(cleanup.length > 0, "Should find cleanup pattern");
    assert.ok(
      cleanup[0].content.includes("disconnect"),
      "Should contain exact disconnect code",
    );

    // Search for fetch pattern
    const fetch = store.search("fetch data ignore stale", 2);
    assert.ok(fetch.length > 0, "Should find fetch pattern");
    assert.ok(
      fetch[0].content.includes("ignore"),
      "Should contain ignore flag pattern",
    );

    store.close();
  });

  await test("Context7 Next.js docs: index and search", () => {
    const store = createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-nextjs-docs.md"),
      "utf-8",
    );
    const result = store.index({
      content,
      source: "Context7: Next.js App Router",
    });
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);

    // Search should return relevant content
    const results = store.search("App Router", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: Next.js App Router");
    store.close();
  });

  await test("Context7 Tailwind docs: index and search", () => {
    const store = createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-tailwind-docs.md"),
      "utf-8",
    );
    const result = store.index({
      content,
      source: "Context7: Tailwind CSS",
    });
    assert.ok(result.totalChunks >= 1);

    const results = store.search("Tailwind", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: Tailwind CSS");
    store.close();
  });

  await test("MCP tools JSON: index and search tool signatures", () => {
    const store = createStore();
    // Convert JSON to searchable markdown format
    const raw = readFileSync(join(fixtureDir, "mcp-tools.json"), "utf-8");
    const tools = JSON.parse(raw);

    const markdown = tools
      .map(
        (t: { name: string; description: string }) =>
          `### ${t.name}\n\n${t.description}`,
      )
      .join("\n\n---\n\n");

    const result = store.index({
      content: markdown,
      source: "MCP: tools/list",
    });
    assert.ok(
      result.totalChunks >= 5,
      `Expected >=5 chunks for 40 tools, got ${result.totalChunks}`,
    );
    store.close();
  });

  // ===== QUERY SANITIZATION =====
  console.log("\n--- Query Sanitization ---\n");

  await test("handles special FTS5 characters in query", () => {
    const store = createStore();
    store.index({
      content: "# Test\n\nSome content here.",
      source: "sanitize",
    });
    // These should not throw FTS5 parse errors
    assert.doesNotThrow(() => store.search('test "quoted"', 1));
    assert.doesNotThrow(() => store.search("test AND OR NOT", 1));
    assert.doesNotThrow(() => store.search("test()", 1));
    assert.doesNotThrow(() => store.search("test*", 1));
    assert.doesNotThrow(() => store.search("test:value", 1));
    assert.doesNotThrow(() => store.search("test^2", 1));
    assert.doesNotThrow(() => store.search("{test}", 1));
    assert.doesNotThrow(() => store.search("NEAR/3", 1));
    store.close();
  });

  await test("empty query returns empty results", () => {
    const store = createStore();
    store.index({
      content: "# Doc\n\nContent.",
      source: "empty-q",
    });
    const results = store.search("", 3);
    assert.equal(results.length, 0, "Empty query should return no results");
    store.close();
  });

  // ===== EDGE CASES =====
  console.log("\n--- Edge Cases ---\n");

  await test("content with no headings creates single chunk", () => {
    const store = createStore();
    const result = store.index({
      content: "Just plain text without any markdown headings.",
      source: "plain",
    });
    assert.equal(result.totalChunks, 1);
    store.close();
  });

  await test("nested code blocks (triple backtick inside fenced)", () => {
    const store = createStore();
    const content =
      '# Example\n\n````markdown\n```javascript\nconsole.log("nested");\n```\n````';
    const result = store.index({ content, source: "nested" });
    assert.ok(result.totalChunks >= 1);
    assert.ok(result.codeChunks >= 1);

    const results = store.search("nested console", 1);
    assert.ok(results.length > 0);
    assert.ok(results[0].content.includes("nested"), "Nested code preserved");
    store.close();
  });

  await test("very long content chunks correctly", () => {
    const store = createStore();
    const sections = Array.from(
      { length: 20 },
      (_, i) => `## Section ${i}\n\nContent for section ${i}.\n`,
    ).join("\n");
    const result = store.index({
      content: sections,
      source: "long-doc",
    });
    assert.equal(
      result.totalChunks,
      20,
      `Expected 20 chunks, got ${result.totalChunks}`,
    );
    store.close();
  });

  await test("heading-only content (no body) still creates chunk", () => {
    const store = createStore();
    const result = store.index({
      content: "# Title Only\n\n## Another Heading",
      source: "headings-only",
    });
    // The heading lines themselves are content
    assert.ok(result.totalChunks >= 1);
    store.close();
  });

  // ===== SOURCE-SCOPED SEARCH =====
  console.log("\n--- Source-Scoped Search ---\n");

  await test("search with source filter returns only matching source", () => {
    const store = createStore();
    store.index({
      content: "# Zod Transform\n\nUse .transform() to map values.\n\n## Refine\n\nUse .refine() for custom validation.",
      source: "Zod API docs",
    });
    store.index({
      content: "# Security Release\n\nCVE-2025-1234: Fixed transform injection vulnerability.\n\n## Fixes\n\nRefine permission checks.",
      source: "Node.js v22 CHANGELOG",
    });

    // Without source filter — both sources may match
    const allResults = store.search("transform refine", 5);
    assert.ok(allResults.length >= 2, "Should find results from both sources");

    // With source filter — only Zod
    const zodResults = store.search("transform refine", 5, "Zod");
    assert.ok(zodResults.length > 0, "Should find Zod results");
    assert.ok(
      zodResults.every((r) => r.source.includes("Zod")),
      `All results should be from Zod, got: ${zodResults.map((r) => r.source).join(", ")}`,
    );

    // With source filter — only Node.js
    const nodeResults = store.search("transform refine", 5, "Node.js");
    assert.ok(nodeResults.length > 0, "Should find Node.js results");
    assert.ok(
      nodeResults.every((r) => r.source.includes("Node.js")),
      `All results should be from Node.js, got: ${nodeResults.map((r) => r.source).join(", ")}`,
    );

    store.close();
  });

  await test("search with non-matching source returns empty", () => {
    const store = createStore();
    store.index({
      content: "# React Hooks\n\nuseEffect for side effects.",
      source: "React docs",
    });
    const results = store.search("useEffect", 3, "Vue");
    assert.equal(results.length, 0, "Should return empty for non-matching source");
    store.close();
  });

  await test("listSources returns all indexed sources", () => {
    const store = createStore();
    store.index({ content: "# A\n\nContent A.", source: "Source A" });
    store.index({ content: "# B\n\nContent B.", source: "Source B" });
    store.index({ content: "# C\n\nContent C.", source: "Source C" });

    const sources = store.listSources();
    assert.equal(sources.length, 3, `Expected 3 sources, got ${sources.length}`);
    const labels = sources.map((s) => s.label);
    assert.ok(labels.includes("Source A"));
    assert.ok(labels.includes("Source B"));
    assert.ok(labels.includes("Source C"));
    assert.ok(sources.every((s) => s.chunkCount >= 1));
    store.close();
  });

  await test("source filter uses partial match (LIKE)", () => {
    const store = createStore();
    store.index({ content: "# Config\n\nDatabase config.", source: "Node.js v22 CHANGELOG" });
    store.index({ content: "# Config\n\nApp config.", source: "Zod API docs" });

    // Partial match "v22" should match "Node.js v22 CHANGELOG"
    const results = store.search("config", 5, "v22");
    assert.ok(results.length > 0, "Partial source match should work");
    assert.ok(
      results.every((r) => r.source.includes("v22")),
      "Should only return v22 source",
    );
    store.close();
  });

  // ===== CONTEXT SAVINGS =====
  console.log("\n--- Context Savings Measurement ---\n");

  await test("index+search uses less context than raw content", () => {
    const store = createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-react-docs.md"),
      "utf-8",
    );
    const rawBytes = Buffer.byteLength(content);

    store.index({ content, source: "React docs" });

    // Search returns only relevant chunk, not full doc
    const results = store.search("useEffect cleanup", 1);
    assert.ok(results.length > 0);

    const resultBytes = Buffer.byteLength(
      results.map((r) => `${r.title}\n${r.content}`).join("\n"),
    );
    const savings = ((1 - resultBytes / rawBytes) * 100).toFixed(0);
    console.log(
      `    Raw: ${(rawBytes / 1024).toFixed(1)}KB → Search result: ${resultBytes}B (${savings}% saved)`,
    );
    assert.ok(
      resultBytes < rawBytes,
      "Search result should be smaller than full doc",
    );
    store.close();
  });

  // ===== PLAIN TEXT INDEXING =====
  console.log("\n--- Plain Text Indexing ---\n");

  await test("indexPlainText: chunks by line groups", () => {
    const store = createStore();
    const lines = Array.from({ length: 100 }, (_, i) => `Log line ${i + 1}: processing request`).join("\n");
    const result = store.indexPlainText(lines, "build-output");
    assert.ok(result.totalChunks >= 5, `Expected >=5 chunks for 100 lines with 20-line groups, got ${result.totalChunks}`);
    assert.equal(result.label, "build-output");
    assert.equal(result.codeChunks, 0);
    store.close();
  });

  await test("indexPlainText: single chunk for small output", () => {
    const store = createStore();
    const content = "Line 1\nLine 2\nLine 3";
    const result = store.indexPlainText(content, "small-output");
    assert.equal(result.totalChunks, 1, `Expected 1 chunk for 3 lines, got ${result.totalChunks}`);
    assert.equal(result.label, "small-output");
    store.close();
  });

  await test("indexPlainText: blank-line splitting for sectioned output", () => {
    const store = createStore();
    const content = [
      "Section A line 1\nSection A line 2",
      "Section B line 1\nSection B line 2",
      "Section C line 1\nSection C line 2",
    ].join("\n\n");
    const result = store.indexPlainText(content, "sectioned-output");
    assert.equal(result.totalChunks, 3, `Expected 3 chunks for 3 blank-line-separated sections, got ${result.totalChunks}`);
    store.close();
  });

  await test("indexPlainText: searchable after indexing", () => {
    const store = createStore();
    const lines = Array.from({ length: 200 }, (_, i) => {
      if (i === 149) return "ERROR: connection refused to database host";
      return `[INFO] ${i + 1}: normal operation continued`;
    }).join("\n");
    store.indexPlainText(lines, "server-logs");
    const results = store.search("connection refused", 3);
    assert.ok(results.length > 0, "Should find the error line via search");
    assert.ok(
      results[0].content.includes("connection refused"),
      `Result should contain 'connection refused', got: ${results[0].content.slice(0, 100)}`,
    );
    store.close();
  });

  await test("indexPlainText: empty content returns 0 chunks", () => {
    const store = createStore();
    const result = store.indexPlainText("", "empty-output");
    assert.equal(result.totalChunks, 0, "Empty content should produce 0 chunks");
    assert.equal(result.label, "empty-output");
    store.close();
  });

  await test("indexPlainText: in-memory store works", () => {
    const store = new ContentStore(":memory:");
    const content = "Line 1\nLine 2\nLine 3";
    const result = store.indexPlainText(content, "memory-test");
    assert.equal(result.totalChunks, 1);
    assert.equal(result.label, "memory-test");

    const searchResults = store.search("Line 1", 1);
    assert.ok(searchResults.length > 0, "In-memory store should support search");
    assert.ok(searchResults[0].content.includes("Line 1"));
    store.close();
  });

  // ===== DISTINCTIVE TERMS =====
  console.log("\n--- getDistinctiveTerms ---\n");

  await test("getDistinctiveTerms: returns terms in moderate frequency range", () => {
    const store = createStore();
    // Create content with 10 sections. A distinctive term appears in 3-4 sections
    // (i.e., >= 2 and <= 40% of 10 = 4).
    const sections = Array.from({ length: 10 }, (_, i) => {
      const base = `## Section ${i}\n\nGeneric content for section number ${i}.`;
      if (i < 3) return `${base}\n\nThe authentication middleware validates tokens.`;
      if (i < 5) return `${base}\n\nThe database connection pool handles queries.`;
      return `${base}\n\nPlain filler paragraph without special keywords.`;
    }).join("\n\n");
    const result = store.indexPlainText(sections, "distinctive-moderate");
    const terms = store.getDistinctiveTerms(result.sourceId);
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should return some distinctive terms, got ${terms.length}`);
    // "authentication" appears in 3/10 sections — should be distinctive
    assert.ok(
      terms.includes("authentication"),
      `Expected 'authentication' in distinctive terms, got: ${terms.join(", ")}`,
    );
    store.close();
  });

  await test("getDistinctiveTerms: returns empty for too few sections", () => {
    const store = createStore();
    // Only 2 sections — below the chunk_count < 3 threshold
    const content = "Section A content here.\n\nSection B content here.";
    const result = store.indexPlainText(content, "too-few-sections");
    assert.ok(result.totalChunks <= 2, `Expected <=2 chunks, got ${result.totalChunks}`);
    const terms = store.getDistinctiveTerms(result.sourceId);
    assert.deepEqual(terms, [], "Should return empty array for fewer than 3 chunks");
    store.close();
  });

  await test("getDistinctiveTerms: excludes stopwords", () => {
    const store = createStore();
    // Create 5 sections where stopwords "the", "this", "that", "with" appear in every section.
    // "encryption" appears in 2 sections (moderate frequency).
    const sections = Array.from({ length: 5 }, (_, i) => {
      const base = `## Part ${i}\n\nThis is the content that comes with part number ${i}.`;
      if (i < 2) return `${base}\n\nEncryption algorithms protect the data.`;
      return base;
    }).join("\n\n");
    const result = store.indexPlainText(sections, "stopwords-test");
    const terms = store.getDistinctiveTerms(result.sourceId);
    // Stopwords should never appear
    const stopwords = ["the", "this", "that", "with", "for", "and"];
    for (const sw of stopwords) {
      assert.ok(
        !terms.includes(sw),
        `Stopword '${sw}' should not be in distinctive terms`,
      );
    }
    // "encryption" appears in 2/5 sections — should qualify
    assert.ok(
      terms.includes("encryption"),
      `Expected 'encryption' in terms, got: ${terms.join(", ")}`,
    );
    store.close();
  });

  // ===== SMART CHUNK TITLES =====
  console.log("\n--- Smart Chunk Titles ---\n");

  await test("smart chunk titles: blank-line split uses first line as title", () => {
    const store = createStore();
    // 4 blank-line-separated sections with meaningful first lines
    const content = [
      "v2.3.0 - Performance improvements\nFixed memory leak in connection pool\nReduced startup time by 40%",
      "v2.2.1 - Security patch\nPatched XSS vulnerability in template engine\nUpdated dependencies",
      "v2.2.0 - New features\nAdded WebSocket support\nNew configuration API",
      "v2.1.0 - Bug fixes\nFixed race condition in worker threads\nImproved error messages",
    ].join("\n\n");
    store.indexPlainText(content, "changelog-sections");

    // Search for a term in the first section
    const results = store.search("memory leak connection pool", 1);
    assert.ok(results.length > 0, "Should find the section");
    assert.ok(
      results[0].title.startsWith("v2.3.0"),
      `Title should be first line 'v2.3.0 - Performance improvements', got: '${results[0].title}'`,
    );
    // Should NOT be a generic "Section N" title
    assert.ok(
      !results[0].title.startsWith("Section"),
      `Title should not be generic 'Section N', got: '${results[0].title}'`,
    );

    // Verify another section too
    const results2 = store.search("XSS vulnerability template", 1);
    assert.ok(results2.length > 0, "Should find second section");
    assert.ok(
      results2[0].title.startsWith("v2.2.1"),
      `Title should be 'v2.2.1 - Security patch', got: '${results2[0].title}'`,
    );
    store.close();
  });

  await test("smart chunk titles: line-group chunks use first line as title", () => {
    const store = createStore();
    // Create enough lines (>20) to trigger line-group chunking (not blank-line splitting)
    // by making it a single block of lines with no blank-line sections
    const lines = Array.from({ length: 60 }, (_, i) => {
      if (i === 0) return "ERROR: Failed to compile module 'auth-service'";
      if (i === 20) return "WARNING: Deprecated API usage in routes/v2.ts";
      if (i === 40) return "INFO: Build completed with 2 warnings";
      return `[LOG] Step ${i}: processing task ${i}`;
    });
    const content = lines.join("\n");
    store.indexPlainText(content, "build-log");

    // Search for content in the first chunk
    const results = store.search("Failed compile auth-service", 1);
    assert.ok(results.length > 0, "Should find the first chunk");
    assert.ok(
      results[0].title.includes("ERROR"),
      `Title should be first line of chunk containing 'ERROR', got: '${results[0].title}'`,
    );
    // Should NOT be a generic "Lines N-M" title
    assert.ok(
      !results[0].title.startsWith("Lines"),
      `Title should not be generic 'Lines N-M', got: '${results[0].title}'`,
    );
    store.close();
  });

  // ===== DB CLEANUP =====
  console.log("\n--- DB Cleanup ---\n");

  await test("cleanupStaleDBs removes files for dead PIDs", () => {
    const fakePid = 99999;
    const fakePath = join(tmpdir(), `context-mode-${fakePid}.db`);
    writeFileSync(fakePath, "fake");
    writeFileSync(fakePath + "-wal", "fake");
    writeFileSync(fakePath + "-shm", "fake");

    const cleaned = cleanupStaleDBs();
    assert.ok(cleaned >= 1, `Should clean at least 1 file, cleaned ${cleaned}`);
    assert.ok(!existsSync(fakePath), "DB file should be removed");
    assert.ok(!existsSync(fakePath + "-wal"), "WAL file should be removed");
    assert.ok(!existsSync(fakePath + "-shm"), "SHM file should be removed");
  });

  await test("cleanupStaleDBs does not remove current process DB", () => {
    const myPath = join(tmpdir(), `context-mode-${process.pid}.db`);
    writeFileSync(myPath, "current");

    cleanupStaleDBs();
    assert.ok(existsSync(myPath), "Current process DB should NOT be removed");

    // Clean up manually
    try { require("fs").unlinkSync(myPath); } catch {}
  });

  await test("store.cleanup() removes own DB and WAL/SHM files", () => {
    const store = createStore();
    // Index something to generate WAL activity
    store.index({ content: "# Test\n\nCleanup test content.", source: "cleanup-test" });

    // Get the DB path by creating a known-path store
    const knownPath = join(tmpdir(), `context-mode-cleanup-test-${Date.now()}.db`);
    const knownStore = new ContentStore(knownPath);
    knownStore.index({ content: "# Data\n\nSome data.", source: "known" });

    assert.ok(existsSync(knownPath), "DB should exist before cleanup");

    knownStore.cleanup();
    assert.ok(!existsSync(knownPath), "DB should be removed after cleanup");
    assert.ok(!existsSync(knownPath + "-wal"), "WAL should be removed after cleanup");
    assert.ok(!existsSync(knownPath + "-shm"), "SHM should be removed after cleanup");

    store.close();
  });

  await test("store.cleanup() is safe to call multiple times", () => {
    const path = join(tmpdir(), `context-mode-cleanup-idempotent-${Date.now()}.db`);
    const store = new ContentStore(path);
    store.cleanup();
    // Second call should not throw
    assert.doesNotThrow(() => store.cleanup());
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
  console.error("Store test runner error:", err);
  process.exit(1);
});
