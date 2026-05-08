/**
 * ContentStore — FTS5 BM25 Knowledge Base Tests
 *
 * Tests chunking, indexing, search, multi-source, and edge cases
 * using real fixtures from Context7 and MCP tools.
 */

import { describe, test, expect } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ContentStore, cleanupStaleDBs } from "../src/store.js";
import {
  withRetry,
  closeDB,
  loadDatabase,
  applyWALPragmas,
  nodeSqliteHasFts5,
} from "../src/db-base.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");

function createStore(): ContentStore {
  const path = join(
    tmpdir(),
    `context-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return new ContentStore(path);
}

describe("Schema & Lifecycle", () => {
  test("creates store with empty stats", () => {
    const store = createStore();
    const stats = store.getStats();
    assert.equal(stats.sources, 0);
    assert.equal(stats.chunks, 0);
    assert.equal(stats.codeChunks, 0);
    store.close();
  });

  test("close is idempotent", () => {
    const store = createStore();
    store.close();
    // second close should not throw
    assert.doesNotThrow(() => store.close());
  });

  test("Fresh DB creates new FTS5 schema with 8 columns", () => {
    const dbPath = join(
      tmpdir(),
      `context-mode-test-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const store = new ContentStore(dbPath);

    // Verify the schema by opening the raw DB and checking columns
    const Database = loadDatabase();
    const db = new Database(dbPath, { readonly: true });
    const cols = db.prepare("SELECT name FROM pragma_table_xinfo('chunks')").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);

    // FTS5 tables should have 8 user columns + 2 hidden (table-name, rank) = 10 total
    // pragma_table_xinfo includes hidden FTS5 internal columns
    expect(colNames).toContain("title");
    expect(colNames).toContain("content");
    expect(colNames).toContain("source_id");
    expect(colNames).toContain("content_type");
    expect(colNames).toContain("source_category");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("event_id");
    expect(colNames).toContain("timestamp");
    // 8 user-defined + 2 hidden FTS5 internal (chunks, rank)
    expect(colNames.length).toBe(10);

    // Same check for trigram table
    const trigramCols = db.prepare("SELECT name FROM pragma_table_xinfo('chunks_trigram')").all() as Array<{ name: string }>;
    const trigramColNames = trigramCols.map(c => c.name);
    expect(trigramColNames).toContain("source_category");
    expect(trigramColNames).toContain("session_id");
    expect(trigramColNames).toContain("event_id");
    expect(trigramColNames).toContain("timestamp");
    expect(trigramColNames.length).toBe(10);

    db.close();
    store.close();

    // Cleanup
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  test("Old schema detected and migrated to new schema", () => {
    const dbPath = join(
      tmpdir(),
      `context-mode-test-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    // Step 1: Create a DB with the OLD schema (4-column FTS5)
    const Database = loadDatabase();
    const rawDb = new Database(dbPath);
    applyWALPragmas(rawDb);
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_path TEXT,
        content_hash TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );
      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);

    // Insert a row into old schema to confirm data is present
    rawDb.exec("INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES ('old-source', 1, 0)");
    rawDb.exec("INSERT INTO chunks (title, content, source_id, content_type) VALUES ('old title', 'old content', 1, 'prose')");
    rawDb.exec("INSERT INTO chunks_trigram (title, content, source_id, content_type) VALUES ('old title', 'old content', 1, 'prose')");

    // Verify old schema has only 4 user columns (+ 2 hidden FTS5 = 6 total)
    const oldCols = rawDb.prepare("SELECT name FROM pragma_table_xinfo('chunks')").all() as Array<{ name: string }>;
    expect(oldCols.length).toBe(6);
    expect(oldCols.map(c => c.name)).not.toContain("source_category");

    rawDb.close();

    // Step 2: Open with ContentStore — migration should trigger
    const store = new ContentStore(dbPath);

    // Step 3: Verify migration happened — new columns exist
    const checkDb = new Database(dbPath, { readonly: true });
    const newCols = checkDb.prepare("SELECT name FROM pragma_table_xinfo('chunks')").all() as Array<{ name: string }>;
    const newColNames = newCols.map(c => c.name);
    expect(newColNames).toContain("source_category");
    expect(newColNames).toContain("session_id");
    expect(newColNames).toContain("event_id");
    expect(newColNames).toContain("timestamp");
    expect(newColNames.length).toBe(10);

    const newTrigramCols = checkDb.prepare("SELECT name FROM pragma_table_xinfo('chunks_trigram')").all() as Array<{ name: string }>;
    expect(newTrigramCols.map(c => c.name)).toContain("source_category");
    expect(newTrigramCols.length).toBe(10);

    // Old chunk data is gone (DROP + re-CREATE clears data)
    const chunkCount = checkDb.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
    expect(chunkCount.cnt).toBe(0);

    // Sources table still intact (not dropped)
    const sourceCount = checkDb.prepare("SELECT COUNT(*) as cnt FROM sources").get() as { cnt: number };
    expect(sourceCount.cnt).toBe(1);

    // Store still functional — can index new content
    const result = store.index({ content: "# Test\n\nNew content after migration.", source: "post-migration" });
    expect(result.totalChunks).toBeGreaterThan(0);

    checkDb.close();
    store.close();

    // Cleanup
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });
});

describe("Basic Indexing", () => {
  test("index simple markdown content", () => {
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

  test("index content with code blocks", () => {
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

  test("index empty content throws (falsy content requires path)", () => {
    const store = createStore();
    // Empty string is falsy — same as not providing content
    assert.throws(() => store.index({ content: "", source: "empty" }), /Either content or path/);
    store.close();
  });

  test("index whitespace-only content returns 0 chunks", () => {
    const store = createStore();
    const result = store.index({
      content: "   \n\n   \n",
      source: "whitespace",
    });
    assert.equal(result.totalChunks, 0);
    store.close();
  });

  test("index from file path", () => {
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

  test("index throws when neither content nor path provided", () => {
    const store = createStore();
    assert.throws(() => store.index({}), /Either content or path/);
    store.close();
  });

  test("index reads file when content is empty string and path is provided (regression #350)", () => {
    // Some MCP clients send `content: ""` together with `path`. The previous
    // implementation used `content ?? readFileSync(path)` which kept the empty
    // string and indexed 0 chunks. Empty content + a valid path must fall
    // back to reading the file.
    const store = createStore();
    const result = store.index({
      content: "",
      path: join(fixtureDir, "context7-react-docs.md"),
      source: "Context7: empty-content path repro",
    });
    assert.ok(result.totalChunks > 0, "Should chunk the fixture from path even when content is empty string");
    assert.ok(result.codeChunks > 0, "React docs have code blocks");
    assert.equal(result.label, "Context7: empty-content path repro");
    store.close();
  });

  test("stats update after indexing", () => {
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
});

describe("Heading-Aware Chunking", () => {
  test("splits on H1-H4 headings", () => {
    const store = createStore();
    const result = store.index({
      content:
        "# H1\n\nContent 1\n\n## H2\n\nContent 2\n\n### H3\n\nContent 3\n\n#### H4\n\nContent 4",
      source: "headings",
    });
    assert.equal(result.totalChunks, 4, "Should split into 4 chunks");
    store.close();
  });

  test("splits on --- separators (Context7 format)", () => {
    const store = createStore();
    const result = store.index({
      content:
        "### Section A\n\nContent A\n\n---\n\n### Section B\n\nContent B\n\n---\n\n### Section C\n\nContent C",
      source: "context7-style",
    });
    assert.equal(result.totalChunks, 3, "Should split on --- separators");
    store.close();
  });

  test("keeps code blocks intact (never split mid-block)", () => {
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

  test("tracks heading hierarchy in titles", () => {
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

  test("marks chunks with code as 'code' contentType", () => {
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
});

describe("BM25 Search", () => {
  test("basic keyword search returns results", () => {
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

  test("title match weighted higher than content match", () => {
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

  test("porter stemming matches word variants", () => {
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

  test("search with no results returns empty array", () => {
    const store = createStore();
    store.index({
      content: "# React\n\nComponent lifecycle.",
      source: "react",
    });
    const results = store.search("kubernetes deployment yaml", 3);
    assert.equal(results.length, 0, "Should return empty for irrelevant query");
    store.close();
  });

  test("limit parameter controls result count", () => {
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

  test("results include source label", () => {
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

  test("results include rank score", () => {
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
});

describe("Multi-Source Indexing", () => {
  test("search across multiple indexed sources", () => {
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

  test("re-indexing same source replaces previous entry (dedup)", () => {
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
    assert.equal(stats.sources, 1, "Dedup replaces previous source with same label");
    assert.ok(stats.chunks >= 1);
    store.close();
  });
});

describe("Fixture-Based Tests (Real MCP Output)", () => {
  test("Context7 React docs: index and search code examples", () => {
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

  test("Context7 Next.js docs: index and search", () => {
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

  test("Context7 Tailwind docs: index and search", () => {
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

  test("MCP tools JSON: index and search tool signatures", () => {
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
});

describe("Query Sanitization", () => {
  test("handles special FTS5 characters in query", () => {
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

  test("empty query returns empty results", () => {
    const store = createStore();
    store.index({
      content: "# Doc\n\nContent.",
      source: "empty-q",
    });
    const results = store.search("", 3);
    assert.equal(results.length, 0, "Empty query should return no results");
    store.close();
  });
});

describe("Edge Cases", () => {
  test("content with no headings creates single chunk", () => {
    const store = createStore();
    const result = store.index({
      content: "Just plain text without any markdown headings.",
      source: "plain",
    });
    assert.equal(result.totalChunks, 1);
    store.close();
  });

  test("nested code blocks (triple backtick inside fenced)", () => {
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

  test("very long content chunks correctly", () => {
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

  test("heading-only content (no body) still creates chunk", () => {
    const store = createStore();
    const result = store.index({
      content: "# Title Only\n\n## Another Heading",
      source: "headings-only",
    });
    // The heading lines themselves are content
    assert.ok(result.totalChunks >= 1);
    store.close();
  });
});

describe("Source-Scoped Search", () => {
  test("search with source filter returns only matching source", () => {
    const store = createStore();
    store.index({
      content: "# Zod Transform\n\nUse .transform() to map values.\n\n## Refine\n\nUse .refine() for custom validation.",
      source: "Zod API docs",
    });
    store.index({
      content: "# Security Release\n\nCVE-2025-1234: Fixed transform injection vulnerability.\n\n## Fixes\n\nRefine permission checks.",
      source: "Node.js v22 CHANGELOG",
    });

    // Without source filter — both sources may match (OR mode for cross-chunk terms)
    const allResults = store.search("transform refine", 5, undefined, "OR");
    assert.ok(allResults.length >= 2, "Should find results from both sources");

    // With source filter — only Zod
    const zodResults = store.search("transform refine", 5, "Zod", "OR");
    assert.ok(zodResults.length > 0, "Should find Zod results");
    assert.ok(
      zodResults.every((r) => r.source.includes("Zod")),
      `All results should be from Zod, got: ${zodResults.map((r) => r.source).join(", ")}`,
    );

    // With source filter — only Node.js
    const nodeResults = store.search("transform refine", 5, "Node.js", "OR");
    assert.ok(nodeResults.length > 0, "Should find Node.js results");
    assert.ok(
      nodeResults.every((r) => r.source.includes("Node.js")),
      `All results should be from Node.js, got: ${nodeResults.map((r) => r.source).join(", ")}`,
    );

    store.close();
  });

  test("search with non-matching source returns empty", () => {
    const store = createStore();
    store.index({
      content: "# React Hooks\n\nuseEffect for side effects.",
      source: "React docs",
    });
    const results = store.search("useEffect", 3, "Vue");
    assert.equal(results.length, 0, "Should return empty for non-matching source");
    store.close();
  });

  test("listSources returns all indexed sources", () => {
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

  test("source filter uses partial match (LIKE)", () => {
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
});

describe("Context Savings Measurement", () => {
  test("index+search uses less context than raw content", () => {
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
    assert.ok(
      resultBytes < rawBytes,
      "Search result should be smaller than full doc",
    );
    store.close();
  });
});

describe("Plain Text Indexing", () => {
  test("indexPlainText: chunks by line groups", () => {
    const store = createStore();
    const lines = Array.from({ length: 100 }, (_, i) => `Log line ${i + 1}: processing request`).join("\n");
    const result = store.indexPlainText(lines, "build-output");
    assert.ok(result.totalChunks >= 5, `Expected >=5 chunks for 100 lines with 20-line groups, got ${result.totalChunks}`);
    assert.equal(result.label, "build-output");
    assert.equal(result.codeChunks, 0);
    store.close();
  });

  test("indexPlainText: single chunk for small output", () => {
    const store = createStore();
    const content = "Line 1\nLine 2\nLine 3";
    const result = store.indexPlainText(content, "small-output");
    assert.equal(result.totalChunks, 1, `Expected 1 chunk for 3 lines, got ${result.totalChunks}`);
    assert.equal(result.label, "small-output");
    store.close();
  });

  test("indexPlainText: blank-line splitting for sectioned output", () => {
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

  test("indexPlainText: searchable after indexing", () => {
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

  test("indexPlainText: empty content returns 0 chunks", () => {
    const store = createStore();
    const result = store.indexPlainText("", "empty-output");
    assert.equal(result.totalChunks, 0, "Empty content should produce 0 chunks");
    assert.equal(result.label, "empty-output");
    store.close();
  });

  test("indexPlainText: in-memory store works", () => {
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
});

describe("getDistinctiveTerms", () => {
  test("getDistinctiveTerms: returns terms in moderate frequency range", () => {
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

  test("getDistinctiveTerms: returns empty for too few sections", () => {
    const store = createStore();
    // Only 2 sections — below the chunk_count < 3 threshold
    const content = "Section A content here.\n\nSection B content here.";
    const result = store.indexPlainText(content, "too-few-sections");
    assert.ok(result.totalChunks <= 2, `Expected <=2 chunks, got ${result.totalChunks}`);
    const terms = store.getDistinctiveTerms(result.sourceId);
    assert.deepEqual(terms, [], "Should return empty array for fewer than 3 chunks");
    store.close();
  });

  test("getDistinctiveTerms: excludes stopwords", () => {
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
});

describe("Smart Chunk Titles", () => {
  test("smart chunk titles: blank-line split uses first line as title", () => {
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

  test("smart chunk titles: line-group chunks use first line as title", () => {
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
});

describe("DB Cleanup", () => {
  test("cleanupStaleDBs removes files for dead PIDs", () => {
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

  test("cleanupStaleDBs does not remove current process DB", () => {
    const myPath = join(tmpdir(), `context-mode-${process.pid}.db`);
    writeFileSync(myPath, "current");

    cleanupStaleDBs();
    assert.ok(existsSync(myPath), "Current process DB should NOT be removed");

    // Clean up manually
    try { require("fs").unlinkSync(myPath); } catch {}
  });

  test("store.cleanup() removes own DB and WAL/SHM files", () => {
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

  test("store.cleanup() is safe to call multiple times", () => {
    const path = join(tmpdir(), `context-mode-cleanup-idempotent-${Date.now()}.db`);
    const store = new ContentStore(path);
    store.cleanup();
    // Second call should not throw
    assert.doesNotThrow(() => store.cleanup());
  });
});

describe("Max Chunk Size", () => {
  test("splits oversized markdown chunk at paragraph boundaries", () => {
    const store = createStore();
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i + 1}. ${"Lorem ipsum dolor sit amet. ".repeat(20)}`
    );
    const content = `# Big Section\n\n${paragraphs.join("\n\n")}`;

    const result = store.index({ content, source: "max-chunk-test" });
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);

    const searchResult = store.search("Paragraph", 10, "max-chunk-test");
    for (const r of searchResult) {
      assert.ok(r.title.includes("Big Section"), `Expected heading in title, got: ${r.title}`);
    }
    store.close();
  });

  test("does not split chunks already under maxChunkBytes", () => {
    const store = createStore();
    const content = `# Small Section\n\nJust a few lines of text.\n\nAnother paragraph.`;
    const result = store.index({ content, source: "small-chunk-test" });
    assert.equal(result.totalChunks, 1);
    store.close();
  });

  test("keeps code blocks intact when splitting oversized chunks", () => {
    const store = createStore();
    const codeBlock = "```typescript\n" + "const x = 1;\n".repeat(100) + "```";
    const prose = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}. ${"Text content here. ".repeat(20)}`
    ).join("\n\n");
    const content = `# Code Section\n\n${codeBlock}\n\n${prose}`;

    const result = store.index({ content, source: "code-chunk-test" });
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);

    const codeResults = store.search("const x", 5, "code-chunk-test");
    assert.ok(codeResults.length > 0, "Should find the code block");
    assert.ok(
      codeResults[0].content.includes("```typescript"),
      "Code block should be intact with opening fence",
    );
    store.close();
  });
});

describe("JSON Chunking (Objects)", () => {
  test("chunks JSON object by top-level keys", () => {
    const store = createStore();
    const json = JSON.stringify({
      authentication: {
        oauth: { clientId: "abc", scopes: ["read", "write"] },
        jwt: { algorithm: "RS256", expiry: "1h" },
      },
      database: {
        host: "localhost",
        port: 5432,
      },
    });

    const result = store.indexJSON(json, "config");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);

    const authResults = store.search("oauth clientId", 5, "config");
    assert.ok(authResults.length > 0, "Should find oauth config");
    assert.ok(
      authResults[0].title.includes("authentication"),
      `Expected 'authentication' in title, got: ${authResults[0].title}`,
    );
    store.close();
  });

  test("small JSON object becomes single chunk", () => {
    const store = createStore();
    const json = JSON.stringify({ name: "Alice", role: "admin" });
    const result = store.indexJSON(json, "small");
    assert.equal(result.totalChunks, 1);
    store.close();
  });

  test("chunks nested JSON with path titles", () => {
    const store = createStore();
    const endpoints: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      endpoints[`/api/v1/resource${i}`] = {
        method: "GET",
        description: `Get resource ${i}. ${"Details. ".repeat(50)}`,
        params: { id: "string", limit: "number" },
      };
    }
    const json = JSON.stringify({ endpoints });

    const result = store.indexJSON(json, "api-spec");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);

    const results = store.search("resource15", 5, "api-spec");
    assert.ok(results.length > 0, "Should find resource15");
    store.close();
  });

  test("handles invalid JSON gracefully by falling back to plain text", () => {
    const store = createStore();
    const result = store.indexJSON("not valid json {{{", "bad-json");
    assert.ok(result.totalChunks >= 1, "Should still index as plain text");
    store.close();
  });
});

describe("JSON Chunking (Arrays)", () => {
  test("top-level array of objects uses identity field in titles", () => {
    const store = createStore();
    const users = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      email: `user${i + 1}@example.com`,
      bio: `Bio for user ${i + 1}. ${"Some details. ".repeat(10)}`,
    }));
    const json = JSON.stringify(users);

    const result = store.indexJSON(json, "users-api");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);

    const results = store.search("User 25", 5, "users-api");
    assert.ok(results.length > 0, "Should find User 25");
    store.close();
  });

  test("identity field appears in chunk titles", () => {
    const store = createStore();
    const items = [
      { name: "Alice", role: "admin", data: "x".repeat(2000) },
      { name: "Bob", role: "user", data: "y".repeat(2000) },
      { name: "Carol", role: "user", data: "z".repeat(2000) },
    ];
    const json = JSON.stringify(items);

    const result = store.indexJSON(json, "people");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);

    const results = store.search("Alice admin", 5, "people");
    assert.ok(results.length > 0, "Should find Alice");
    assert.ok(
      results[0].title.includes("Alice"),
      `Expected 'Alice' in title, got: ${results[0].title}`,
    );
    store.close();
  });

  test("array of primitives becomes batched chunks", () => {
    const store = createStore();
    const longStrings = Array.from({ length: 100 }, (_, i) =>
      `Item ${i}: ${"content ".repeat(50)}`
    );
    const json = JSON.stringify(longStrings);

    const result = store.indexJSON(json, "primitives");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);
    store.close();
  });

  test("nested array within object uses full key path", () => {
    const store = createStore();
    const json = JSON.stringify({
      api: {
        endpoints: Array.from({ length: 20 }, (_, i) => ({
          path: `/api/v1/resource${i}`,
          method: "GET",
          description: `Resource ${i}. ${"Details ".repeat(30)}`,
        })),
      },
    });

    const result = store.indexJSON(json, "nested-api");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);

    const results = store.search("resource10", 5, "nested-api");
    assert.ok(results.length > 0, "Should find resource10");
    assert.ok(
      results[0].title.includes("api") && results[0].title.includes("endpoints"),
      `Expected path in title, got: ${results[0].title}`,
    );
    store.close();
  });
});

describe("Content-Type Routing", () => {
  test("indexJSON produces searchable chunks from pretty-printed JSON", () => {
    const store = createStore();
    const apiResponse = JSON.stringify({
      data: {
        users: [
          { id: 1, name: "Alice", email: "alice@example.com" },
          { id: 2, name: "Bob", email: "bob@example.com" },
        ],
        pagination: { page: 1, total: 100 },
      },
    });

    const result = store.indexJSON(apiResponse, "api-response");
    assert.ok(result.totalChunks >= 1, `Expected >=1 chunks, got ${result.totalChunks}`);

    const results = store.search("Alice email", 5, "api-response");
    assert.ok(results.length > 0, "Should find Alice's email via search");
    store.close();
  });

  test("indexPlainText handles non-JSON non-HTML content", () => {
    const store = createStore();
    const plainText = "name,email,role\nAlice,alice@example.com,admin\nBob,bob@example.com,user";
    const result = store.indexPlainText(plainText, "csv-response");
    assert.ok(result.totalChunks >= 1);
    store.close();
  });
});

// ── Source metadata & TTL cache ───────────────────────────────────────

describe("Source metadata (TTL cache)", () => {
  test("getSourceMeta returns null for unknown source", () => {
    const store = createStore();
    const meta = store.getSourceMeta("nonexistent-source");
    expect(meta).toBeNull();
    store.close();
  });

  test("getSourceMeta returns metadata after indexing", () => {
    const store = createStore();
    store.index({ content: "# Hello\nWorld", source: "test-doc" });
    const meta = store.getSourceMeta("test-doc");
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe("test-doc");
    expect(meta!.chunkCount).toBeGreaterThan(0);
    expect(meta!.indexedAt).toBeTruthy();
    store.close();
  });

  test("getSourceMeta indexedAt is valid datetime", () => {
    const store = createStore();
    store.index({ content: "# Test\nContent here", source: "datetime-test" });
    const meta = store.getSourceMeta("datetime-test");
    const parsed = new Date(meta!.indexedAt);
    expect(parsed.getTime()).not.toBeNaN();
    store.close();
  });

  test("getSourceMeta updates after re-indexing same source", () => {
    const store = createStore();
    store.index({ content: "# V1\nFirst version", source: "evolving-doc" });
    const meta1 = store.getSourceMeta("evolving-doc");
    store.index({ content: "# V2\nSecond version\n## Extra\nMore content", source: "evolving-doc" });
    const meta2 = store.getSourceMeta("evolving-doc");
    expect(meta2!.chunkCount).toBeGreaterThanOrEqual(meta1!.chunkCount);
    store.close();
  });
});

// ── Persistent content store lifecycle ────────────────────────────────

describe("Persistent content store lifecycle", () => {
  test("cleanupStaleSources keeps recent sources and returns 0", () => {
    const store = createStore();
    store.index({ content: "# Fresh doc\nContent", source: "fresh-source" });
    const deleted = store.cleanupStaleSources(30);
    expect(typeof deleted).toBe("number");
    expect(deleted).toBe(0);
    const meta = store.getSourceMeta("fresh-source");
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe("fresh-source");
    store.close();
  });

  test("cleanupStaleSources returns number type", () => {
    const store = createStore();
    store.index({ content: "# Test\nContent", source: "test-source" });
    const deleted = store.cleanupStaleSources(365);
    expect(typeof deleted).toBe("number");
    store.close();
  });

  test("getDBSizeBytes returns positive number after indexing", () => {
    const store = createStore();
    store.index({ content: "# Test\nSome content for size", source: "size-test" });
    const size = store.getDBSizeBytes();
    expect(size).toBeGreaterThan(0);
    store.close();
  });

  test("store data persists after close and reopen at same path", () => {
    const dbPath = join(tmpdir(), `persist-test-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    store1.index({ content: "# Persistent\nThis should survive", source: "persist-doc" });
    store1.close();

    const store2 = new ContentStore(dbPath);
    const meta = store2.getSourceMeta("persist-doc");
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe("persist-doc");
    expect(meta!.chunkCount).toBeGreaterThan(0);
    store2.cleanup();
  });

  test("deleting DB file before creating store gives fresh state", () => {
    const dbPath = join(tmpdir(), `fresh-test-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    store1.index({ content: "# Old\nOld content", source: "old-doc" });
    store1.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }

    const store2 = new ContentStore(dbPath);
    const meta = store2.getSourceMeta("old-doc");
    expect(meta).toBeNull();
    store2.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SQLITE_BUSY Retry Logic (#218)
// ═══════════════════════════════════════════════════════════════════════════

describe("SQLITE_BUSY retry logic", () => {
  test("ContentStore uses 30s timeout", () => {
    const storeSrc = readFileSync(
      join(__dirname, "../src/store.ts"),
      "utf-8",
    );
    expect(storeSrc).toContain("timeout: 30000");
  });

  test("withRetry retries on SQLITE_BUSY and succeeds", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "success";
    }, [0, 0, 0]);
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  test("withRetry throws after max retries exhausted", () => {
    expect(() => {
      withRetry(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      }, [0, 0, 0]);
    }).toThrow(/SQLITE_BUSY.*3 retries/);
  });

  test("withRetry retries on SQLITE_BUSY with zero delays", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "ok";
    }, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("withRetry throws after all retries with zero delays", () => {
    expect(() => {
      withRetry(() => {
        throw new Error("database is locked");
      }, [0, 0, 0]);
    }).toThrow(/SQLITE_BUSY.*3 retries/);
  });

  test("withRetry rethrows non-BUSY errors immediately", () => {
    let attempts = 0;
    expect(() => {
      withRetry(() => {
        attempts++;
        throw new Error("UNIQUE constraint failed");
      }, [0, 0, 0]);
    }).toThrow("UNIQUE constraint failed");
    expect(attempts).toBe(1);
  });
});

// ── withRetry coverage for all write/read paths ──

describe("withRetry edge cases", () => {
  test("withRetry succeeds on first attempt", () => {
    const result = withRetry(() => "immediate", [0, 0, 0]);
    expect(result).toBe("immediate");
  });

  test("withRetry recovers on last retry", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts <= 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "recovered";
    }, [0, 0, 0]);
    expect(result).toBe("recovered");
    expect(attempts).toBe(4); // 1 initial + 3 retries
  });

  test("withRetry handles 'database is locked' without SQLITE_BUSY prefix", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts < 2) {
        throw new Error("database is locked");
      }
      return "ok";
    }, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("withRetry with empty delays array throws immediately on BUSY", () => {
    expect(() => {
      withRetry(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      }, []);
    }).toThrow(/SQLITE_BUSY.*0 retries/);
  });

  test("withRetry preserves return type", () => {
    const obj = withRetry(() => ({ key: "value", num: 42 }), [0]);
    expect(obj).toEqual({ key: "value", num: 42 });
  });
});

// ── Concurrent write resilience ──

describe("concurrent DB access", () => {
  test("two ContentStore instances can write to the same DB file", () => {
    const dbPath = join(tmpdir(), `concurrent-write-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    const store2 = new ContentStore(dbPath);

    store1.index({ content: "# First\n\nContent from store 1.", source: "store1-doc" });
    store2.index({ content: "# Second\n\nContent from store 2.", source: "store2-doc" });

    // Both sources should be searchable from either store
    const results1 = store1.search("Content from store", 10);
    expect(results1.length).toBeGreaterThanOrEqual(2);

    const results2 = store2.search("Content from store", 10);
    expect(results2.length).toBeGreaterThanOrEqual(2);

    store1.cleanup();
    store2.close();
  });

  test("indexPlainText is protected by withRetry", () => {
    // Verify indexPlainText doesn't throw on transient BUSY by testing
    // concurrent plain text indexing on same DB
    const dbPath = join(tmpdir(), `concurrent-plaintext-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    const store2 = new ContentStore(dbPath);

    store1.indexPlainText("alpha bravo charlie", "plain-1");
    store2.indexPlainText("delta echo foxtrot", "plain-2");

    const r1 = store1.search("alpha bravo", 5, "plain-1");
    expect(r1.length).toBeGreaterThan(0);
    const r2 = store1.search("delta echo", 5, "plain-2");
    expect(r2.length).toBeGreaterThan(0);

    store1.cleanup();
    store2.close();
  });

  test("indexJSON is protected by withRetry", () => {
    const dbPath = join(tmpdir(), `concurrent-json-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    const store2 = new ContentStore(dbPath);

    store1.indexJSON(JSON.stringify({ users: [{ name: "Alice" }] }), "json-1");
    store2.indexJSON(JSON.stringify({ items: [{ id: 1 }] }), "json-2");

    const results = store1.search("Alice", 5);
    expect(results.length).toBeGreaterThan(0);

    store1.cleanup();
    store2.close();
  });

  test("search and searchTrigram work under concurrent writes", () => {
    const dbPath = join(tmpdir(), `concurrent-search-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    const store2 = new ContentStore(dbPath);

    store1.index({ content: "# Guide\n\nReact hooks are powerful.", source: "guide" });

    // Write from store2 while store1 searches
    store2.index({ content: "# Tutorial\n\nVue composition API.", source: "tutorial" });
    const results = store1.search("hooks", 5);
    expect(results.length).toBeGreaterThan(0);

    store1.cleanup();
    store2.close();
  });
});

// ── WAL checkpoint on close (#244) ──

describe("closeDB — WAL checkpoint", () => {
  test("closeDB checkpoints WAL so no -wal file remains", () => {
    const dbPath = join(tmpdir(), `wal-test-${Date.now()}.db`);
    const Database = loadDatabase();
    const db = Database(dbPath, { timeout: 30000 });
    applyWALPragmas(db);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    db.exec("INSERT INTO t VALUES (1, 'hello')");

    // WAL file should exist after writes in WAL mode
    expect(existsSync(dbPath + "-wal")).toBe(true);

    closeDB(db);

    // After closeDB, WAL should be checkpointed (truncated to 0 or removed)
    // The file may still exist but should be empty, or may not exist
    const walExists = existsSync(dbPath + "-wal");
    if (walExists) {
      const walSize = readFileSync(dbPath + "-wal").length;
      expect(walSize).toBe(0);
    }

    // cleanup
    for (const s of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + s); } catch {}
    }
  });
});

// ── Corrupt DB recovery (#244) ──

describe("ContentStore — corrupt DB recovery", () => {
  // Windows file locking prevents WAL/SHM deletion while another worker holds them open
  test.skipIf(process.platform === "win32")("recovers from corrupt DB file by deleting and recreating", () => {
    const dbPath = join(tmpdir(), `corrupt-store-${Date.now()}.db`);
    // Write garbage to simulate corrupt DB
    writeFileSync(dbPath, "THIS IS NOT A SQLITE DATABASE FILE");
    writeFileSync(dbPath + "-wal", "CORRUPT WAL");

    // Should recover: delete corrupt files and create fresh DB
    const store = new ContentStore(dbPath);
    // Store should be functional
    store.index({ content: "test content", source: "test" });
    const results = store.search("test content");
    expect(results.length).toBeGreaterThan(0);

    store.cleanup();
  });

  test("non-SQLite errors still throw", () => {
    // A path to a directory (not a file) should throw a non-corruption error
    expect(() => new ContentStore(tmpdir())).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// mmap_size pragma
// ═══════════════════════════════════════════════════════════

describe("mmap_size pragma", () => {
  test("mmap_size is set on new ContentStore", () => {
    const dbPath = join(tmpdir(), `ctx-mmap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new ContentStore(dbPath);
    store.indexPlainText("Memory-mapped I/O test content for FTS5 search", "mmap-test");
    const results = store.search("memory-mapped");
    expect(results.length).toBeGreaterThan(0);
    store.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════
// FTS5 Periodic Optimization
// ═══════════════════════════════════════════════════════════

describe("FTS5 periodic optimize", () => {
  test("search works correctly after OPTIMIZE_EVERY inserts", () => {
    const dbPath = join(tmpdir(), `ctx-optimize-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new ContentStore(dbPath);

    for (let i = 0; i < ContentStore.OPTIMIZE_EVERY + 5; i++) {
      store.indexPlainText(`Document number ${i} about testing optimization`, `source-${i}`);
    }

    const results = store.search("testing optimization");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("testing optimization");

    store.cleanup();
  });

  test("close() does not throw even after many inserts", () => {
    const dbPath = join(tmpdir(), `ctx-optimize-close-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new ContentStore(dbPath);

    for (let i = 0; i < 10; i++) {
      store.indexPlainText(`Content ${i}`, `src-${i}`);
    }

    expect(() => store.close()).not.toThrow();
  });

  test("OPTIMIZE_EVERY is a reasonable value", () => {
    expect(ContentStore.OPTIMIZE_EVERY).toBeGreaterThanOrEqual(20);
    expect(ContentStore.OPTIMIZE_EVERY).toBeLessThanOrEqual(200);
  });
});

describe("Sanitize query token deduplication", () => {
  test("sanitizeQuery removes duplicate tokens (case-insensitive)", async () => {
    const { sanitizeQuery } = await import("../src/store.js");
    assert.equal(
      sanitizeQuery("error error error"),
      '"error"',
      "three identical tokens should compile to a single quoted term",
    );
    assert.equal(
      sanitizeQuery("Error ERROR error"),
      '"Error"',
      "case differences should not create duplicate tokens",
    );
  });

  test("sanitizeQuery preserves first-occurrence casing after dedup", async () => {
    const { sanitizeQuery } = await import("../src/store.js");
    assert.equal(sanitizeQuery("Database database DATABASE"), '"Database"');
  });

  test("sanitizeQuery preserves distinct tokens and their order", async () => {
    const { sanitizeQuery } = await import("../src/store.js");
    // "update" is a stopword, but the meaningful terms remain distinct.
    assert.equal(
      sanitizeQuery("database query database index query"),
      '"database" "query" "index"',
      "distinct tokens should be kept; duplicates collapsed in first-seen order",
    );
  });

  test("sanitizeTrigramQuery removes duplicate tokens", async () => {
    const { sanitizeTrigramQuery } = await import("../src/store.js");
    assert.equal(
      sanitizeTrigramQuery("error error error"),
      '"error"',
    );
    assert.equal(
      sanitizeTrigramQuery("error ERROR Error"),
      '"error"',
      "case-insensitive dedup across all three trigram sanitize paths",
    );
  });

  test("dedup in OR mode collapses duplicates but preserves distinct terms", async () => {
    const { sanitizeQuery } = await import("../src/store.js");
    assert.equal(
      sanitizeQuery("error error database", "OR"),
      '"error" OR "database"',
    );
  });

  test("search returns identical results for duplicated and deduplicated queries", () => {
    const store = createStore();
    store.index({
      content:
        "# Error Handling\n\nThe database connection threw an error during migration.\n\n# Overview\n\nPlain content.",
      source: "dedup-behavioral",
    });

    const duplicated = store.search("error error error database database");
    const unique = store.search("error database");

    assert.equal(duplicated.length, unique.length);
    for (let i = 0; i < duplicated.length; i++) {
      assert.equal(duplicated[i].title, unique[i].title);
      assert.equal(duplicated[i].content, unique[i].content);
    }
    store.close();
  });
});

describe("Stopword filtering in search queries", () => {
  test("stopwords are filtered from search — meaningful terms drive ranking", () => {
    const store = createStore();
    // "fix" and "update" are stopwords in the domain list.
    // "database" and "connection" are meaningful terms.
    store.index({
      content:
        "# Database Connection Pool\n\nManage database connections with pooling.\n\n# Update Log\n\nFix applied to update module on Tuesday.",
      source: "stopword-search",
    });

    // Search with stopwords mixed in — results should prioritize "database connection"
    const results = store.search("fix database connection", 2);
    assert.ok(results.length > 0, "Should return results");
    assert.ok(
      results[0].content.toLowerCase().includes("database") &&
        results[0].content.toLowerCase().includes("connection"),
      `Top result should match meaningful terms 'database connection', got: ${results[0].title}`,
    );
    store.close();
  });

  test("all-stopword query still returns results (fallback)", () => {
    const store = createStore();
    store.index({
      content: "# Updates\n\nUpdate the test runner to fix the issue.\n\n# Other\n\nUnrelated content.",
      source: "all-stopwords",
    });

    // "update test fix" are all stopwords — should fall back to using them
    const results = store.search("update test fix", 2);
    assert.ok(results.length > 0, "All-stopword query should still return results via fallback");
    store.close();
  });

  test("stopwords filtered from trigram search", () => {
    const store = createStore();
    store.index({
      content:
        "# Encryption Module\n\nAES encryption with key rotation.\n\n# Testing Guide\n\nRun tests using the test framework.",
      source: "trigram-stopwords",
    });

    // "using" is a stopword, "encryption" is meaningful
    const results = store.searchTrigram("using encryption", 2);
    assert.ok(results.length > 0, "Should return results");
    assert.ok(
      results[0].content.toLowerCase().includes("encryption"),
      `Should match on meaningful term 'encryption', got: ${results[0].title}`,
    );
    store.close();
  });

  test("proximity reranking ignores stopwords for boost calculation", () => {
    const store = createStore();
    // Two chunks: one has "database error" close together, the other has them far apart
    // but has "fix" (stopword) nearby
    store.index({
      content:
        "# Error Handling\n\nThe database threw an error during migration.\n\n# Fix Log\n\nWe fix things. Much later in this document we mention database. Even later we see error.",
      source: "proximity-stopwords",
    });

    const results = store.searchWithFallback("fix database error", 2);
    assert.ok(results.length > 0, "Should return results");
    // The chunk with "database" and "error" close together should rank higher
    // because "fix" (stopword) is excluded from proximity calculation
    assert.ok(
      results[0].content.toLowerCase().includes("database") &&
        results[0].content.toLowerCase().includes("error") &&
        results[0].title.includes("Error"),
      `Proximity should favor chunk with meaningful terms close together, got: ${results[0].title}`,
    );
    store.close();
  });
});

// ─────────────────────────────────────────────────────────
// nodeSqliteHasFts5 — issue #461
// On Linux + Node >= 22.5, the picker used to commit to node:sqlite as
// soon as the import succeeded, even on Node builds whose bundled SQLite
// is compiled without FTS5. ctx_search/ctx_batch_execute then failed with
// "no such module: fts5". The picker now probes FTS5 support before
// adopting node:sqlite, falling through to better-sqlite3 otherwise.
// ─────────────────────────────────────────────────────────
describe("nodeSqliteHasFts5 — FTS5 capability probe (#461)", () => {
  test("returns true when CREATE VIRTUAL TABLE … USING fts5 succeeds", () => {
    let opened = 0;
    let closed = 0;
    class FakeDB {
      constructor(path: string) {
        assert.equal(path, ":memory:", "probe must use :memory:");
        opened++;
      }
      exec(sql: string): void {
        assert.match(sql, /CREATE VIRTUAL TABLE .* USING fts5/i);
      }
      close(): void { closed++; }
    }
    assert.equal(nodeSqliteHasFts5(FakeDB as any), true);
    assert.equal(opened, 1);
    assert.equal(closed, 1);
  });

  test("returns false when FTS5 module is missing on the bundled SQLite", () => {
    // Reproduces the exact symptom reported in #461 against Node v22.14.0:
    //   db.exec("CREATE VIRTUAL TABLE t USING fts5(x)") → "no such module: fts5"
    let closed = 0;
    class FakeDB {
      exec(_sql: string): void {
        throw new Error("no such module: fts5");
      }
      close(): void { closed++; }
    }
    assert.equal(nodeSqliteHasFts5(FakeDB as any), false);
    assert.equal(closed, 1, "probe DB must be closed even when FTS5 check throws");
  });

  test("returns false when DatabaseSync constructor itself throws", () => {
    class FakeDB {
      constructor() { throw new Error("DatabaseSync ctor failure"); }
      exec(_sql: string): void {}
      close(): void {}
    }
    // Probe must not crash the picker — it just reports "no FTS5".
    assert.equal(nodeSqliteHasFts5(FakeDB as any), false);
  });

  test("close() failure does not propagate out of the probe", () => {
    class FakeDB {
      exec(_sql: string): void {}
      close(): void { throw new Error("close failed"); }
    }
    // Probe should still report success — the FTS5 check passed before close().
    assert.equal(nodeSqliteHasFts5(FakeDB as any), true);
  });

  test("real node:sqlite probe matches FTS5 availability on this runtime", () => {
    // Sanity check: if node:sqlite is loadable, the probe answer must agree
    // with a direct FTS5 attempt on a fresh DatabaseSync. Skipped when
    // node:sqlite is unavailable (older Node, non-Linux without flag).
    let DatabaseSync: any;
    try {
      const requireFn = createRequire(import.meta.url);
      ({ DatabaseSync } = requireFn(["node", "sqlite"].join(":")));
    } catch {
      return;
    }
    let directOK = false;
    let direct: any = null;
    try {
      direct = new DatabaseSync(":memory:");
      direct.exec("CREATE VIRTUAL TABLE __direct_probe USING fts5(x)");
      directOK = true;
    } catch {
      directOK = false;
    } finally {
      try { direct?.close(); } catch { /* ignore */ }
    }
    assert.equal(nodeSqliteHasFts5(DatabaseSync), directOK);
  });
});
