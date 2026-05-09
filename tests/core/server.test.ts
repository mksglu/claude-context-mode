/**
 * Consolidated server-related tests.
 *
 * Merged from:
 *   - tests/soft-fail.test.ts
 *   - tests/stream-cap.test.ts
 *   - tests/turndown.test.ts
 *   - tests/project-dir.test.ts
 *   - tests/subagent-budget.test.ts
 *
 * Run: npx vitest run tests/core/server.test.ts
 */

import { strict as assert } from "node:assert";
import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { classifyNonZeroExit } from "../../src/exit-classify.js";
import { PolyglotExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";
import { ContentStore } from "../../src/store.js";
import { ROUTING_BLOCK } from "../../hooks/routing-block.mjs";

// ─── Shared setup ───────────────────────────────────────────────────────────
const runtimes = detectRuntimes();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════
// 1. Non-zero Exit Code Classification (soft-fail)
// ═══════════════════════════════════════════════════════════════════════════

describe("Non-zero Exit Code Classification", () => {
  // ── Soft-fail: shell + exit 1 + stdout present ──

  test("shell exit 1 with stdout → not an error (grep no-match pattern)", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "file1.ts:10: writeRouting\nfile2.ts:20: writeRouting",
      stderr: "",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("file1.ts:10: writeRouting\nfile2.ts:20: writeRouting");
  });

  test("shell exit 1 with empty stdout → real error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
    expect(result.isError).toBe(true);
  });

  test("shell exit 1 with whitespace-only stdout → real error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "   \n  ",
      stderr: "",
    });
    expect(result.isError).toBe(true);
  });

  // ── Hard errors: exit code >= 2 ──

  test("shell exit 2 (grep bad regex) → always error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 2,
      stdout: "",
      stderr: "grep: Invalid regular expression",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 2");
    expect(result.output).toContain("grep: Invalid regular expression");
  });

  test("shell exit 127 (command not found) → always error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 127,
      stdout: "",
      stderr: "bash: nonexistent: command not found",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 127");
  });

  // ── Non-shell languages: always error ──

  test("javascript exit 1 with stdout → still an error (not shell)", () => {
    const result = classifyNonZeroExit({
      language: "javascript",
      exitCode: 1,
      stdout: "some output before crash",
      stderr: "TypeError: x is not a function",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 1");
  });

  test("python exit 1 with stdout → still an error (not shell)", () => {
    const result = classifyNonZeroExit({
      language: "python",
      exitCode: 1,
      stdout: "partial output",
      stderr: "Traceback (most recent call last):",
    });
    expect(result.isError).toBe(true);
  });

  test("typescript exit 1 with stdout → still an error (not shell)", () => {
    const result = classifyNonZeroExit({
      language: "typescript",
      exitCode: 1,
      stdout: "output",
      stderr: "",
    });
    expect(result.isError).toBe(true);
  });

  // ── Output format ──

  test("soft-fail output is clean stdout (no 'Exit code:' prefix)", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "matched line",
      stderr: "",
    });
    expect(result.output).not.toContain("Exit code:");
    expect(result.output).toBe("matched line");
  });

  test("hard error output includes exit code, stdout, and stderr", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 2,
      stdout: "partial",
      stderr: "error msg",
    });
    expect(result.output).toContain("Exit code: 2");
    expect(result.output).toContain("partial");
    expect(result.output).toContain("error msg");
  });

  test("hard-fail with empty stdout still forwards stderr in output", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "",
      stderr: "command not found",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 1");
    expect(result.output).toContain("command not found");
  });

  test("hard-fail output has labeled 'stdout:' and 'stderr:' sections", () => {
    const result = classifyNonZeroExit({
      language: "node",
      exitCode: 137,
      stdout: "S",
      stderr: "E",
    });
    expect(result.output).toMatch(/stdout:\s*\nS/);
    expect(result.output).toMatch(/stderr:\s*\nE/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Stream Cap (stream-cap)
// ═══════════════════════════════════════════════════════════════════════════

describe("Stdout Cap", () => {
  test("stdout: process killed when output exceeds hard cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Expected cap message in stderr, got: " + r.stderr.slice(-200));
    assert.ok(r.stderr.includes("process killed"), "Expected 'process killed' in stderr");
  });
});

describe("Stderr Cap", () => {
  test("stderr: process killed when stderr exceeds hard cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.error("e".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Expected cap message in stderr for stderr-heavy output");
  });
});

describe("Combined Cap", () => {
  test("combined: cap triggers on total stdout+stderr bytes", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 2048, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 200; i++) process.stdout.write("o".repeat(10) + "\\n");\nfor (let i = 0; i < 200; i++) process.stderr.write("e".repeat(10) + "\\n");',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Combined output should have triggered the cap");
  });
});

describe("Normal Operation", () => {
  test("normal: small output below cap works correctly", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024 * 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("hello from capped executor");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from capped executor"));
    assert.ok(!r.stderr.includes("output capped"), "Should NOT contain cap message for small output");
  });

  test("normal: moderate output below cap preserves all content", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024 * 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 50; i++) console.log("line-" + i);',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("line-0"), "Should contain first line");
    assert.ok(r.stdout.includes("line-49"), "Should contain last line");
    assert.ok(!r.stderr.includes("output capped"));
  });
});

describe("Memory Bounding", () => {
  test("memory: collected stdout bytes stay bounded near cap", async () => {
    const capBytes = 4096;
    const executor = new PolyglotExecutor({ hardCapBytes: capBytes, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 20000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Cap should have triggered");
    const stdoutBytes = Buffer.byteLength(r.stdout);
    const tolerance = 256 * 1024;
    assert.ok(stdoutBytes < capBytes + tolerance, "Collected " + stdoutBytes + " bytes stdout; expected bounded near " + capBytes);
  });
});

describe("Cap Message Format", () => {
  test("format: cap message reports correct MB value for 2MB cap", async () => {
    const twoMB = 2 * 1024 * 1024;
    const executor = new PolyglotExecutor({ hardCapBytes: twoMB, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 100000; i++) process.stdout.write("x".repeat(49) + "\\n");',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("2MB"), "Expected '2MB' in cap message: " + r.stderr.slice(-200));
    assert.ok(r.stderr.includes("process killed"));
  });

  test("format: cap message uses em dash and bracket format", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("\u2014"), "Cap message should use em dash");
    assert.ok(r.stderr.includes("[output capped at"), "Cap message should start with '[output capped at'");
  });
});

describe("Timeout Independence", () => {
  test("timeout: still fires when output is slow and under cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 100 * 1024 * 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: "while(true) {}",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
    assert.ok(!r.stderr.includes("output capped"), "Should be timeout, not cap");
  });

  test("timeout: cap fires before timeout for fast-producing process", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 100000; i++) console.log("x".repeat(50));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Cap should fire before timeout");
    assert.equal(r.timedOut, false, "timedOut should be false when cap killed the process");
  });
});

describe("Default Cap", () => {
  test("default: executor works with default hardCapBytes (no option)", async () => {
    const executor = new PolyglotExecutor({ runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("default cap works");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("default cap works"));
  });
});

describe("hardCap still limits output", () => {
  test("hardCap kills process but stdout is NOT truncated", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 50 * 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Hard cap should trigger");
    assert.ok(!r.stdout.includes("truncated"), "stdout should NOT have truncation marker");
    assert.ok(!r.stdout.includes("showing first"), "stdout should NOT have head/tail marker");
  });
});

describe("Large Output Auto-Indexing", () => {
  test("large stdout is fully preserved by executor", async () => {
    const executor = new PolyglotExecutor({ runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 100; i++) console.log(`line ${i}: ${"x".repeat(20)}`);',
    });
    assert.ok(r.stdout.includes("line 0"), "Should contain first line");
    assert.ok(r.stdout.includes("line 50"), "Should contain middle line");
    assert.ok(r.stdout.includes("line 99"), "Should contain last line");
    assert.ok(!r.stdout.includes("truncated"), "Should NOT be truncated");
  });

  test("large stdout is indexed into FTS5 and searchable", async () => {
    const store = new ContentStore(":memory:");
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(`line ${i}: data_value_${i}`);
    const largeOutput = lines.join("\n");

    const indexed = store.indexPlainText(largeOutput, "test:large-output");
    assert.ok(indexed.totalChunks > 1, "Should be chunked into multiple sections");

    const results = store.searchWithFallback("data_value_2500", 3, "test:large-output");
    assert.ok(results.length > 0, "Middle content should be searchable");
    assert.ok(results[0].content.includes("2500"), "Should find the middle line");

    store.close();
  });

  test("small stdout is returned inline as-is", async () => {
    const executor = new PolyglotExecutor({ runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("hello world");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello world"));
    assert.ok(!r.stdout.includes("Indexed"), "Small output should NOT be indexed pointer");
  });
});

describe("Cross-Language Cap", () => {
  test("shell: cap works with shell scripts", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 2048, runtimes });
    const r = await executor.execute({
      language: "shell",
      code: 'yes "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" | head -c 100000',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Cap should trigger for shell output");
  });

  test.runIf(runtimes.python)("python: cap works with python scripts", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 2048, runtimes });
    const r = await executor.execute({
      language: "python",
      code: 'import sys\nfor i in range(10000):\n    sys.stdout.write("x" * 50 + "\\n")',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Cap should trigger for python output");
  });
});

describe("Interleaved Output", () => {
  test("interleaved: rapid alternating stdout/stderr triggers cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 4096, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 5000; i++) { if (i % 2 === 0) process.stdout.write("out" + i + "\\n"); else process.stderr.write("err" + i + "\\n"); }',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Interleaved output should trigger cap");
  });
});

describe("executeFile Cap", () => {
  test("executeFile: cap applies to file execution too", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cap-test-"));
    const testFile = join(tmpDir, "data.txt");
    writeFileSync(testFile, "test content", "utf-8");

    try {
      const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
      const r = await executor.executeFile({
        path: testFile,
        language: "javascript",
        code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
        timeout: 10_000,
      });
      assert.ok(r.stderr.includes("output capped"), "executeFile should also respect the hard cap");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Turndown HTML-to-markdown conversion
// ═══════════════════════════════════════════════════════════════════════════

// Resolve turndown path the same way server.ts will
const require = createRequire(import.meta.url);
const turndownPath = require.resolve("turndown");
const gfmPath = require.resolve("turndown-plugin-gfm");

const turndownExecutor = new PolyglotExecutor();

function buildConversionCode(html: string): string {
  return `
const TurndownService = require(${JSON.stringify(turndownPath)});
const { gfm } = require(${JSON.stringify(gfmPath)});
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
td.use(gfm);
td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
console.log(td.turndown(${JSON.stringify(html)}));
`;
}

describe("turndown HTML-to-markdown conversion tests", () => {
  test("converts headings", async () => {
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode("<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>"),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(result.stdout.includes("# Title"), `expected '# Title', got: ${result.stdout}`);
    assert(result.stdout.includes("## Subtitle"));
    assert(result.stdout.includes("### Section"));
  });

  test("converts links", async () => {
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode('<p>Visit <a href="https://example.com">Example</a></p>'),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(result.stdout.includes("[Example](https://example.com)"));
  });

  test("converts fenced code blocks", async () => {
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode('<pre><code class="language-js">const x = 1;</code></pre>'),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(result.stdout.includes("```"), `expected fenced code block, got: ${result.stdout}`);
    assert(result.stdout.includes("const x = 1;"));
  });

  test("strips script tags", async () => {
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode("<p>Hello</p><script>alert('xss')</script><p>World</p>"),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(!result.stdout.includes("alert"), `script content leaked: ${result.stdout}`);
    assert(result.stdout.includes("Hello"));
    assert(result.stdout.includes("World"));
  });

  test("strips style, nav, header, footer, noscript tags", async () => {
    const html = [
      "<style>body { color: red; }</style>",
      "<header><nav>Menu</nav></header>",
      "<main><p>Content</p></main>",
      "<footer>Footer</footer>",
      "<noscript>Enable JS</noscript>",
    ].join("");
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode(html),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(result.stdout.includes("Content"), `lost main content: ${result.stdout}`);
    assert(!result.stdout.includes("Menu"), `nav leaked: ${result.stdout}`);
    assert(!result.stdout.includes("Footer"), `footer leaked: ${result.stdout}`);
    assert(!result.stdout.includes("Enable JS"), `noscript leaked: ${result.stdout}`);
    assert(!result.stdout.includes("color: red"), `style leaked: ${result.stdout}`);
  });

  test("converts tables", async () => {
    const html = `
    <table>
      <thead><tr><th>Name</th><th>Age</th></tr></thead>
      <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
    </table>`;
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode(html),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(result.stdout.includes("| Name"), `expected pipe table, got: ${result.stdout}`);
    assert(result.stdout.includes("| Alice"));
    assert(result.stdout.includes("| ---"), `expected table separator, got: ${result.stdout}`);
  });

  test("handles nested tags correctly", async () => {
    const html = '<div><p>Outer <strong>bold <em>and italic</em></strong> text</p></div>';
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode(html),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(result.stdout.includes("**bold"), `missing bold: ${result.stdout}`);
    assert(result.stdout.includes("italic"), `missing italic: ${result.stdout}`);
  });

  test("handles malformed HTML gracefully", async () => {
    const html = "<p>Unclosed paragraph<p>Another<div>Nested badly</p></div>";
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode(html),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(result.stdout.includes("Unclosed paragraph"), `lost content: ${result.stdout}`);
    assert(result.stdout.includes("Nested badly"), `lost nested content: ${result.stdout}`);
  });

  test("decodes HTML entities", async () => {
    const result = await turndownExecutor.execute({
      language: "javascript",
      code: buildConversionCode("<p>Tom &amp; Jerry &lt;3 &quot;cheese&quot;</p>"),
    });
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert(result.stdout.includes('Tom & Jerry <3 "cheese"'), `entities not decoded: ${result.stdout}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Project Directory Path Resolution (project-dir)
// ═══════════════════════════════════════════════════════════════════════════

// Set up two isolated directories to simulate the scenario:
// - pluginDir: where the plugin is installed (start.sh does cd here)
// - projectDir: where the user's project lives (the real cwd)
const projDirBaseDir = join(tmpdir(), "ctx-mode-projdir-test-" + Date.now());
const projectDir = join(projDirBaseDir, "user-project");
const pluginDir = join(projDirBaseDir, "plugin-install");
mkdirSync(projectDir, { recursive: true });
mkdirSync(pluginDir, { recursive: true });

// Create a test file in the user's project directory
const testFileName = "data.json";
const testData = { message: "hello from project dir", count: 42 };
writeFileSync(
  join(projectDir, testFileName),
  JSON.stringify(testData),
  "utf-8",
);

// Also create a different file with the same name in the plugin directory
// to prove we're reading from the right place
const pluginData = { message: "wrong directory", count: 0 };
writeFileSync(
  join(pluginDir, testFileName),
  JSON.stringify(pluginData),
  "utf-8",
);

afterAll(() => {
  rmSync(projDirBaseDir, { recursive: true, force: true });
});

describe("executeFile: projectRoot path resolution", () => {
  test("relative path resolves against projectRoot, not cwd", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: testFileName, // relative path — should resolve to projectDir/data.json
      language: "javascript",
      code: `
        const data = JSON.parse(FILE_CONTENT);
        console.log(data.message);
      `,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0, got ${r.exitCode}: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("hello from project dir"),
      `Should read from projectDir, got: ${r.stdout.trim()}`,
    );
  });

  test("relative path with subdirectory resolves against projectRoot", async () => {
    const subDir = join(projectDir, "nested", "deep");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "nested.txt"), "nested content here", "utf-8");

    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: "nested/deep/nested.txt",
      language: "javascript",
      code: `console.log(FILE_CONTENT.trim());`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("nested content here"));
  });

  test("absolute path ignores projectRoot", async () => {
    const absFile = join(projDirBaseDir, "absolute-test.txt");
    writeFileSync(absFile, "absolute path content", "utf-8");

    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: absFile, // absolute path — projectRoot should be ignored
      language: "javascript",
      code: `console.log(FILE_CONTENT.trim());`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("absolute path content"));
  });

  test("default projectRoot is process.cwd()", async () => {
    // Create a file in the actual cwd
    const cwdFile = join(process.cwd(), ".ctx-mode-test-cwd-" + Date.now() + ".tmp");
    writeFileSync(cwdFile, "cwd content", "utf-8");

    try {
      const executor = new PolyglotExecutor({ runtimes });

      const r = await executor.executeFile({
        path: cwdFile,
        language: "javascript",
        code: `console.log(FILE_CONTENT.trim());`,
      });

      assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
      assert.ok(r.stdout.includes("cwd content"));
    } finally {
      rmSync(cwdFile, { force: true });
    }
  });
});

describe("CLAUDE_PROJECT_DIR env var integration", () => {
  test("PolyglotExecutor accepts projectRoot option", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: "/some/custom/path",
    });

    // Verify the executor was created without error
    // The projectRoot is private, so we verify it indirectly via executeFile
    assert.ok(executor, "Executor should be created with custom projectRoot");
  });

  test("executeFile fails gracefully for non-existent relative path", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: "does-not-exist.json",
      language: "javascript",
      code: `console.log(FILE_CONTENT);`,
    });

    assert.notEqual(r.exitCode, 0, "Should fail for non-existent file");
  });
});

describe("Multi-language relative path resolution", () => {
  if (runtimes.python) {
    test("Python: relative path resolves against projectRoot", async () => {
      const executor = new PolyglotExecutor({
        runtimes,
        projectRoot: projectDir,
      });

      const r = await executor.executeFile({
        path: testFileName,
        language: "python",
        code: `
import json
data = json.loads(FILE_CONTENT)
print(f"msg: {data['message']}")
print(f"count: {data['count']}")
        `,
      });

      assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
      assert.ok(r.stdout.includes("msg: hello from project dir"));
      assert.ok(r.stdout.includes("count: 42"));
    });
  }

  test("Shell: relative path resolves against projectRoot", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: testFileName,
      language: "shell",
      code: `echo "content: $FILE_CONTENT"`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("hello from project dir"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_index: projectRoot path resolution (#365)
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors the executeFile relative-path resolution tests (line ~598). Confirms
// that ctx_index resolves a relative `path` argument against the detected
// project directory (CLAUDE_PROJECT_DIR / *_PROJECT_DIR / CONTEXT_MODE_PROJECT_DIR
// → cwd fallback) instead of the MCP server process cwd. End-to-end via
// JSON-RPC against a freshly spawned server with an injected project dir.

describe("ctx_index: projectRoot path resolution (#365)", () => {
  const ctxProjectDir = mkdtempSync(join(tmpdir(), "ctx-index-projroot-"));
  const ctxFileName = "ctx-index-projroot-target.md";
  const uniqueMarker = `ctx-index-marker-${process.pid}-${Date.now()}`;

  beforeAll(() => {
    writeFileSync(
      join(ctxProjectDir, ctxFileName),
      `# ctx_index relative path test\n\nUnique marker: ${uniqueMarker}\n`,
      "utf-8",
    );
  });

  afterAll(() => {
    rmSync(ctxProjectDir, { recursive: true, force: true });
  });

  function spawnServerWithProjectDir(projectDirEnv: string): ChildProcess {
    return spawn("node", [mcpEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
        CLAUDE_PROJECT_DIR: projectDirEnv,
      },
    });
  }

  // MCP server processes JSON-RPC requests concurrently — we have to wait for
  // each response before sending the next one in tests that depend on order
  // (e.g. index then search). The shared `collectRpcResponses` helper kills
  // the proc once all expected ids arrive, so we use it serially per-call.
  async function awaitRpc(
    proc: ChildProcess,
    id: number,
    request: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<DoctorJsonRpcResponse | undefined> {
    return new Promise((resolve) => {
      let buffer = "";
      const onData = (d: Buffer) => {
        buffer += d.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as DoctorJsonRpcResponse;
            if (parsed.id === id) {
              proc.stdout!.off("data", onData);
              clearTimeout(timer);
              resolve(parsed);
              return;
            }
          } catch { /* ignore */ }
        }
      };
      const timer = setTimeout(() => {
        proc.stdout!.off("data", onData);
        resolve(undefined);
      }, timeoutMs);
      proc.stdout!.on("data", onData);
      sendRpc(proc, request);
    });
  }

  test("relative path resolves against CLAUDE_PROJECT_DIR, not server cwd", async () => {
    const proc = spawnServerWithProjectDir(ctxProjectDir);
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-pr365", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: ctxFileName } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);

      // Only send search AFTER index has completed — MCP server processes
      // requests concurrently, so a piggybacked search would race the index.
      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [uniqueMarker] } },
      });

      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(uniqueMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  test("absolute path bypasses project-dir resolution", async () => {
    const absFile = join(ctxProjectDir, ctxFileName);
    const proc = spawnServerWithProjectDir("/non-existent-dir-on-purpose");
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-pr365-abs", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: absFile } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);
      // Strengthened (FIX 3/10 C): assert the stored source label equals the
      // absolute path verbatim. Server defaults source = path when caller does
      // not pass an explicit source; the response text reports `from: <label>`,
      // so finding the absolute path here proves the resolver passed it
      // through intact instead of e.g. silently rewriting under projectDir.
      expect(indexText).toContain(`from: ${absFile}`);

      // Cross-check the same label round-trips through the FTS5 store: a
      // ctx_search scoped to source = <abs path> must surface the file's
      // unique marker. If the new resolver code path were skipped, the
      // absolute path would not be a valid lookup key here.
      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [uniqueMarker], source: absFile } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(uniqueMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 3/10 — negative-path coverage for ctx_index path resolution.
  //
  // PR #365 added happy-path tests above. The two tests below pin the P0
  // negative behaviors that those tests miss:
  //   A. `../` path traversal → currently allowed (trust-boundary policy).
  //      Pinned so future security-jail PRs surface the policy change here.
  //   B. ALL `*_PROJECT_DIR` envs unset → resolver falls back to spawned
  //      server's process.cwd().
  //   C. (above) Strengthens the absolute-path test with a source-label
  //      round-trip.
  // ─────────────────────────────────────────────────────────────────────────

  test("relative `../` path traversal still resolves and reads (current trust-boundary policy)", async () => {
    // Layout: <baseDir>/escape.md  +  <baseDir>/sub1/sub2 (= projectDir)
    // From projectDir, "../../escape.md" climbs back to <baseDir>/escape.md.
    const baseDir = mkdtempSync(join(tmpdir(), "ctx-index-traversal-"));
    const traversalProjectDir = join(baseDir, "sub1", "sub2");
    mkdirSync(traversalProjectDir, { recursive: true });
    const traversalMarker = `ctx-index-traversal-marker-${process.pid}-${Date.now()}`;
    writeFileSync(
      join(baseDir, "escape.md"),
      `# Path traversal target\n\nUnique marker: ${traversalMarker}\n`,
      "utf-8",
    );

    const proc = spawnServerWithProjectDir(traversalProjectDir);
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-fix3-traversal", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "../../escape.md" } },
      });

      // Current policy: ctx_index trusts the host IDE's project boundary and
      // does not jail relative paths. A `../` escape that points at a real
      // file is RESOLVED and READ. If a future security PR introduces a
      // jail, this assertion will fail and force an explicit policy update.
      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);

      // Confirm the file's contents actually entered the store (not a
      // silent no-op masquerading as success).
      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [traversalMarker] } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(traversalMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      rmSync(baseDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("no *_PROJECT_DIR env set → relative path falls back to spawned-server cwd", async () => {
    // Strip every project-dir env the resolver chain consults (see
    // server.ts getProjectDir) so resolution is forced down to process.cwd().
    // start.mjs would re-set CONTEXT_MODE_PROJECT_DIR and CLAUDE_PROJECT_DIR
    // from originalCwd — that originalCwd is the `cwd` we hand to spawn(),
    // which is exactly what we want to assert on.
    const fallbackCwd = mkdtempSync(join(tmpdir(), "ctx-index-cwdfallback-"));
    const fallbackFile = "t.md";
    const fallbackMarker = `ctx-index-cwdfallback-marker-${process.pid}-${Date.now()}`;
    writeFileSync(
      join(fallbackCwd, fallbackFile),
      `# cwd fallback target\n\nUnique marker: ${fallbackMarker}\n`,
      "utf-8",
    );

    const strippedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== "string") continue;
      if (/_PROJECT_DIR$/.test(k)) continue;
      if (k === "VSCODE_CWD") continue;
      strippedEnv[k] = v;
    }
    strippedEnv.CONTEXT_MODE_DISABLE_VERSION_CHECK = "1";

    const proc = spawn("node", [mcpEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: fallbackCwd,
      env: strippedEnv,
    });
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-fix3-cwd", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: fallbackFile } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);

      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [fallbackMarker] } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(fallbackMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      rmSync(fallbackCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("relative path label canonicalizes to resolved absolute path", async () => {
    const proc = spawnServerWithProjectDir(ctxProjectDir);
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-pr365-label", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: ctxFileName } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      // Label must canonicalize to the resolved absolute path so the same file
      // indexed via './foo.md', 'foo.md', and 'subdir/../foo.md' produces a
      // single FTS5 row (sources.label is the dedup key).
      const expectedAbs = join(ctxProjectDir, ctxFileName);
      expect(indexText).toContain(`from: ${expectedAbs}`);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  // ── JetBrains regression: IDEA_INITIAL_DIRECTORY must enter the cascade ──
  //
  // JetBrains adapter sets only IDEA_INITIAL_DIRECTORY (no CLAUDE_PROJECT_DIR,
  // no CONTEXT_MODE_PROJECT_DIR). Before the fix, getProjectDir() ignored that
  // var and fell through to process.cwd(), which is the IDE bin dir on
  // JetBrains — making `ctx_index({ path: "rel/foo.md" })` resolve to a path
  // under the IDE installation and ENOENT.
  //
  // Spawn the compiled server directly (build/server.js) instead of start.mjs
  // so we never enter the start.mjs path that auto-populates CLAUDE_PROJECT_DIR
  // and CONTEXT_MODE_PROJECT_DIR from cwd. This lets us isolate the cascade
  // and prove that IDEA_INITIAL_DIRECTORY alone is enough to resolve relative
  // paths under the JetBrains project root.
  test("relative path resolves against IDEA_INITIAL_DIRECTORY (JetBrains)", async () => {
    const buildEntry = resolve(__dirname, "..", "..", "build", "server.js");
    if (!existsSync(buildEntry)) {
      // Compile src → build/ on demand. Bundle is untouched (CI rebuilds it).
      execSync("npx tsc --silent", {
        cwd: resolve(__dirname, "..", ".."),
        stdio: "pipe",
        timeout: 60_000,
      });
    }

    // Simulate JetBrains: cwd is an IDE-bin-like dir (NOT the project),
    // env carries only IDEA_INITIAL_DIRECTORY pointing at the real project.
    const fakeIdeBin = mkdtempSync(join(tmpdir(), "ctx-jetbrains-bin-"));

    // Strip every PROJECT_DIR env var from the inherited env so the cascade
    // is forced to consult IDEA_INITIAL_DIRECTORY.
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDE_PROJECT_DIR;
    delete cleanEnv.GEMINI_PROJECT_DIR;
    delete cleanEnv.VSCODE_CWD;
    delete cleanEnv.OPENCODE_PROJECT_DIR;
    delete cleanEnv.PI_PROJECT_DIR;
    delete cleanEnv.CONTEXT_MODE_PROJECT_DIR;

    const proc = spawn("node", [buildEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: fakeIdeBin,
      env: {
        ...cleanEnv,
        CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
        IDEA_INITIAL_DIRECTORY: ctxProjectDir,
      },
    });

    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-jetbrains", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: ctxFileName } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      // Must succeed — proves the relative path resolved under
      // IDEA_INITIAL_DIRECTORY (not the fake IDE-bin cwd).
      expect(indexText).toMatch(/Indexed \d+ section/);
      expect(indexText).not.toMatch(/Index error/);

      // Round-trip via search using the unique marker only present in the
      // file under IDEA_INITIAL_DIRECTORY — proves the right file was read.
      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [uniqueMarker] } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(uniqueMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      try { rmSync(fakeIdeBin, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 60_000);

  // Source-label dedup regression: when no explicit `source` is supplied,
  // ctx_index must default the FTS5 label to the *resolved* absolute path so
  // that the same file indexed via './foo.md', 'foo.md', or 'subdir/../foo.md'
  // collapses into a single row (sources.label is the dedup key).
  //
  // This pins behavior at two layers:
  //   1. The store-level dedup contract: identical labels overwrite, distinct
  //      labels produce distinct rows.
  //   2. The ctx_index source-resolution decision lives in src/server.ts and
  //      must read `source ?? resolvedPath`, NOT `source ?? path` (which would
  //      preserve raw user-typed input and break dedup).
  test("source-label dedup: identical labels collapse, raw user-typed paths would not", () => {
    const store = new ContentStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "source-label-dedup-"));
    const file = "foo.md";
    const abs = join(dir, file);
    const marker = `dedup-marker-${process.pid}-${Date.now()}`;
    writeFileSync(abs, `# foo\n\nUnique marker: ${marker}\n`, "utf-8");

    try {
      // Post-fix simulation: server canonicalizes both spellings to `abs`
      // before calling store.index → single label → single row.
      store.index({ content: readFileSync(abs, "utf-8"), path: abs, source: abs });
      store.index({ content: readFileSync(abs, "utf-8"), path: abs, source: abs });

      const dedupResults = store.search(marker, 10);
      expect(dedupResults.length).toBe(1);
      expect(dedupResults[0].source).toBe(abs);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Server-side guard: the source-label fallback must canonicalize to
  // resolvedPath, not to the raw user-typed `path`. Validates the actual
  // src/server.ts decision so a regression to `source ?? path` fails CI even
  // before bundle rebuild and end-to-end spawn coverage.
  test("source-label canonicalization: src/server.ts uses `source ?? resolvedPath`", () => {
    const serverSrc = readFileSync(
      resolve(__dirname, "../../src/server.ts"),
      "utf-8",
    );
    // Locate the ctx_index store.index call site and assert canonical fallback.
    const indexCall = serverSrc.match(
      /store\.index\(\{[^}]*source:\s*source\s*\?\?\s*(\w+)/,
    );
    expect(indexCall).not.toBeNull();
    expect(indexCall![1]).toBe("resolvedPath");
    // Negative guard: no place in ctx_index falls back to raw `path`.
    expect(serverSrc).not.toMatch(/store\.index\(\{[^}]*source:\s*source\s*\?\?\s*path[\s,}]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_index: Read deny-policy enforcement (#442)
// ═══════════════════════════════════════════════════════════════════════════
//
// Real-MCP integration test: ctx_execute_file calls checkFilePathDenyPolicy
// before reading the file, but ctx_index historically skipped the check —
// any file readable by the MCP server process could be indexed into FTS5
// and exfiltrated through ctx_search. This pins the fix end-to-end via
// JSON-RPC against a freshly spawned server with .claude/settings.json
// containing a Read deny pattern matching the target file.

describe("ctx_index: Read deny-policy enforcement (#442)", () => {
  // Per-test projectDir prevents FTS5 cross-pollution between tests and
  // removes order-coupling on the empty-store cross-check.
  function setupProject(
    denyRules: string[],
    files: Record<string, string>,
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "ctx-index-deny-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: denyRules } }),
      "utf-8",
    );
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
    return dir;
  }

  function spawnServerInProject(projectDir: string): ChildProcess {
    return spawn("node", [mcpEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
        CLAUDE_PROJECT_DIR: projectDir,
      },
    });
  }

  // Rejects on timeout (rather than resolving undefined) so silent
  // server-spawn / import failures surface as a failing test instead of
  // false-positive assertions on optional-chained undefined access.
  async function awaitRpc(
    proc: ChildProcess,
    request: Record<string, unknown> & { id: number },
    timeoutMs = 15_000,
  ): Promise<DoctorJsonRpcResponse> {
    const id = request.id;
    return new Promise((resolve, reject) => {
      let buffer = "";
      let stderr = "";
      const onStderr = (d: Buffer) => { stderr += d.toString(); };
      const onData = (d: Buffer) => {
        buffer += d.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as DoctorJsonRpcResponse;
            if (parsed.id === id) {
              proc.stdout!.off("data", onData);
              proc.stderr!.off("data", onStderr);
              clearTimeout(timer);
              resolve(parsed);
              return;
            }
          } catch { /* not JSON-RPC line */ }
        }
      };
      const timer = setTimeout(() => {
        proc.stdout!.off("data", onData);
        proc.stderr!.off("data", onStderr);
        reject(new Error(
          `awaitRpc timeout after ${timeoutMs}ms for id=${id} method=${request.method}\n` +
          `stderr: ${stderr.slice(-2000)}`,
        ));
      }, timeoutMs);
      proc.stdout!.on("data", onData);
      proc.stderr!.on("data", onStderr);
      sendRpc(proc, request);
    });
  }

  async function initServer(proc: ChildProcess, clientName: string): Promise<void> {
    await awaitRpc(proc, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "1.0" } },
    });
    sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function killProc(proc: ChildProcess): void {
    try { proc.kill("SIGTERM"); } catch { /* best effort */ }
  }

  test("ctx_index({ path: <denied> }) returns deny-policy error and never indexes", async () => {
    const secretMarker = `secret-marker-${process.pid}-${Date.now()}`;
    const projectDir = setupProject(
      ["Read(./secret.env)", "Read(secret.env)"],
      { "secret.env": `SECRET_TOKEN=${secretMarker}\n` },
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-deny-442");

      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "secret.env" } },
      });

      expect(indexResp.error).toBeUndefined();
      expect(indexResp.result?.isError).toBe(true);
      const indexText = indexResp.result?.content?.[0]?.text ?? "";
      expect(indexText).toContain("blocked by security policy");
      expect(indexText).toContain("Read deny pattern");
      // Pin the matched pattern so a future bug firing the wrong rule
      // cannot pass on the generic substring alone.
      expect(indexText).toMatch(/Read deny pattern \.?\/?secret\.env/);
      expect(indexText).not.toMatch(/Indexed \d+ section/);

      // Per-test projectDir guarantees an empty FTS5 store, so the secret
      // marker absence is the load-bearing exfil-prevention pin.
      const searchResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [secretMarker] } },
      });
      expect(searchResp.error).toBeUndefined();
      const searchText = searchResp.result?.content?.[0]?.text ?? "";
      const searchedEmpty =
        searchText.includes("No results found") ||
        searchText.includes("After indexing");
      expect(searchedEmpty).toBe(true);
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ path: <denied via glob *.env> }) blocks", async () => {
    const projectDir = setupProject(
      ["Read(*.env)"],
      { "secret.env": `SECRET_TOKEN=glob-${process.pid}\n` },
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-deny-glob-442");
      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "secret.env" } },
      });
      expect(indexResp.result?.isError).toBe(true);
      const text = indexResp.result?.content?.[0]?.text ?? "";
      expect(text).toContain("blocked by security policy");
      expect(text).toMatch(/Read deny pattern .*\*\.env/);
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ path: <absolute denied> }) blocks", async () => {
    const projectDir = setupProject(
      [], // populated below after we know absolute path
      { "secret.env": `SECRET_TOKEN=abs-${process.pid}\n` },
    );
    const absSecret = join(projectDir, "secret.env");
    // Rewrite settings.json with the absolute deny rule.
    writeFileSync(
      join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: [`Read(${absSecret})`] } }),
      "utf-8",
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-deny-abs-442");
      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: absSecret } },
      });
      expect(indexResp.result?.isError).toBe(true);
      const text = indexResp.result?.content?.[0]?.text ?? "";
      expect(text).toContain("blocked by security policy");
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ path: <denied via ../traversal> }) blocks", async () => {
    // Use a glob deny rule that matches the canonical (lexical/realpath)
    // form — proves evaluateFilePath's canonicalization defeats the
    // `sub/../secret.env` traversal trick.
    const projectDir = setupProject(
      ["Read(**/secret.env)"],
      {
        "secret.env": `SECRET_TOKEN=trav-${process.pid}\n`,
        "sub/placeholder.md": "# placeholder\n",
      },
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-deny-trav-442");
      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "sub/../secret.env" } },
      });
      expect(indexResp.result?.isError).toBe(true);
      const text = indexResp.result?.content?.[0]?.text ?? "";
      expect(text).toContain("blocked by security policy");
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ path: <allowed> }) succeeds and is searchable", async () => {
    const allowedMarker = `allowed-marker-${process.pid}-${Date.now()}`;
    const projectDir = setupProject(
      ["Read(./secret.env)", "Read(secret.env)"],
      { "public-doc.md": `# Public doc\n\n${allowedMarker}\n` },
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-allow-442");

      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "public-doc.md" } },
      });
      expect(indexResp.error).toBeUndefined();
      expect(indexResp.result?.isError).toBeFalsy();
      const indexText = indexResp.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);

      const searchResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [allowedMarker] } },
      });
      expect(searchResp.error).toBeUndefined();
      expect(searchResp.result?.content?.[0]?.text ?? "").toContain(allowedMarker);
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ content: ... }) bypass branch — gate truly tied to `path`", async () => {
    // Configure a deny rule that WOULD match the inline `source` value if
    // the gate naively ran on it. Success here proves the bypass is keyed
    // on `path` absence, not on `source`.
    const projectDir = setupProject(
      ["Read(test-inline)", "Read(./test-inline)"],
      {},
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-content-442");
      const inlineMarker = `inline-marker-${process.pid}-${Date.now()}`;
      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: {
          name: "ctx_index",
          arguments: {
            content: `# Inline\n\n${inlineMarker}\n`,
            source: "test-inline",
          },
        },
      });
      expect(indexResp.error).toBeUndefined();
      expect(indexResp.result?.isError).toBeFalsy();
      expect(indexResp.result?.content?.[0]?.text ?? "").toMatch(/Indexed \d+ section/);
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_insight: execFile migration + port schema hardening (#441)
// ═══════════════════════════════════════════════════════════════════════════
//
// Three layers of regression protection:
//
//   1. Coarse source guard — `src/server.ts` must not reintroduce the
//      `execSync(\`…${…}…\`)` template-string injection pattern anywhere.
//      Behavioral coverage of the helpers themselves lives below in this
//      same file (mocked spawnSync, asserts argv arrays + no shell:true +
//      Windows LISTENING anchoring + per-pid failure isolation).
//
//   2. Cross-reference — server.ts must define the structured helpers
//      (openBrowserSync / killProcessOnPort) inline so the handler can
//      surface auto-open / kill failures to the agent rather than silently
//      reporting success.
//
//   3. Real-MCP integration — spawn the server via stdio JSON-RPC and
//      verify the tightened port schema rejects out-of-range and
//      non-integer values BEFORE the handler runs.

describe("ctx_insight: execFile migration source guard (#441)", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("server.ts contains no execSync template-string interpolation anywhere", () => {
    // Match: execSync(`...${...}...`) — the original injection pattern.
    // Scoped to the entire file (not just the ctx_insight handler) because
    // any reintroduction of the pattern in server.ts is a regression worth
    // catching.
    const templateInterpolation = /execSync\(`[^`]*\$\{/m;
    expect(serverSrc).not.toMatch(templateInterpolation);
  });

  test("server.ts defines structured helpers (openBrowserSync, killProcessOnPort)", () => {
    // The helpers must be the ones that return BrowserOpenResult / KillResult
    // so the ctx_insight handler can surface failures. They live inline in
    // server.ts (PR #452 folded the prior src/process-utils.ts back in).
    expect(serverSrc).toMatch(/export function openBrowserSync\b/);
    expect(serverSrc).toMatch(/export function killProcessOnPort\b/);
    expect(serverSrc).toMatch(/export type BrowserOpenResult\b/);
    expect(serverSrc).toMatch(/export type KillResult\b/);
  });

  test("port schema is bounded to a valid TCP port range", () => {
    const portDecl = serverSrc.match(/port:\s*z\.coerce\.number\(\)([^,\n]*)\.optional\(\)/);
    expect(portDecl).not.toBeNull();
    const constraints = portDecl![1];
    expect(constraints).toContain(".int()");
    expect(constraints).toContain(".min(1)");
    expect(constraints).toContain(".max(65535)");
  });
});

describe("ctx_insight: port schema rejects invalid values (#441)", () => {
  function spawnInsightServer(): ChildProcess {
    return spawn("node", [mcpEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CONTEXT_MODE_DISABLE_VERSION_CHECK: "1" },
    });
  }

  async function awaitRpc(
    proc: ChildProcess,
    id: number,
    request: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<DoctorJsonRpcResponse | undefined> {
    return new Promise((resolve) => {
      let buffer = "";
      const onData = (d: Buffer) => {
        buffer += d.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as DoctorJsonRpcResponse;
            if (parsed.id === id) {
              proc.stdout!.off("data", onData);
              clearTimeout(timer);
              resolve(parsed);
              return;
            }
          } catch { /* ignore */ }
        }
      };
      const timer = setTimeout(() => {
        proc.stdout!.off("data", onData);
        resolve(undefined);
      }, timeoutMs);
      proc.stdout!.on("data", onData);
      sendRpc(proc, request);
    });
  }

  // Each invalid value is exercised against a fresh server so a schema
  // failure on one input cannot mask a regression on another.
  const invalidPortCases: Array<{ label: string; port: unknown }> = [
    { label: "zero (below min)", port: 0 },
    { label: "negative (below min)", port: -1 },
    { label: "above 16-bit range", port: 65536 },
    { label: "non-integer", port: 3.14 },
    { label: "non-numeric string", port: "not-a-port" },
  ];

  for (const { label, port } of invalidPortCases) {
    test(`rejects port=${JSON.stringify(port)} (${label}) at schema layer`, async () => {
      const proc = spawnInsightServer();
      try {
        const init = await awaitRpc(proc, 1, {
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-insight-441", version: "1.0" } },
        });
        // Init must succeed before tools/call — otherwise an unrelated startup
        // failure could masquerade as schema rejection.
        expect(init?.result).toBeDefined();
        sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

        const resp = await awaitRpc(proc, 100, {
          jsonrpc: "2.0", id: 100, method: "tools/call",
          params: { name: "ctx_insight", arguments: { port } },
        });

        // Schema rejection surfaces as either a JSON-RPC `error` envelope or
        // a tool result with `isError: true`. Both shapes count as "the
        // handler never executed" — the contract this test pins.
        const rejected =
          (resp?.error !== undefined) ||
          (resp?.result?.isError === true);
        expect(rejected).toBe(true);

        // Cross-check: no "Dashboard running" success text leaked through.
        const text = resp?.result?.content?.[0]?.text ?? "";
        expect(text).not.toMatch(/Dashboard running at/);
      } finally {
        try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      }
    }, 20_000);
  }

  // Pin the schema layer specifically: at least one case must surface as a
  // JSON-RPC `error` with code -32602 (Invalid params), proving zod rejected
  // the input before the handler ran.  A regression that loosened the schema
  // back to `z.coerce.number().optional()` and let the handler crash on
  // `port=0` would still satisfy the lenient `isError === true` checks above
  // — but it would not produce a -32602 envelope here.
  test("schema layer rejects out-of-range port with JSON-RPC -32602", async () => {
    const proc = spawnInsightServer();
    try {
      const init = await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-insight-441-schema", version: "1.0" } },
      });
      expect(init?.result).toBeDefined();
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const resp = await awaitRpc(proc, 200, {
        jsonrpc: "2.0", id: 200, method: "tools/call",
        params: { name: "ctx_insight", arguments: { port: 70000 } },
      });

      // Either a top-level error with code -32602 or an isError result whose
      // text mentions schema/range-validation language. Both prove zod fired.
      const errCode = resp?.error?.code;
      const text = resp?.result?.content?.[0]?.text ?? "";
      const schemaSignal =
        errCode === -32602 ||
        /(less than or equal|65535|invalid|too_big|expected number)/i.test(text);
      expect(schemaSignal).toBe(true);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_execute_file: projectRoot env cascade parity with ctx_index
// ═══════════════════════════════════════════════════════════════════════════
//
// Regression for PR #365 follow-up. ctx_index was routed through the
// `getProjectDir()` env cascade (CLAUDE_PROJECT_DIR → ... → CONTEXT_MODE_PROJECT_DIR
// → cwd) but the PolyglotExecutor still captured CLAUDE_PROJECT_DIR ?? cwd
// at construction time. ctx_execute_file therefore resolved the same
// relative path differently from ctx_index whenever only
// CONTEXT_MODE_PROJECT_DIR was set (e.g. Cursor / OpenClaw / Codex spawns).
// Fix: executor now resolves projectRoot lazily via the server's getProjectDir.

describe("ctx_execute_file: CONTEXT_MODE_PROJECT_DIR env cascade", () => {
  const execProjectDir = mkdtempSync(join(tmpdir(), "ctx-exec-projroot-"));
  const execScriptDir = join(execProjectDir, "rel");
  const execScriptName = "script.js";
  const execMarker = `ctx-exec-marker-${process.pid}-${Date.now()}`;

  // Spawn build/server.js directly to bypass start.mjs's auto-set of
  // CLAUDE_PROJECT_DIR = process.cwd(). That auto-set would defeat the
  // test by injecting a CLAUDE_PROJECT_DIR before getProjectDir() can
  // fall through to CONTEXT_MODE_PROJECT_DIR.
  const buildServerEntry = resolve(__dirname, "..", "..", "build", "server.js");

  beforeAll(() => {
    mkdirSync(execScriptDir, { recursive: true });
    writeFileSync(
      join(execScriptDir, execScriptName),
      `console.log(${JSON.stringify(execMarker)});\n`,
      "utf-8",
    );
  });

  afterAll(() => {
    rmSync(execProjectDir, { recursive: true, force: true });
  });

  function spawnServerCtxModeOnly(projectDirEnv: string): ChildProcess {
    // Strip every CLAUDE_*-style projectDir signal so the executor MUST
    // fall back through the env cascade to CONTEXT_MODE_PROJECT_DIR.
    const env = { ...process.env, CONTEXT_MODE_DISABLE_VERSION_CHECK: "1" };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.GEMINI_PROJECT_DIR;
    delete env.VSCODE_CWD;
    delete env.OPENCODE_PROJECT_DIR;
    delete env.PI_PROJECT_DIR;
    delete env.IDEA_INITIAL_DIRECTORY;
    env.CONTEXT_MODE_PROJECT_DIR = projectDirEnv;
    return spawn("node", [buildServerEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      // cwd far from execProjectDir so a stale `process.cwd()` snapshot
      // would resolve `rel/script.js` to a non-existent path.
      cwd: tmpdir(),
    });
  }

  async function awaitRpc(
    proc: ChildProcess,
    id: number,
    request: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<DoctorJsonRpcResponse | undefined> {
    return new Promise((res) => {
      let buffer = "";
      const onData = (d: Buffer) => {
        buffer += d.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as DoctorJsonRpcResponse;
            if (parsed.id === id) {
              proc.stdout!.off("data", onData);
              clearTimeout(timer);
              res(parsed);
              return;
            }
          } catch { /* ignore */ }
        }
      };
      const timer = setTimeout(() => {
        proc.stdout!.off("data", onData);
        res(undefined);
      }, timeoutMs);
      proc.stdout!.on("data", onData);
      sendRpc(proc, request);
    });
  }

  test("relative path resolves against CONTEXT_MODE_PROJECT_DIR when CLAUDE_PROJECT_DIR is unset", async () => {
    const proc = spawnServerCtxModeOnly(execProjectDir);
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-exec-cm-projdir", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const execResp = await awaitRpc(proc, 200, {
        jsonrpc: "2.0", id: 200, method: "tools/call",
        params: {
          name: "ctx_execute_file",
          arguments: {
            path: `rel/${execScriptName}`,
            language: "javascript",
            code: "eval(FILE_CONTENT);",
          },
        },
      });

      expect(execResp?.error).toBeUndefined();
      expect(execResp?.result?.isError ?? false).toBe(false);
      const text = execResp?.result?.content?.[0]?.text ?? "";
      expect(text).toContain(execMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Subagent Output Budget (subagent-budget)
// ═══════════════════════════════════════════════════════════════════════════

const HOOK_PATH = join(__dirname, "..", "..", "hooks", "pretooluse.mjs");
const LIVE = process.argv.includes("--live");

/**
 * TypeScript mock of hooks/pretooluse.mjs routing logic.
 * Replicates Task branch behavior without bash/jq dependency.
 */
function runHook(input: Record<string, unknown>): string {
  const toolName = (input as any).tool_name ?? "";
  const toolInput = (input as any).tool_input ?? {};

  if (toolName === "Task") {
    const subagentType = toolInput.subagent_type ?? "";
    const prompt = toolInput.prompt ?? "";

    if (subagentType === "Bash") {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: {
            ...toolInput,
            prompt: prompt + ROUTING_BLOCK,
            subagent_type: "general-purpose",
          },
        },
      });
    }

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...toolInput,
          prompt: prompt + ROUTING_BLOCK,
        },
      },
    });
  }

  // Non-Task tools return empty (passthrough)
  return "";
}

describe("Hook Injection", () => {
  test("Task hook injects context_window_protection XML block", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Research zod npm package", subagent_type: "general-purpose" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes("<context_window_protection>"),
      "Should inject context_window_protection opening tag",
    );
    assert.ok(
      prompt.includes("</context_window_protection>"),
      "Should inject context_window_protection closing tag",
    );
  });

  test("Task hook injects output constraints and tool hierarchy", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Research zod", subagent_type: "general-purpose" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes("<output_constraints>"), "Should inject output_constraints");
    assert.ok(prompt.includes("Terse like caveman"), "Should mention concise communication style");
    assert.ok(
      prompt.includes("<tool_selection_hierarchy>"),
      "Should inject tool_selection_hierarchy",
    );
    assert.ok(
      prompt.includes("<forbidden_actions>"),
      "Should inject forbidden_actions",
    );
  });

  test("Task hook injects batch_execute as primary tool", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Analyze repo", subagent_type: "Explore" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes("batch_execute"),
      "Should mention batch_execute as primary tool",
    );
  });

  test("Task hook upgrades Bash subagent to general-purpose", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Run git log", subagent_type: "Bash" },
    });
    const parsed = JSON.parse(output);
    const updated = parsed.hookSpecificOutput.updatedInput;
    assert.equal(
      updated.subagent_type,
      "general-purpose",
      "Bash should be upgraded to general-purpose",
    );
    assert.ok(
      updated.prompt.includes("<context_window_protection>"),
      "Upgraded subagent should also get context_window_protection",
    );
  });

  test("Task hook preserves original prompt content", () => {
    const original = "Research the architecture of Next.js App Router";
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: original, subagent_type: "general-purpose" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.startsWith(original),
      "Original prompt should be preserved at the start",
    );
  });

  test("Non-Task tools are not affected by output budget", () => {
    const output = runHook({
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    // Bash hook returns empty or redirect, never OUTPUT FORMAT
    assert.ok(
      !output.includes("OUTPUT FORMAT"),
      "Bash tool should not get output format injection",
    );
  });
});

describe("Shared Knowledge Base (subagent -> main)", () => {
  test("subagent index() is visible to main agent search()", () => {
    // Same ContentStore instance = same as shared MCP server process
    const store = new ContentStore(":memory:");

    // Simulate subagent indexing its research
    store.index({
      content: [
        "# Zod Overview",
        "TypeScript-first schema validation library.",
        "Zero dependencies, 98M weekly downloads.",
        "",
        "# API Reference",
        "z.string(), z.number(), z.object() are the core primitives.",
        "Use .parse() for runtime validation with type inference.",
        "",
        "# Recent Changes",
        "v4.3.6: Performance improvements to object parsing.",
        "v4.3.5: Fixed discriminated union edge case.",
      ].join("\n"),
      source: "subagent:zod-research",
    });

    // Simulate main agent searching subagent's indexed content
    const results = store.search("weekly downloads", 1, "zod-research");
    assert.ok(results.length > 0, "Main should find subagent's indexed content");
    assert.ok(
      results[0].content.includes("98M"),
      "Should retrieve exact data from subagent's index",
    );

    const apiResults = store.search("parse validation", 1, "zod-research");
    assert.ok(apiResults.length > 0, "Main should find API details");
    assert.ok(apiResults[0].content.includes(".parse()"), "Should find .parse() reference");

    store.close();
  });

  test("multiple subagents index into same KB with distinct sources", () => {
    const store = new ContentStore(":memory:");

    // Subagent A indexes architecture research
    store.index({
      content: "# Architecture\nMonorepo with pnpm workspaces. 15 packages.",
      source: "subagent-A:architecture",
    });

    // Subagent B indexes API research
    store.index({
      content: "# API Endpoints\nREST + GraphQL. 47 endpoints total.",
      source: "subagent-B:api",
    });

    // Subagent C indexes contributor analysis
    store.index({
      content: "# Contributors\nTop: @alice (312 commits), @bob (198 commits).",
      source: "subagent-C:contributors",
    });

    // Main agent searches each subagent's findings by source
    const arch = store.search("monorepo", 1, "subagent-A");
    assert.ok(arch.length > 0 && arch[0].content.includes("pnpm"));

    const api = store.search("endpoints", 1, "subagent-B");
    assert.ok(api.length > 0 && api[0].content.includes("47"));

    const contrib = store.search("commits", 1, "subagent-C");
    assert.ok(contrib.length > 0 && contrib[0].content.includes("alice"));

    // Cross-search without source filter finds all (OR mode for cross-chunk terms)
    const all = store.search("monorepo endpoints commits", 5, undefined, "OR");
    assert.ok(all.length >= 2, "Global search should find results from multiple subagents");

    store.close();
  });

  test("main agent can search subagent KB after subagent is done", () => {
    const store = new ContentStore(":memory:");

    // Subagent lifecycle: index → close (subagent done)
    store.index({
      content: "# Security Audit\nNo critical vulnerabilities found. 3 medium severity issues in auth module.",
      source: "subagent:security-audit",
    });
    // Subagent returns summary: "Indexed findings as 'subagent:security-audit'"

    // Main agent picks up later and searches
    const results = store.search("vulnerabilities auth", 1, "security-audit");
    assert.ok(results.length > 0);
    assert.ok(results[0].content.includes("3 medium severity"));

    store.close();
  });
});

describe("Context Budget Measurement", () => {
  test("ideal subagent response is under 500 words / 2KB", () => {
    // This is what a compliant subagent response should look like
    const idealResponse = [
      "## Summary",
      "- Researched zod npm package using batch_execute (1 call, 5 commands)",
      "- Indexed detailed findings as 'subagent:zod-research' (3 sections)",
      "",
      "## Key Findings",
      "- TypeScript-first schema validation, zero dependencies",
      "- v4.3.6 latest, 98.5M weekly downloads",
      "- 541 contributors, Colin McDonnell primary maintainer",
      "- MIT license, used by 2.8M+ projects",
      "",
      "## Indexed Sources",
      "- `subagent:zod-research` — full API docs, version history, contributor list",
      "",
      "Use `search(source: 'subagent:zod-research')` for details.",
    ].join("\n");

    const words = idealResponse.split(/\s+/).filter((w) => w.length > 0).length;
    const bytes = Buffer.byteLength(idealResponse);

    assert.ok(words < 500, `Ideal response should be under 500 words, got ${words}`);
    assert.ok(bytes < 2048, `Ideal response should be under 2KB, got ${bytes}`);
  });

  test("non-compliant response exceeds budget", () => {
    // Simulate what happens WITHOUT the output budget — full inline dump
    const bloatedResponse = Array.from(
      { length: 50 },
      (_, i) => `Line ${i}: Detailed information about zod feature ${i} with examples and code snippets...`,
    ).join("\n");

    const words = bloatedResponse.split(/\s+/).filter((w) => w.length > 0).length;
    const bytes = Buffer.byteLength(bloatedResponse);

    assert.ok(words > 500, "Bloated response should exceed 500 words");
  });
});

// Live LLM test — only runs when --live flag is passed
if (LIVE) {
  describe("Live LLM Test (claude -p)", () => {
    test("real subagent respects output budget", async () => {
      const prompt = `Research the npm package "chalk" — what it does, latest version, weekly downloads. Keep it brief.`;

      // Use claude CLI in pipe mode with haiku for speed
      const result = spawnSync(
        "claude",
        ["-p", "--model", "haiku", prompt],
        {
          encoding: "utf-8",
          timeout: 60_000,
          env: { ...process.env },
        },
      );

      if (result.error || result.status !== 0) {
        console.log("    Skipped: claude CLI not available or errored");
        console.log("    stderr:", result.stderr?.slice(0, 200));
        return;
      }

      const response = result.stdout;
      const words = response.split(/\s+/).filter((w: string) => w.length > 0).length;
      const bytes = Buffer.byteLength(response);

      // Soft assertion — LLM may not always comply perfectly
      if (words > 500) {
        console.log(`    WARNING: Response exceeded 500 word budget (${words} words)`);
      }

      assert.ok(
        words < 1000,
        `Response should be reasonable length, got ${words} words`,
      );
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ctx_upgrade: inline fallback for missing CLI files
// ═══════════════════════════════════════════════════════════════════════════

describe("ctx_upgrade tool: inline fallback for missing CLI", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, "../../package.json"), "utf-8"),
  );

  test("tries cli.bundle.mjs first", () => {
    expect(serverSrc).toContain("cli.bundle.mjs");
    // The bundle path should be checked before fallback
    expect(serverSrc).toMatch(/existsSync\(bundlePath\)/);
  });

  test("tries build/cli.js second", () => {
    expect(serverSrc).toContain('resolve(pluginRoot, "build", "cli.js")');
  });

  test("contains inline fallback with git clone when neither CLI file exists", () => {
    // The fallback must generate an inline script with git clone via execFileSync
    expect(serverSrc).toMatch(/git.*clone.*--depth.*1/);
    // The inline script is written to a temp .mjs file
    expect(serverSrc).toMatch(/\.ctx-upgrade-inline\.mjs/);
  });

  test("inline fallback copies package files to plugin root", () => {
    // The inline script must copy the published package payload back, including
    // newly added files such as the statusline bin directory.
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["server.bundle.mjs", "cli.bundle.mjs", "bin"]),
    );
    expect(serverSrc).toContain('readFileSync(join(T,"package.json"),"utf8")');
    expect(serverSrc).toContain("pkg.files");
    expect(serverSrc).toContain("Array.isArray(pkg.files)");
    expect(serverSrc).toContain("cpSync(from,to,{recursive:true,force:true})");
    expect(serverSrc).toMatch(/npm.*install/);
  });

  test("fallback only triggers when neither CLI file exists", () => {
    // There should be an else/fallback branch after checking both paths
    expect(serverSrc).toMatch(/existsSync\(fallbackPath\)/);
  });
});

// ─── ctx_purge is the ONLY reset mechanism ──────────────────────────────────

describe("ctx_purge is the sole reset/wipe mechanism", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );
  const routingBlockSrc = readFileSync(
    resolve(__dirname, "../../hooks/routing-block.mjs"),
    "utf-8",
  );

  // ── ctx_stats has NO reset capability ──
  test("ctx_stats does NOT accept a reset parameter", () => {
    // Extract only the ctx_stats tool registration
    const statsMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_stats"[\s\S]*?^\);/m,
    );
    expect(statsMatch).not.toBeNull();
    const statsBody = statsMatch![0];
    expect(statsBody).not.toContain("reset");
    expect(statsBody).not.toContain("resetSessionStats");
  });

  // ── No .clear-stats flag mechanism ──
  test("server has no checkClearStatsFlag mechanism", () => {
    expect(serverSrc).not.toContain("checkClearStatsFlag");
    expect(serverSrc).not.toContain(".clear-stats");
  });

  // ── Routing block: no reset instructions for /clear or /compact ──
  test("routing block does not instruct any reset after /clear or /compact", () => {
    expect(routingBlockSrc).not.toContain("reset: true");
    expect(routingBlockSrc).not.toContain("ctx_stats(reset");
  });

  test("routing block informs user about ctx_purge availability", () => {
    expect(routingBlockSrc).toMatch(/ctx.purge/i);
  });

  // ── ctx_purge is the complete wipe tool ──
  test("ctx_purge gates on confirm parameter", () => {
    expect(serverSrc).toContain("Purge cancelled");
    expect(serverSrc).toMatch(/if \(!confirm\)/);
  });

  test("ctx_purge wipes KB, session DB, events, and stats", () => {
    const purgeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    );
    expect(purgeMatch).not.toBeNull();
    const purgeBody = purgeMatch![0];
    // 1. Wipes FTS5 knowledge base
    expect(purgeBody).toContain("_store.cleanup()");
    expect(purgeBody).toContain("_store = null");
    // 2. Wipes session events DB
    expect(purgeBody).toContain("sessDbPath");
    expect(purgeBody).toContain("session events DB");
    // 3. Wipes session events markdown
    expect(purgeBody).toContain("eventsPath");
    expect(purgeBody).toContain("-events.md");
    // 4. Resets in-memory stats
    expect(purgeBody).toContain("sessionStats.calls = {}");
    expect(purgeBody).toContain("sessionStats.sessionStart = Date.now()");
    // Confirms with list of deleted items
    expect(purgeBody).toContain("Purged:");
  });
});

// ─── Platform-aware session DB paths ─────────────────────────────────────────

describe("Platform-aware session paths via adapter", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  // ── Adapter is stored at startup ──
  test("server stores detected adapter at startup", () => {
    expect(serverSrc).toContain("let _detectedAdapter");
    // main() must assign the adapter after detection
    expect(serverSrc).toMatch(/_detectedAdapter\s*=\s*await\s+getAdapter/);
  });

  // ── No hardcoded .claude in tool handlers ──
  test("ctx_purge has no hardcoded .claude path", () => {
    const purgeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    );
    expect(purgeMatch).not.toBeNull();
    expect(purgeMatch![0]).not.toMatch(/["']\.claude["']/);
  });

  test("ctx_stats has no hardcoded .claude path", () => {
    const statsMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_stats"[\s\S]*?^\);/m,
    );
    expect(statsMatch).not.toBeNull();
    expect(statsMatch![0]).not.toMatch(/["']\.claude["']/);
  });

  // ── Adapter methods used for session paths ──
  test("session paths derived from adapter.getSessionDir or getSessionDBPath", () => {
    // Either directly uses adapter methods or a helper that delegates to them
    expect(serverSrc).toMatch(/getSessionDir\(\)|getSessionDBPath\(/);
  });

  // ── Comprehensive projectDir detection ──
  test("getProjectDir checks verified platform env vars", () => {
    const fn = serverSrc.match(/function getProjectDir[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // Only env vars verified to be set by host IDEs before MCP server spawn
    expect(body).toContain("CLAUDE_PROJECT_DIR");
    expect(body).toContain("GEMINI_PROJECT_DIR");
    expect(body).toContain("VSCODE_CWD");
    expect(body).toContain("OPENCODE_PROJECT_DIR");
    expect(body).toContain("PI_PROJECT_DIR");
    // Universal fallback set by start.mjs for ALL platforms (Cursor, OpenClaw, etc.)
    expect(body).toContain("CONTEXT_MODE_PROJECT_DIR");
    expect(body).toContain("process.cwd()");
    // Must NOT contain semantically wrong env vars
    expect(body).not.toContain("OPENCLAW_HOME"); // install dir, not project dir
  });

  // ── Content DB is platform-isolated (not shared) ──
  test("getStorePath uses platform-specific dir, not shared ~/.context-mode/", () => {
    const fn = serverSrc.match(/function getStorePath[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // Must NOT use the shared platform-agnostic directory
    expect(body).not.toContain('".context-mode"');
    // Must derive content dir from adapter/session dir (platform-specific)
    expect(body).toContain("getSessionDir()");
  });
});

// ─── Hash consistency ────────────────────────────────────────────────────────

describe("Project dir hash consistency", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("shared hashProjectDir helper exists and normalizes backslashes", () => {
    const normalizeFn = serverSrc.match(/function normalizeProjectDirForHash[\s\S]*?^}/m);
    expect(normalizeFn).not.toBeNull();
    expect(normalizeFn![0]).toMatch(/replace\(.*\\\\.*\/.*\)/);

    const fn = serverSrc.match(/function hashProjectDir[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toContain("normalizeProjectDirForHash");
    expect(body).toContain("createHash");
  });

  test("getStorePath uses hashProjectDir, not inline hashing", () => {
    const fn = serverSrc.match(/function getStorePath[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("hashProjectDir");
    // Must NOT have its own inline createHash call
    expect(fn![0]).not.toContain("createHash");
  });

  test("ctx_stats uses hashProjectDir, not inline hashing", () => {
    const statsMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_stats"[\s\S]*?^\);/m,
    );
    expect(statsMatch).not.toBeNull();
    expect(statsMatch![0]).toContain("hashProjectDir");
    expect(statsMatch![0]).not.toContain("createHash");
  });

  test("ctx_purge uses hashProjectDir, not inline hashing", () => {
    const purgeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    );
    expect(purgeMatch).not.toBeNull();
    expect(purgeMatch![0]).toContain("hashProjectDir");
    expect(purgeMatch![0]).not.toContain("createHash");
  });
});

// ─── Purge deleted array honesty ─────────────────────────────────────────────

describe("ctx_purge deleted array is honest", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("every deleted.push in ctx_purge is guarded by a success check", () => {
    const purgeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    );
    expect(purgeMatch).not.toBeNull();
    const body = purgeMatch![0];

    // Find all deleted.push calls and check each one
    const pushes = [...body.matchAll(/deleted\.push\("([^"]+)"\)/g)];
    expect(pushes.length).toBeGreaterThanOrEqual(4);

    for (const push of pushes) {
      const label = push[1];
      if (label === "session stats") continue; // always truthful (in-memory)

      // Get the 120 chars before this push — must contain a conditional guard
      const idx = push.index!;
      const context = body.slice(Math.max(0, idx - 120), idx);
      const isGuarded = /if\s*\(\s*\w*[Ff]ound/.test(context)
        || /if\s*\(_store\)/.test(context);
      expect(isGuarded, `"${label}" push must be guarded by a found/success check`).toBe(true);
    }
  });
});

// ─── KB purge behavioral (ContentStore) ─────────────────────────────────────

describe("ContentStore purge behavior", () => {
  test("cleanup() deletes DB files (including WAL and SHM)", () => {
    const tmpPath = join(tmpdir(), `ctx-purge-test-${Date.now()}.db`);
    const store = new ContentStore(tmpPath);

    store.index({ content: "test content for purge verification", source: "purge-test" });
    expect(store.getStats().chunks).toBeGreaterThan(0);

    store.cleanup();

    // All DB files should be gone
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(tmpPath + "-wal")).toBe(false);
    expect(existsSync(tmpPath + "-shm")).toBe(false);
  });

  test("index survives when cleanup is NOT called (--continue scenario)", () => {
    const tmpPath = join(tmpdir(), `ctx-preserve-test-${Date.now()}.db`);
    const store = new ContentStore(tmpPath);

    store.index({ content: "preserved content across sessions", source: "preserve-test" });
    store.close();

    // Simulate --continue: reopen same DB
    const store2 = new ContentStore(tmpPath);
    const stats = store2.getStats();
    expect(stats.chunks).toBeGreaterThan(0);

    const results = store2.search("preserved content", 5);
    expect(results.length).toBeGreaterThan(0);

    store2.cleanup();
  });

  test("store recovers after purge — new index works", () => {
    const tmpPath = join(tmpdir(), `ctx-recovery-test-${Date.now()}.db`);

    // Phase 1: index and purge
    const store1 = new ContentStore(tmpPath);
    store1.index({ content: "old content to be purged", source: "old" });
    store1.cleanup();
    expect(existsSync(tmpPath)).toBe(false);

    // Phase 2: create fresh store at same path, index new content
    const store2 = new ContentStore(tmpPath);
    store2.index({ content: "fresh content after purge", source: "new" });

    const results = store2.search("fresh content", 5);
    expect(results.length).toBeGreaterThan(0);

    // Old content should NOT be found
    const oldResults = store2.search("old content to be purged", 5);
    expect(oldResults.length).toBe(0);

    store2.cleanup();
  });

  test("double cleanup does not crash", () => {
    const tmpPath = join(tmpdir(), `ctx-double-purge-${Date.now()}.db`);
    const store = new ContentStore(tmpPath);
    store.index({ content: "some content", source: "test" });

    // First cleanup
    store.cleanup();
    expect(existsSync(tmpPath)).toBe(false);

    // Second cleanup — DB already gone, should not throw
    expect(() => store.cleanup()).not.toThrow();
  });

  test("cleanup on never-indexed store does not crash", () => {
    const tmpPath = join(tmpdir(), `ctx-empty-purge-${Date.now()}.db`);
    const store = new ContentStore(tmpPath);

    // No indexing done — purge should still work
    expect(() => store.cleanup()).not.toThrow();
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("ctx_purge handler deletes DB file even when _store is null (--continue scenario)", () => {
    // This tests the server.ts logic: when _store is null, ctx_purge should
    // still delete the DB file on disk using getStorePath()
    const serverSrc = readFileSync(
      resolve(__dirname, "../../src/server.ts"),
      "utf-8",
    );
    const purgeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    );
    expect(purgeMatch).not.toBeNull();
    const purgeBody = purgeMatch![0];

    // Must have an else branch for when _store is null
    expect(purgeBody).toContain("} else {");
    expect(purgeBody).toContain("getStorePath()");
    expect(purgeBody).toContain("unlinkSync");
  });
});

// ─── Version outdated warning ────────────────────────────────────────────────

describe("Version outdated warning in trackResponse", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("fetchLatestVersion function exists and uses npm registry", () => {
    expect(serverSrc).toContain("function fetchLatestVersion");
    expect(serverSrc).toContain("registry.npmjs.org/context-mode");
  });

  test("version check fires in main() after server.connect", () => {
    const mainFn = serverSrc.slice(serverSrc.indexOf("async function main"));
    expect(mainFn).toContain("fetchLatestVersion");
  });

  test("trackResponse prepends warning when outdated", () => {
    const trackFn = serverSrc.slice(
      serverSrc.indexOf("function trackResponse"),
      serverSrc.indexOf("function trackIndexed"),
    );
    expect(trackFn).toContain("_latestVersion");
    expect(trackFn).toContain("outdated");
  });

  test("warning uses burst cadence (3 calls then silent)", () => {
    expect(serverSrc).toContain("VERSION_BURST_SIZE");
    expect(serverSrc).toContain("VERSION_SILENT_MS");
    expect(serverSrc).toContain("_warningBurstCount");
  });

  test("getUpgradeHint returns platform-specific command", () => {
    expect(serverSrc).toContain("function getUpgradeHint");
    // Claude Code gets slash command
    expect(serverSrc).toMatch(/claude.code.*ctx.upgrade|ctx.upgrade.*claude.code/i);
    // npm platforms get npm update
    expect(serverSrc).toContain("npm update -g context-mode");
    // OpenClaw gets its own command
    expect(serverSrc).toContain("npm run install:openclaw");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FS read instrumentation (mirrors network interceptor pattern)
// ═══════════════════════════════════════════════════════════════════════════

describe("FS read instrumentation", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("wrapper contains __CM_FS__ marker for stderr reporting", () => {
    expect(serverSrc).toContain("__CM_FS__:");
  });

  test("wrapper instruments readFileSync to count bytes", () => {
    expect(serverSrc).toContain("readFileSync");
    expect(serverSrc).toContain("__cm_fs+=");
  });

  test("wrapper instruments readFile (async) to count bytes", () => {
    expect(serverSrc).toMatch(/readFile/);
    expect(serverSrc).toContain("__cm_fs+=d.length");
  });

  test("parses __CM_FS__ from stderr and adds to bytesSandboxed", () => {
    expect(serverSrc).toContain("__CM_FS__:(\\d+)");
    expect(serverSrc).toContain("sessionStats.bytesSandboxed += parseInt(fsMatch[1])");
  });

  test("cleans __CM_FS__ marker from stderr output", () => {
    expect(serverSrc).toContain('result.stderr.replace(/\\n?__CM_FS__:\\d+\\n?/g, "")');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// batch_execute FS read tracking via NODE_OPTIONS preload
// ═══════════════════════════════════════════════════════════════════════════

describe("batch_execute FS read tracking", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("creates CM_FS_PRELOAD temp file with FS tracking script", () => {
    expect(serverSrc).toContain("CM_FS_PRELOAD");
    expect(serverSrc).toContain("cm-fs-preload-");
    // Preload script must write __CM_FS__ marker to stderr on exit
    expect(serverSrc).toMatch(/writeFileSync\(\s*CM_FS_PRELOAD/);
  });

  test("sets NODE_OPTIONS with --require for batch commands", () => {
    expect(serverSrc).toContain("buildBatchNodeOptionsPrefix");
    expect(serverSrc).toContain("nodeOptsPrefix");
  });

  test("parses __CM_FS__ from batch output and updates bytesSandboxed", () => {
    expect(serverSrc).toContain("/__CM_FS__:(\\d+)/g");
    // Handler wires the FS-bytes callback to sessionStats; the runner strips/parses.
    expect(serverSrc).toContain("sessionStats.bytesSandboxed += bytes");
    expect(serverSrc).toContain("onFsBytes?.(cmdFsBytes)");
  });

  test("strips __CM_FS__ markers from batch command output", () => {
    expect(serverSrc).toContain('output.replace(/__CM_FS__:\\d+\\n?/g, "")');
  });

  test("cleans up preload file on shutdown", () => {
    expect(serverSrc).toContain("unlinkSync(CM_FS_PRELOAD)");
  });

  test("handler accepts concurrency input field with min/max bounds", () => {
    expect(serverSrc).toContain("concurrency: z");
    expect(serverSrc).toMatch(/\.min\(1\)\s*\n?\s*\.max\(8\)/);
    expect(serverSrc).toContain(".default(1)");
  });

  test("tool description documents the concurrency field with positive guidance", () => {
    // Hardened guidance per PRD-concurrency-architectural.md Section 4
    expect(serverSrc).toContain("concurrency: 4-8");
    expect(serverSrc).toContain("3-5x");
    expect(serverSrc).toContain("✅");
    expect(serverSrc).toContain("❌");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runBatchCommands — concurrency, ordering, timeout semantics
// ═══════════════════════════════════════════════════════════════════════════

import {
  buildBatchNodeOptionsPrefix,
  runBatchCommands,
  type BatchCommand,
} from "../../src/server.js";

interface MockResult { stdout: string; timedOut?: boolean; }

function mkMockExecutor(
  handler: (code: string, timeout: number | undefined) => Promise<MockResult> | MockResult,
): { execute: (input: { language: "shell"; code: string; timeout: number | undefined }) => Promise<MockResult> } {
  return {
    execute: async ({ code, timeout }) => Promise.resolve(handler(code, timeout)),
  };
}

const NOOP_PREFIX = ""; // tests don't need NODE_OPTIONS prefix

describe("runBatchCommands serial path (concurrency=1)", () => {
  test("happy path: outputs in input order, no timeout cascade", async () => {
    const cmds: BatchCommand[] = [
      { label: "A", command: "echo a" },
      { label: "B", command: "echo b" },
      { label: "C", command: "echo c" },
    ];
    const exec = mkMockExecutor((code) => ({ stdout: code.includes("echo a") ? "a" : code.includes("echo b") ? "b" : "c" }));
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 5000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(timedOut).toBe(false);
    expect(outputs).toHaveLength(3);
    expect(outputs[0]).toContain("# A");
    expect(outputs[0]).toContain("a");
    expect(outputs[1]).toContain("# B");
    expect(outputs[2]).toContain("# C");
  });

  test("cascading skip: timeout in first cmd skips the rest", async () => {
    let callCount = 0;
    const exec = mkMockExecutor(() => {
      callCount++;
      return { stdout: "slow", timedOut: true };
    });
    const cmds: BatchCommand[] = [
      { label: "slow", command: "sleep 999" },
      { label: "next", command: "echo next" },
      { label: "after", command: "echo after" },
    ];
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 100, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(callCount).toBe(1); // only slow command executed
    expect(timedOut).toBe(true);
    expect(outputs[0]).toContain("# slow");
    expect(outputs[1]).toContain("(skipped — batch timeout exceeded)");
    expect(outputs[2]).toContain("(skipped — batch timeout exceeded)");
  });

  test("shared timeout budget: subsequent commands skip when budget exhausted", async () => {
    let callCount = 0;
    const exec = mkMockExecutor(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 60)); // each call burns 60ms
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "x" },
      { label: "B", command: "x" },
      { label: "C", command: "x" }, // by here, elapsed > 100ms
    ];
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 100, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(callCount).toBeLessThan(3);
    expect(timedOut).toBe(true);
    expect(outputs.some((o) => o.includes("(skipped — batch timeout exceeded)"))).toBe(true);
  });

  // Issue #406 — when timeout omitted, no shared budget, no skip cascade.
  test("no timeout: all commands run to completion, no skip", async () => {
    const exec = mkMockExecutor(async () => {
      // Each call burns 60ms. With timeout omitted, NONE should be skipped.
      await new Promise((r) => setTimeout(r, 60));
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "x" },
      { label: "B", command: "x" },
      { label: "C", command: "x" },
    ];
    const { outputs, timedOut } = await runBatchCommands(
      cmds,
      { timeout: undefined, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    expect(timedOut).toBe(false);
    expect(outputs).toHaveLength(3);
    expect(outputs.every((o) => !o.includes("skipped"))).toBe(true);
  });

  test("no timeout: per-command timeout passed to executor is undefined", async () => {
    const seenTimeouts: Array<number | undefined> = [];
    const exec = {
      execute: async (input: { language: "shell"; code: string; timeout: number | undefined }) => {
        seenTimeouts.push(input.timeout);
        return { stdout: "ok" } as MockResult;
      },
    };
    const cmds: BatchCommand[] = [
      { label: "A", command: "x" },
      { label: "B", command: "y" },
    ];
    await runBatchCommands(
      cmds,
      { timeout: undefined, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    expect(seenTimeouts).toEqual([undefined, undefined]);
  });
});

describe("runBatchCommands parallel path (concurrency>1)", () => {
  test("happy path: 3 cmds at concurrency=3 finish in parallel", async () => {
    const exec = mkMockExecutor(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "x" },
      { label: "B", command: "y" },
      { label: "C", command: "z" },
    ];
    const start = Date.now();
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 5000, concurrency: 3, nodeOptsPrefix: NOOP_PREFIX }, exec);
    const elapsed = Date.now() - start;
    expect(timedOut).toBe(false);
    expect(outputs).toHaveLength(3);
    expect(elapsed).toBeLessThan(250); // 3x parallel ~100ms, with overhead room
  });

  test("order preservation: outputs match input order, not completion order", async () => {
    const exec = mkMockExecutor(async (code) => {
      // Reverse-order delay: first cmd is slowest
      const delay = code.includes("first") ? 80 : code.includes("second") ? 40 : 10;
      await new Promise((r) => setTimeout(r, delay));
      return { stdout: code.replace("echo ", "") };
    });
    const cmds: BatchCommand[] = [
      { label: "FIRST", command: "echo first" },
      { label: "SECOND", command: "echo second" },
      { label: "THIRD", command: "echo third" },
    ];
    const { outputs } = await runBatchCommands(cmds, { timeout: 5000, concurrency: 3, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(outputs[0]).toContain("# FIRST");
    expect(outputs[1]).toContain("# SECOND");
    expect(outputs[2]).toContain("# THIRD");
  });

  test("concurrency cap: 6 cmds at concurrency=2 never exceed 2 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = mkMockExecutor(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = Array.from({ length: 6 }, (_, i) => ({ label: `C${i}`, command: "x" }));
    await runBatchCommands(cmds, { timeout: 5000, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  test("per-command timeout: one cmd times out, siblings continue", async () => {
    const exec = mkMockExecutor((code) => {
      if (code.includes("slow")) return { stdout: "", timedOut: true };
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "slow", command: "sleep slow" },
      { label: "fast", command: "echo fast" },
    ];
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 100, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(timedOut).toBe(true);
    expect(outputs[0]).toContain("(timed out after 100ms)");
    expect(outputs[1]).toContain("ok");
  });

  test("concurrency exceeds cmd count: caps at cmd count, no spurious workers", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = mkMockExecutor(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [{ label: "A", command: "x" }, { label: "B", command: "y" }];
    await runBatchCommands(cmds, { timeout: 5000, concurrency: 8, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  test("FS bytes callback fires per-command in parallel branch", async () => {
    const exec = mkMockExecutor((code) => ({
      stdout: code.includes("a") ? "out a\n__CM_FS__:100\n" : "out b\n__CM_FS__:200\n",
    }));
    const cmds: BatchCommand[] = [
      { label: "A", command: "echo a" },
      { label: "B", command: "echo b" },
    ];
    let totalBytes = 0;
    const { outputs } = await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX, onFsBytes: (b) => { totalBytes += b; } },
      exec,
    );
    expect(totalBytes).toBe(300);
    // markers stripped from output
    expect(outputs.join("")).not.toContain("__CM_FS__");
  });
});

describe("runBatchCommands edge cases", () => {
  test("empty commands array returns empty outputs", async () => {
    const exec = mkMockExecutor(() => ({ stdout: "" }));
    const { outputs, timedOut } = await runBatchCommands([], { timeout: 1000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(outputs).toHaveLength(0);
    expect(timedOut).toBe(false);
  });

  test("empty stdout becomes (no output) sentinel", async () => {
    const exec = mkMockExecutor(() => ({ stdout: "" }));
    const cmds: BatchCommand[] = [{ label: "A", command: "x" }];
    const { outputs } = await runBatchCommands(cmds, { timeout: 1000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(outputs[0]).toContain("(no output)");
  });

  test("nodeOptsPrefix is prepended to each command", async () => {
    const seen: string[] = [];
    const exec = mkMockExecutor((code) => {
      seen.push(code);
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [{ label: "A", command: "echo hi" }];
    await runBatchCommands(cmds, { timeout: 1000, concurrency: 1, nodeOptsPrefix: 'NODE_OPTIONS="--require /tmp/x" ' }, exec);
    expect(seen[0]).toBe('NODE_OPTIONS="--require /tmp/x" echo hi 2>&1');
  });

  test("buildBatchNodeOptionsPrefix formats POSIX shell assignment", () => {
    const prefix = buildBatchNodeOptionsPrefix("bash", "/tmp/cm fs'preload.js");
    expect(prefix).toBe("NODE_OPTIONS='--require /tmp/cm fs'\\''preload.js' ");
  });

  test("buildBatchNodeOptionsPrefix formats PowerShell assignment", () => {
    const prefix = buildBatchNodeOptionsPrefix(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Temp\\cm ' fs.js",
    );
    expect(prefix).toBe("$env:NODE_OPTIONS='--require C:\\Temp\\cm '' fs.js'; ");
  });

  test("buildBatchNodeOptionsPrefix formats cmd assignment", () => {
    const prefix = buildBatchNodeOptionsPrefix(
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Temp\\cm-fs-preload.js",
    );
    expect(prefix).toBe('set "NODE_OPTIONS=--require C:\\Temp\\cm-fs-preload.js" && ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runBatchCommands hardening — P0 fixes per PRD-concurrency-architectural §0
// ═══════════════════════════════════════════════════════════════════════════

describe("runBatchCommands P0 hardening", () => {
  test("finding A: executor throw is isolated, siblings complete", async () => {
    // One worker's executor.execute() throws (e.g. spawn EAGAIN under load).
    // Without try/catch, Promise.all would reject and strand sibling outputs
    // as `undefined`, surfacing as the literal "undefined" after .join("\n").
    const exec = mkMockExecutor((code) => {
      if (code.includes("boom")) throw new Error("spawn EAGAIN");
      return { stdout: code.includes("a") ? "alpha" : code.includes("b") ? "beta" : "gamma" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "echo a" },
      { label: "BOOM", command: "echo boom" },
      { label: "B", command: "echo b" },
      { label: "C", command: "echo c" },
    ];
    const { outputs } = await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 4, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    expect(outputs).toHaveLength(4);
    expect(outputs[0]).toContain("# A");
    expect(outputs[0]).toContain("alpha");
    expect(outputs[1]).toContain("# BOOM");
    expect(outputs[1]).toContain("(executor error: spawn EAGAIN)");
    expect(outputs[2]).toContain("beta");
    expect(outputs[3]).toContain("gamma");
    // Critically: no `undefined` slots
    expect(outputs.every((o) => typeof o === "string" && o.length > 0)).toBe(true);
  });

  test("finding B: timed-out parallel command still strips __CM_FS__ markers + counts bytes", async () => {
    // Real subprocess timeouts often return partial stdout *with* the marker.
    // Pre-fix the parallel branch wrote the (timed out) sentinel directly,
    // bypassing formatCommandOutput → markers leaked into context, bytes uncounted.
    const exec = mkMockExecutor(() => ({
      stdout: "partial line 1\n__CM_FS__:512\npartial line 2\n",
      timedOut: true,
    }));
    let totalBytes = 0;
    const { outputs, timedOut } = await runBatchCommands(
      [{ label: "SLOW", command: "x" }],
      { timeout: 100, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX, onFsBytes: (b) => { totalBytes += b; } },
      exec,
    );
    expect(timedOut).toBe(true);
    expect(totalBytes).toBe(512); // marker counted
    expect(outputs[0]).not.toContain("__CM_FS__"); // marker stripped
    expect(outputs[0]).toContain("partial line 1");
    expect(outputs[0]).toContain("partial line 2");
    expect(outputs[0]).toContain("(timed out after 100ms)"); // sentinel still appended
  });

  test("finding D: timing-regression — 5 cmds × 100ms at concurrency=5 finishes in <200ms", async () => {
    // Replaces the deleted bench (CONTRIBUTING.md L275 forbids new test files).
    // Asserts ≥3× speedup over serial. CI-checked.
    const exec = mkMockExecutor(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = Array.from({ length: 5 }, (_, i) => ({
      label: `C${i}`,
      command: "x",
    }));
    const start = Date.now();
    const { outputs, timedOut } = await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 5, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    const elapsed = Date.now() - start;
    expect(timedOut).toBe(false);
    expect(outputs).toHaveLength(5);
    // Serial would be ~500ms (5×100). Parallel should be ~100ms + overhead.
    // Threshold 200ms gives generous CI room while still catching a regression to serial.
    expect(elapsed).toBeLessThan(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runPool — shared concurrency primitive (PRD finding G)
// ═══════════════════════════════════════════════════════════════════════════

import { runPool, type PoolJob } from "../../src/runPool.js";

describe("runPool primitive", () => {
  test("empty jobs returns empty settled array", async () => {
    const { settled, effectiveConcurrency, capped } = await runPool([], { concurrency: 4 });
    expect(settled).toHaveLength(0);
    expect(effectiveConcurrency).toBe(0);
    expect(capped).toBe(false);
  });

  test("happy path: order preserved, all fulfilled", async () => {
    const jobs: PoolJob<number>[] = [10, 20, 30, 40].map((v, i) => ({
      run: async () => {
        await new Promise((r) => setTimeout(r, (4 - i) * 10)); // reverse-order delay
        return v;
      },
    }));
    const { settled, effectiveConcurrency } = await runPool(jobs, { concurrency: 4 });
    expect(effectiveConcurrency).toBe(4);
    expect(settled.map((s) => s.status === "fulfilled" ? s.value : null)).toEqual([10, 20, 30, 40]);
  });

  test("throw isolation: one job rejects, siblings still fulfill", async () => {
    const jobs: PoolJob<string>[] = [
      { run: async () => "a" },
      { run: async () => { throw new Error("boom"); } },
      { run: async () => "c" },
    ];
    const { settled } = await runPool(jobs, { concurrency: 3 });
    expect(settled[0]).toEqual({ status: "fulfilled", value: "a" });
    expect(settled[1].status).toBe("rejected");
    expect((settled[1] as { reason: Error }).reason.message).toBe("boom");
    expect(settled[2]).toEqual({ status: "fulfilled", value: "c" });
  });

  test("in-flight cap: never exceeds concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const jobs: PoolJob<void>[] = Array.from({ length: 10 }, () => ({
      run: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      },
    }));
    const { effectiveConcurrency, capped } = await runPool(jobs, { concurrency: 3 });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // proves at least some parallelism
    expect(effectiveConcurrency).toBe(3);
    expect(capped).toBe(false);
  });

  test("auto-clamp to job count when concurrency > jobs.length", async () => {
    const jobs: PoolJob<number>[] = [{ run: async () => 1 }, { run: async () => 2 }];
    const { effectiveConcurrency, capped } = await runPool(jobs, { concurrency: 8 });
    expect(effectiveConcurrency).toBe(2);
    expect(capped).toBe(true);
  });

  test("capByCpuCount caps by os.cpus().length", async () => {
    // We can't predict the test runner's cpu count, so just assert the bounds.
    const jobs: PoolJob<number>[] = Array.from({ length: 32 }, (_, i) => ({ run: async () => i }));
    const { effectiveConcurrency, capped } = await runPool(jobs, { concurrency: 32, capByCpuCount: true });
    const cores = require("node:os").cpus().length;
    expect(effectiveConcurrency).toBeLessThanOrEqual(cores);
    expect(effectiveConcurrency).toBeLessThanOrEqual(32);
    expect(capped).toBe(effectiveConcurrency < 32);
  });

  test("onSettled callback fires per job in completion order", async () => {
    const events: number[] = [];
    const jobs: PoolJob<number>[] = [
      { run: async () => { await new Promise((r) => setTimeout(r, 30)); return 0; } },
      { run: async () => { await new Promise((r) => setTimeout(r, 10)); return 1; } },
      { run: async () => { await new Promise((r) => setTimeout(r, 20)); return 2; } },
    ];
    await runPool(jobs, { concurrency: 3, onSettled: (idx) => { events.push(idx); } });
    // Job 1 (10ms) completes first, then 2 (20ms), then 0 (30ms)
    expect(events).toEqual([1, 2, 0]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_fetch_and_index batch path — schema + handler-level checks
// (Full subprocess fetch tested in tests/mcp-integration.ts;
//  these tests verify schema acceptance + serial-index contract via source-level read.)
// ═══════════════════════════════════════════════════════════════════════════

describe("ctx_fetch_and_index batch refactor", () => {
  const fetchHandlerSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("schema accepts both legacy {url} and batch {requests}", () => {
    expect(fetchHandlerSrc).toContain('url: z.string().optional()');
    expect(fetchHandlerSrc).toContain('requests: z');
    // Zod array of {url, source?}
    expect(fetchHandlerSrc).toContain("z.object({\n            url: z.string()");
    expect(fetchHandlerSrc).toContain('source: z.string().optional()');
  });

  test("handler exposes concurrency 1-8 with default 1", () => {
    // Find the fetch_and_index registerTool block, then assert concurrency schema near it.
    // Stop anchor: the next registerTool call (ctx_batch_execute).
    const fetchBlockMatch = fetchHandlerSrc.match(/registerTool\(\s*"ctx_fetch_and_index"[\s\S]+?registerTool\(\s*"ctx_batch_execute"/);
    expect(fetchBlockMatch).not.toBeNull();
    const block = fetchBlockMatch![0];
    expect(block).toContain("concurrency: z");
    expect(block).toMatch(/\.min\(1\)\s*\n?\s*\.max\(8\)/);
    expect(block).toContain(".default(1)");
  });

  test("PARALLELIZE I/O guidance + locked requests:[] schema in description", () => {
    expect(fetchHandlerSrc).toContain("PARALLELIZE I/O");
    expect(fetchHandlerSrc).toContain("requests: [{url, source}");
    expect(fetchHandlerSrc).toContain("3-5x");
    expect(fetchHandlerSrc).toContain("✅");
    expect(fetchHandlerSrc).toContain("❌");
  });

  test("serial-write contract: index drain is a for-loop calling indexFetched serially", () => {
    // The handler must NOT spawn parallel store.index calls. The drain is a
    // for-loop over `settled` calling indexFetched serially. Anti-pattern check.
    expect(fetchHandlerSrc).toContain("Serial index drain");
    expect(fetchHandlerSrc).toContain("indexFetched(v)");
    // No `await Promise.all(... indexFetched ...)` pattern anywhere
    expect(fetchHandlerSrc).not.toMatch(/Promise\.all\([^)]*indexFetched/);
  });

  test("backward compat: legacy single-URL response wording preserved", () => {
    // Original handler returned "Cached: **${label}**" / "Fetched and indexed **N sections**"
    // The refactor must keep these EXACT strings for the legacy path so
    // tests/mcp-integration.ts and any user-side scripts grepping the response don't break.
    expect(fetchHandlerSrc).toContain("Cached: **${r.label}**");
    expect(fetchHandlerSrc).toContain("Fetched and indexed **${r.indexed.totalChunks} sections**");
    // The source escapes backticks inside a template literal — match the escaped form.
    expect(fetchHandlerSrc).toContain("To refresh: call ctx_fetch_and_index again with");
    expect(fetchHandlerSrc).toContain("force: true");
  });

  test("isLegacySingle gate prevents batch response wrapping for single-URL calls", () => {
    expect(fetchHandlerSrc).toContain("const isLegacySingle = !requests && batch.length === 1");
    expect(fetchHandlerSrc).toContain("if (isLegacySingle)");
  });

  test("capped-concurrency note appears only when capped", () => {
    expect(fetchHandlerSrc).toMatch(/cappedNote\s*=\s*capped\s*\?/);
    // Caveman style — `cap=N/Mcpu` instead of "capped from N to M; M cores available".
    expect(fetchHandlerSrc).toContain("cap=${effectiveConcurrency}/${cpus().length}cpu");
  });

  test("batch isError only when ALL URLs fail (errorCount === batch.length)", () => {
    expect(fetchHandlerSrc).toContain("isError: errorCount === batch.length");
  });

  test("batch preview is capped to prevent context flooding (review F2)", () => {
    // Per-URL preview in batch mode capped tightly so an 8-URL batch doesn't
    // dump ~24KB of context (8 × 3072 char single-URL preview cap).
    expect(fetchHandlerSrc).toContain("FETCH_BATCH_PREVIEW_LIMIT");
    // Cap value must be ≤500 chars (8 URLs × 500 = ~4KB max snippets total)
    const limitMatch = fetchHandlerSrc.match(/FETCH_BATCH_PREVIEW_LIMIT\s*=\s*(\d+)/);
    expect(limitMatch).not.toBeNull();
    expect(parseInt(limitMatch![1])).toBeLessThanOrEqual(500);
    // Must actually be applied to per-URL previews in the batch loop
    expect(fetchHandlerSrc).toMatch(/preview\.length\s*>\s*FETCH_BATCH_PREVIEW_LIMIT/);
  });

  test("batch header uses singular form for count=1 (review F5 plural fix)", () => {
    // Per CLAUDE.md "Terse like caveman" + grammar correctness:
    // "1 errors" → "1 error" via the fmt() helper.
    expect(fetchHandlerSrc).toContain('const fmt = (n: number, sing: string, plur: string)');
    expect(fetchHandlerSrc).toContain('n === 1 ? sing : plur');
  });

  test("batch header uses caveman style (review F5 terse format)", () => {
    // Old: "Batch fetched N URLs at concurrency=X (capped from Y to X; Z cores available): a fetched, b cached, c errors. d new sections (eKB total)."
    // New: "fetched N c=X cap=X/Zcpu. ok=a cache=b err=c. d sections eKB."
    expect(fetchHandlerSrc).toContain("`fetched ${batch.length} c=${effectiveConcurrency}");
    expect(fetchHandlerSrc).toContain("ok=${fetchedCount} cache=${cachedCount} err=${errorCount}");
    expect(fetchHandlerSrc).not.toContain("Batch fetched"); // old verbose wording gone
  });

  test("fetchOneUrl is parallel-safe (no SQLite writes)", () => {
    // Verify by inspecting the helper source: it calls store.getSourceMeta (read)
    // but never store.index/indexJSON/indexPlainText (writes).
    const fetchOneSrc = fetchHandlerSrc.match(/async function fetchOneUrl\([\s\S]+?^}/m);
    expect(fetchOneSrc).not.toBeNull();
    const block = fetchOneSrc![0];
    expect(block).toContain("store.getSourceMeta"); // read OK
    expect(block).not.toContain("store.index"); // no writes
    expect(block).not.toContain("store.indexJSON");
    expect(block).not.toContain("store.indexPlainText");
  });

  test("indexFetched is serial-only (single FTS5 write per call)", () => {
    const indexFetchedSrc = fetchHandlerSrc.match(/function indexFetched\([\s\S]+?^}/m);
    expect(indexFetchedSrc).not.toBeNull();
    const block = indexFetchedSrc![0];
    // Has exactly one of: store.index / store.indexJSON / store.indexPlainText per branch
    expect(block).toContain("store.indexJSON");
    expect(block).toContain("store.indexPlainText");
    expect(block).toContain("store.index");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SSRF guard — ctx_fetch_and_index URL/IP allowlist (PR #401 ops review)
// ═══════════════════════════════════════════════════════════════════════════

import { classifyIp } from "../../src/server.js";

describe("classifyIp — SSRF guard IP classifier", () => {
  test("hard-blocks IMDS / link-local IPv4 (169.254.0.0/16)", () => {
    // 169.254.169.254 = AWS/GCP/Azure cloud metadata endpoint — never legitimate
    expect(classifyIp("169.254.169.254")).toBe("block");
    expect(classifyIp("169.254.0.1")).toBe("block");
    expect(classifyIp("169.254.255.254")).toBe("block");
  });

  test("hard-blocks multicast / reserved IPv4 (224+ and 0.0.0.0/8)", () => {
    expect(classifyIp("224.0.0.1")).toBe("block");
    expect(classifyIp("239.255.255.255")).toBe("block");
    expect(classifyIp("255.255.255.255")).toBe("block");
    expect(classifyIp("0.0.0.0")).toBe("block");
    expect(classifyIp("0.1.2.3")).toBe("block");
  });

  test("hard-blocks malformed IPv4", () => {
    expect(classifyIp("999.999.999.999")).toBe("block");
    expect(classifyIp("not-an-ip")).toBe("block");
    expect(classifyIp("1.2.3")).toBe("block");
  });

  test("hard-blocks IPv6 link-local + multicast + unspecified", () => {
    expect(classifyIp("fe80::1")).toBe("block"); // link-local
    expect(classifyIp("ff00::1")).toBe("block"); // multicast
    expect(classifyIp("::")).toBe("block");      // unspecified
  });

  test("private (allow by default, block under strict mode): RFC1918 + loopback IPv4", () => {
    // Allowed by default — developer's local dev server / internal network
    expect(classifyIp("127.0.0.1")).toBe("private");
    expect(classifyIp("127.255.255.255")).toBe("private");
    expect(classifyIp("10.0.0.5")).toBe("private");
    expect(classifyIp("10.255.255.255")).toBe("private");
    expect(classifyIp("172.16.0.1")).toBe("private");
    expect(classifyIp("172.31.255.255")).toBe("private");
    expect(classifyIp("172.15.0.1")).toBe("public");  // outside RFC1918
    expect(classifyIp("172.32.0.1")).toBe("public");  // outside RFC1918
    expect(classifyIp("192.168.1.1")).toBe("private");
    expect(classifyIp("192.168.255.255")).toBe("private");
  });

  test("private: IPv6 loopback + ULA (fc00::/7)", () => {
    expect(classifyIp("::1")).toBe("private");
    expect(classifyIp("fc00::1")).toBe("private");
    expect(classifyIp("fd12:3456:789a::1")).toBe("private");
  });

  test("public: real internet IPs", () => {
    expect(classifyIp("8.8.8.8")).toBe("public");           // Google DNS
    expect(classifyIp("1.1.1.1")).toBe("public");           // Cloudflare DNS
    expect(classifyIp("140.82.121.4")).toBe("public");      // github.com
    expect(classifyIp("2001:4860:4860::8888")).toBe("public"); // Google DNS IPv6
  });

  test("IPv4-mapped IPv6 recurses through IPv4 classifier", () => {
    // ::ffff:127.0.0.1 is just 127.0.0.1 wrapped in IPv6 mapping
    expect(classifyIp("::ffff:127.0.0.1")).toBe("private");
    expect(classifyIp("::ffff:169.254.169.254")).toBe("block"); // IMDS via IPv4-mapped
    expect(classifyIp("::ffff:8.8.8.8")).toBe("public");
  });
});

describe("SSRF guard — ssrfGuard policy in src/server.ts", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("allowlists only http: and https: schemes", () => {
    expect(serverSrc).toContain('parsed.protocol !== "http:"');
    expect(serverSrc).toContain('parsed.protocol !== "https:"');
    // file:// / gopher:// / javascript: implicitly rejected
  });

  test("blocks IPs classified as block (link-local/IMDS/multicast)", () => {
    expect(serverSrc).toContain('verdict === "block"');
    expect(serverSrc).toContain("link-local / IMDS / multicast / reserved");
  });

  test("strict mode opt-in via CTX_FETCH_STRICT=1", () => {
    expect(serverSrc).toContain('process.env.CTX_FETCH_STRICT === "1"');
    expect(serverSrc).toContain('verdict === "private" && strict');
  });

  test("ssrfGuard runs BEFORE cache lookup (poisoned cache defense)", () => {
    // fetchOneUrl must call ssrfGuard before getSourceMeta — otherwise a
    // previously-poisoned source label could serve attacker content from cache.
    const fetchOneSrc = serverSrc.match(/async function fetchOneUrl\([\s\S]+?^}/m);
    expect(fetchOneSrc).not.toBeNull();
    const block = fetchOneSrc![0];
    const guardIdx = block.indexOf("ssrfGuard");
    const cacheIdx = block.indexOf("getSourceMeta");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(cacheIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_doctor resource cleanup regression (#247)
// ═══════════════════════════════════════════════════════════════════════════

const mcpEntry = resolve(__dirname, "..", "..", "start.mjs");

interface DoctorJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    serverInfo?: { name: string; version: string };
  };
  error?: { code: number; message: string };
}

function startMcpServer(): ChildProcess {
  return spawn("node", [mcpEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CONTEXT_MODE_DISABLE_VERSION_CHECK: "1" },
  });
}

function sendRpc(proc: ChildProcess, msg: Record<string, unknown>): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

/**
 * Read RPC responses from the server stdout until all `expectedIds` have
 * arrived or `timeoutMs` elapses, whichever comes first. Early-exit keeps
 * the happy path at <1s and gives Windows CI its full timeout budget when
 * process spawn + native-module load runs slow.
 */
function collectRpcResponses(
  proc: ChildProcess,
  timeoutMs: number,
  expectedIds: number[],
): Promise<DoctorJsonRpcResponse[]> {
  return new Promise((res) => {
    const expected = new Set(expectedIds);
    const seen = new Map<number, DoctorJsonRpcResponse>();
    let buffer = "";
    let timer: ReturnType<typeof setTimeout>;

    const finish = () => {
      clearTimeout(timer);
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      res(Array.from(seen.values()));
    };

    proc.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString();
      // Drain whole lines from the buffer. Stdout is newline-delimited JSON-RPC.
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as DoctorJsonRpcResponse;
          if (typeof parsed.id === "number" && expected.has(parsed.id)) {
            seen.set(parsed.id, parsed);
            if (seen.size === expected.size) {
              finish();
              return;
            }
          }
        } catch { /* ignore malformed / partial lines */ }
      }
    });

    timer = setTimeout(finish, timeoutMs);
  });
}

async function initAndCallDoctor(
  proc: ChildProcess,
  invocations: number,
  windowMs = 15_000,
): Promise<DoctorJsonRpcResponse[]> {
  sendRpc(proc, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-doctor-regression", version: "1.0" } },
  });
  sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
  const ids: number[] = [];
  for (let i = 0; i < invocations; i++) {
    const id = 100 + i;
    ids.push(id);
    sendRpc(proc, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ctx_doctor", arguments: {} } });
  }
  return collectRpcResponses(proc, windowMs, ids);
}

describe("ctx_doctor — resource cleanup regression (#247)", () => {
  test("single ctx_doctor call returns a status report", async () => {
    const proc = startMcpServer();
    const responses = await initAndCallDoctor(proc, 1);
    const call = responses.find((r) => r.id === 100);
    expect(call).toBeDefined();
    expect(call!.error).toBeUndefined();
    const text = call!.result?.content?.[0]?.text ?? "";
    expect(text).toContain("context-mode doctor");
    expect(text).toMatch(/Server test:/);
    expect(text).toMatch(/FTS5 \/ SQLite:/);
  }, 30_000);

  test("three concurrent ctx_doctor calls all succeed without crashing the server", async () => {
    const proc = startMcpServer();
    const responses = await initAndCallDoctor(proc, 3, 20_000);
    const calls = [100, 101, 102].map((id) => responses.find((r) => r.id === id));
    for (const c of calls) {
      expect(c, "missing ctx_doctor response — server likely crashed").toBeDefined();
      expect(c!.error).toBeUndefined();
      expect(c!.result?.content?.[0]?.text).toContain("context-mode doctor");
    }
  }, 35_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_doctor renderer-safe output (Mickey #3 — Z.ai GLM compatibility)
// ═══════════════════════════════════════════════════════════════════════════
//
// Z.ai's MCP renderer crashes with `ReferenceError: client is not defined`
// when it parses GitHub-flavored markdown task-list syntax (`- [x]`, `- [ ]`,
// `- [-]`). To stay safe across all MCP clients (including renderers that mount
// custom React components for task lists or h2 headers), ctx_doctor MUST emit
// plain-text status prefixes (`[OK]`, `[FAIL]`, `[WARN]`) and avoid `##`
// headings.
describe("ctx_doctor — renderer-safe output (Z.ai compat)", () => {
  test("output uses [OK]/[FAIL]/[WARN] prefixes and no markdown task-list syntax", async () => {
    const proc = startMcpServer();
    const responses = await initAndCallDoctor(proc, 1);
    const call = responses.find((r) => r.id === 100);
    expect(call).toBeDefined();
    expect(call!.error).toBeUndefined();
    const text: string = call!.result?.content?.[0]?.text ?? "";

    // Must NOT contain GFM task-list syntax (triggers Z.ai's broken renderer)
    expect(text).not.toMatch(/-\s+\[x\]/);
    expect(text).not.toMatch(/-\s+\[ \]/);
    expect(text).not.toMatch(/-\s+\[-\]/);

    // Must NOT contain `## ` h2 (some renderers mount custom h2 components)
    expect(text).not.toMatch(/^##\s/m);

    // Must use plain-text status prefixes
    expect(text).toMatch(/\[OK\]/);
    // Header is plain text, no markdown
    expect(text).toMatch(/^context-mode doctor/m);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Pre-detection session dir (race-condition fix)
// ═══════════════════════════════════════════════════════════════════════════
//
// Before the MCP `initialize` handshake completes, `_detectedAdapter` is null.
// Tools called in that window must still resolve a platform-correct sessions
// dir instead of falling back to hardcoded `~/.claude/context-mode/sessions/`.
//
// `getSessionDirSegments` is a sync, env-free map from PlatformId → segments
// (no adapter instantiation). `getSessionDir` calls `detectPlatform()` (sync,
// env-var-based) and feeds the result into the map. Falls back to `.claude`
// only if the map returns null (defensive — covers "unknown" PlatformId).

describe("ctx_doctor hook script checks", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("resolves relative hook script paths against pluginRoot", () => {
    const doctorSection = serverSrc.slice(serverSrc.indexOf("ctx_doctor"), serverSrc.indexOf("ctx_upgrade"));
    expect(doctorSection).toContain("for (const scriptPath of hookScriptPaths)");
    expect(doctorSection).toContain("const hookPath = resolve(pluginRoot, scriptPath)");
    expect(doctorSection).not.toContain("for (const hookPath of hookScriptPaths)");
  });
});

describe("getSessionDirSegments — sync platform → segments map", () => {
  test("returns correct segments for every supported platform", async () => {
    const { getSessionDirSegments } = await import("../../src/adapters/detect.js");
    expect(getSessionDirSegments("claude-code")).toEqual([".claude"]);
    expect(getSessionDirSegments("codex")).toEqual([".codex"]);
    expect(getSessionDirSegments("qwen-code")).toEqual([".qwen"]);
    expect(getSessionDirSegments("gemini-cli")).toEqual([".gemini"]);
    expect(getSessionDirSegments("kiro")).toEqual([".kiro"]);
    expect(getSessionDirSegments("cursor")).toEqual([".cursor"]);
    expect(getSessionDirSegments("openclaw")).toEqual([".openclaw"]);
    expect(getSessionDirSegments("vscode-copilot")).toEqual([".vscode"]);
    expect(getSessionDirSegments("antigravity")).toEqual([".gemini"]);
    expect(getSessionDirSegments("pi")).toEqual([".pi"]);
    expect(getSessionDirSegments("kilo")).toEqual([".config", "kilo"]);
    expect(getSessionDirSegments("opencode")).toEqual([".config", "opencode"]);
    expect(getSessionDirSegments("zed")).toEqual([".config", "zed"]);
    expect(getSessionDirSegments("jetbrains-copilot")).toEqual([".config", "JetBrains"]);
  });

  test("returns null for unknown platform", async () => {
    const { getSessionDirSegments } = await import("../../src/adapters/detect.js");
    expect(getSessionDirSegments("unknown")).toBeNull();
    expect(getSessionDirSegments("not-a-platform")).toBeNull();
  });
});

describe("getSessionDir uses pre-detection when adapter not yet detected", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("getSessionDir invokes detectPlatform + getSessionDirSegments before fallback", () => {
    const fn = serverSrc.match(/function getSessionDir\(\)[\s\S]*?^}/m);
    expect(fn, "getSessionDir not found in server.ts").not.toBeNull();
    const body = fn![0];
    // Pre-detection path must consult detectPlatform() and the sync segments map
    expect(body).toContain("detectPlatform");
    expect(body).toContain("getSessionDirSegments");
  });

  test("getSessionDir falls back to .claude only as last resort", () => {
    const fn = serverSrc.match(/function getSessionDir\(\)[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // The .claude literal must still appear (last-resort fallback) but only
    // after both pre-detection branches. Verify the ordering: detectPlatform
    // call comes before the literal.
    const detectIdx = body.indexOf("detectPlatform");
    const claudeIdx = body.indexOf('".claude"');
    expect(detectIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(detectIdx).toBeLessThan(claudeIdx);
  });

  test("getSessionDir honors CODEX_HOME in the Codex pre-detection branch", () => {
    const fn = serverSrc.match(/function getSessionDir\(\)[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(serverSrc).toContain('import { resolveCodexConfigDir } from "./adapters/codex/paths.js";');
    expect(body).toContain('segments[0] === ".codex"');
    expect(body).toContain("resolveCodexConfigDir()");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_fetch_and_index cache-key collision (Fix 6/10)
// ═══════════════════════════════════════════════════════════════════════════
//
// Bug: cache key was `source ?? url`, so two distinct URLs sharing a `source`
// label silently returned the cached first response instead of fetching the
// second. Fix composes the cache key from label+url for cache lookup.

describe("ctx_fetch_and_index cache key includes URL (Fix 6/10)", () => {
  test("composeFetchCacheKey: same label + different URLs produce different keys", async () => {
    const { composeFetchCacheKey } = await import("../../src/fetch-cache.js");
    const k1 = composeFetchCacheKey("Docs", "https://x.com/a");
    const k2 = composeFetchCacheKey("Docs", "https://y.com/b");
    expect(k1).not.toBe(k2);
  });

  test("composeFetchCacheKey: same label + same URL → same key (legitimate cache hit)", async () => {
    const { composeFetchCacheKey } = await import("../../src/fetch-cache.js");
    const k1 = composeFetchCacheKey("Docs", "https://x.com/a");
    const k2 = composeFetchCacheKey("Docs", "https://x.com/a");
    expect(k1).toBe(k2);
  });

  test("server.ts uses composeFetchCacheKey for cache lookup (no bare-label collision)", () => {
    const serverSrc = readFileSync(
      resolve(__dirname, "../../src/server.ts"),
      "utf-8",
    );
    // The cache lookup may live in the handler block OR in an extracted helper
    // (post-refactor: `fetchOneUrl` is the parallel-safe fetcher invoked by both
    // single-URL and batch paths). Either location must use composeFetchCacheKey,
    // not the bare label/url variable.

    // composeFetchCacheKey must be imported and referenced
    expect(serverSrc).toContain('from "./fetch-cache.js"');
    expect(serverSrc).toContain("composeFetchCacheKey");

    // Find ANY getSourceMeta call across the file
    const lookupCall = serverSrc.match(/getSourceMeta\(\s*([^)]+)\s*\)/);
    expect(lookupCall, "getSourceMeta call missing").not.toBeNull();
    const arg = lookupCall![1].trim();
    // Must NOT be the bare `label` variable (that was the bug).
    expect(arg).not.toBe("label");
    // Argument must be a key derived from composition (`cacheKey`, `storageLabel`,
    // or a direct `composeFetchCacheKey(...)` call). Reject any single-token
    // identifier that doesn't carry the composition contract.
    expect(arg).toMatch(/cacheKey|storageLabel|composeFetchCacheKey/);
  });

  test("ContentStore: per-(label,url) keys do not collide on getSourceMeta", () => {
    const store = new ContentStore(":memory:");
    // Simulate two distinct URLs sharing a user-supplied "source" label,
    // but stored under composed keys per the fix.
    const URL_A = "https://example.com/a";
    const URL_B = "https://example.com/b";
    const labelA = `Docs::${URL_A}`;
    const labelB = `Docs::${URL_B}`;

    store.index({ content: "# A\nContent A unique alpha", source: labelA });
    // Before fix: a second cache lookup with the bare "Docs" label would
    // hit A's meta and short-circuit. After fix: lookup uses labelB → miss.
    expect(store.getSourceMeta(labelB)).toBeNull();
    // Cache hit for the same (label,url) still works.
    expect(store.getSourceMeta(labelA)).not.toBeNull();

    // Now index B and verify both remain searchable independently.
    store.index({ content: "# B\nContent B unique bravo", source: labelB });
    const aResults = store.search("alpha", 5, labelA);
    const bResults = store.search("bravo", 5, labelB);
    expect(aResults.length).toBeGreaterThan(0);
    expect(bResults.length).toBeGreaterThan(0);
    store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ctx_insight process helpers (formerly tests/core/process-utils.test.ts)
//
// Behavioral tests for browserOpenArgv / openBrowserSync / killProcessOnPort
// (canonical home: src/server.ts). PR #452 review flagged that source-grep
// tests pin implementation strings, not the actual security property. These
// tests mock spawnSync directly and assert:
//
//   - argv arrays only — never `shell: true`
//   - per-platform fallback semantics (xdg-open → sensible-browser)
//   - Windows netstat parser anchors on LISTENING + local-address column
//   - per-pid kill failures do not abort the remaining loop
//   - structured results surface failure to callers
// ═══════════════════════════════════════════════════════════════════════════

import { vi } from "vitest";
import {
  browserOpenArgv,
  openBrowserSync,
  killProcessOnPort,
  type SpawnSyncFn,
} from "../../src/server.js";

type Captured = { cmd: string; args: readonly string[]; opts: unknown };
type FakeReturn = { status: number | null; stdout?: string; error?: Error };

function makeRunner(
  responses: Array<FakeReturn | ((cmd: string, args: readonly string[]) => FakeReturn)>,
): { runner: SpawnSyncFn; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const runner: SpawnSyncFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const next = responses[i++];
    const r = typeof next === "function" ? next(cmd, args) : next;
    return {
      pid: 0,
      output: [],
      stdout: r?.stdout ?? "",
      stderr: "",
      status: r?.status ?? 0,
      signal: null,
      error: r?.error,
    } as ReturnType<SpawnSyncFn>;
  };
  return { runner, calls };
}

describe("browserOpenArgv", () => {
  test("darwin → open url", () => {
    expect(browserOpenArgv("http://x", "darwin")).toEqual([
      { cmd: "open", args: ["http://x"] },
    ]);
  });

  test("win32 → cmd /c start with empty title", () => {
    // The empty-string title arg is the security-relevant detail: if it were
    // dropped, `start "http://attacker?evil=1"` would be parsed as a window
    // title rather than a URL.
    expect(browserOpenArgv("http://x", "win32")).toEqual([
      { cmd: "cmd", args: ["/c", "start", "", "http://x"] },
    ]);
  });

  test("linux → xdg-open then sensible-browser fallback", () => {
    expect(browserOpenArgv("http://x", "linux")).toEqual([
      { cmd: "xdg-open", args: ["http://x"] },
      { cmd: "sensible-browser", args: ["http://x"] },
    ]);
  });

  test("argv contains url as a single argument — no shell metachar expansion", () => {
    // A URL with shell metachars must appear verbatim as one argv entry on
    // every platform. If it were ever interpolated into a shell string, the
    // `; rm -rf /` would split into a separate command.
    const evil = "http://x; rm -rf /; #";
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const attempts = browserOpenArgv(evil, platform);
      for (const { args } of attempts) {
        expect(args).toContain(evil);
      }
    }
  });
});

describe("openBrowserSync", () => {
  test("darwin: spawnSync('open', [url]) with no shell:true", () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    const r = openBrowserSync("http://x", "darwin", runner);

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("open");
    expect(calls[0].args).toEqual(["http://x"]);
    expect(calls[0].opts).not.toHaveProperty("shell", true);
  });

  test("win32: cmd /c start '' url, no shell:true", () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    openBrowserSync("http://x", "win32", runner);

    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args).toEqual(["/c", "start", "", "http://x"]);
    expect(calls[0].opts).not.toHaveProperty("shell", true);
  });

  test("linux: xdg-open status=0 → sensible-browser is NOT called", () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    const r = openBrowserSync("http://x", "linux", runner);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe("xdg-open");
    expect(calls.map(c => c.cmd)).toEqual(["xdg-open"]);
  });

  test("linux: xdg-open status!=0 → sensible-browser fallback fires", () => {
    const { runner, calls } = makeRunner([
      { status: 3 },
      { status: 0 },
    ]);
    const r = openBrowserSync("http://x", "linux", runner);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe("sensible-browser");
    expect(calls.map(c => c.cmd)).toEqual(["xdg-open", "sensible-browser"]);
  });

  test("linux: xdg-open killed by signal (status=null + error) → fallback fires", () => {
    // The pre-fix bug: status===null was treated as success. Verify both
    // signal-kill and ENOENT trigger the fallback.
    const { runner, calls } = makeRunner([
      { status: null, error: new Error("Killed by signal") },
      { status: 0 },
    ]);
    const r = openBrowserSync("http://x", "linux", runner);

    expect(r.ok).toBe(true);
    expect(calls.map(c => c.cmd)).toEqual(["xdg-open", "sensible-browser"]);
  });

  test("linux: both xdg-open and sensible-browser fail → ok=false with reason", () => {
    const { runner } = makeRunner([
      { status: 1, error: new Error("ENOENT xdg-open") },
      { status: 1, error: new Error("ENOENT sensible-browser") },
    ]);
    const r = openBrowserSync("http://x", "linux", runner);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.method).toBe("none");
      expect(r.reason).toContain("xdg-open");
      expect(r.reason).toContain("sensible-browser");
    }
  });

  test("runner throws synchronously → caught, surfaced in reason", () => {
    const runner: SpawnSyncFn = () => { throw new Error("EMFILE"); };
    const r = openBrowserSync("http://x", "darwin", runner);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("EMFILE");
  });
});

describe("killProcessOnPort — Linux/macOS (lsof)", () => {
  test("port free (lsof status=1, empty stdout) → no kill, no error", () => {
    const { runner, calls } = makeRunner([
      { status: 1, stdout: "" },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.killedPids).toEqual([]);
    expect(r.attemptedPids).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("lsof");
    expect(calls[0].args).toEqual(["-ti", ":4747"]);
  });

  test("lsof ENOENT (binary missing) → surfaced as error, no kill attempt", () => {
    const { runner, calls } = makeRunner([
      { status: null, error: new Error("ENOENT") },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.attemptedPids).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/lsof.*ENOENT/);
    expect(calls).toHaveLength(1);
  });

  test("two pids, both kill cleanly → both reported as killed", () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: "1234\n5678\n" },
      { status: 0 },
      { status: 0 },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.killedPids).toEqual(["1234", "5678"]);
    expect(r.attemptedPids).toEqual(["1234", "5678"]);
    expect(r.errors).toEqual([]);

    // Argv check: each kill receives the pid as a single argv entry.
    expect(calls[1]).toEqual(expect.objectContaining({ cmd: "kill", args: ["1234"] }));
    expect(calls[2]).toEqual(expect.objectContaining({ cmd: "kill", args: ["5678"] }));
  });

  test("first pid kill fails → second pid still attempted (no abort)", () => {
    // Pre-fix: try/catch wrapped the entire for-loop, so a single pid
    // failure aborted the rest of the kills.
    const { runner } = makeRunner([
      { status: 0, stdout: "1111\n2222\n3333\n" },
      { status: 1, error: new Error("EPERM") },
      { status: 0 },
      { status: 0 },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.attemptedPids).toEqual(["1111", "2222", "3333"]);
    expect(r.killedPids).toEqual(["2222", "3333"]);
    expect(r.errors.join(" ")).toMatch(/kill 1111/);
  });

  test("runner throws on a kill → loop continues, error captured", () => {
    let calls = 0;
    const runner: SpawnSyncFn = (cmd, args) => {
      calls++;
      if (cmd === "lsof") {
        return { pid: 0, output: [], stdout: "1\n2\n", stderr: "", status: 0, signal: null } as ReturnType<SpawnSyncFn>;
      }
      if (cmd === "kill" && args[0] === "1") throw new Error("boom");
      return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null } as ReturnType<SpawnSyncFn>;
    };
    const r = killProcessOnPort(4747, "linux", runner);

    expect(calls).toBe(3);
    expect(r.attemptedPids).toEqual(["1", "2"]);
    expect(r.killedPids).toEqual(["2"]);
    expect(r.errors.join(" ")).toMatch(/boom/);
  });

  test("garbage in lsof stdout is filtered (only digit-PIDs accepted)", () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: "1234\n\nNot-a-pid\n5678\n" },
      { status: 0 },
      { status: 0 },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.killedPids).toEqual(["1234", "5678"]);
    expect(calls).toHaveLength(3); // lsof + 2 kills
  });
});

describe("killProcessOnPort — Windows (netstat)", () => {
  // Sample netstat -ano output. The MUST-NOT-KILL row's REMOTE column
  // contains :4747 — pre-fix `line.includes(":4747")` matched it and killed
  // the unrelated PID 9876.
  const netstatOut = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:4747           0.0.0.0:0              LISTENING       1234",
    "  TCP    192.168.1.5:54321      8.8.8.8:4747           ESTABLISHED     9876", // MUST NOT match
    "  UDP    0.0.0.0:4747           *:*                                    5555", // UDP, must not match
    "  TCP    [::]:4747              [::]:0                 LISTENING       1235",
    "",
  ].join("\r\n");

  test("only LISTENING TCP rows whose LOCAL column ends with :port are killed", () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: netstatOut },
      { status: 0 }, // taskkill 1234
      { status: 0 }, // taskkill 1235
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
    expect(r.attemptedPids).not.toContain("9876"); // remote-port match — was the bug
    expect(r.attemptedPids).not.toContain("5555"); // UDP — must not be killed

    // taskkill argv: /F /PID <pid> with no shell:true
    const killCalls = calls.filter(c => c.cmd === "taskkill");
    for (const c of killCalls) {
      expect(c.args[0]).toBe("/F");
      expect(c.args[1]).toBe("/PID");
      expect(c.opts).not.toHaveProperty("shell", true);
    }
  });

  test("netstat ENOENT → surfaced as error", () => {
    const { runner } = makeRunner([
      { status: null, error: new Error("ENOENT") },
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.errors.join(" ")).toMatch(/netstat.*ENOENT/);
    expect(r.attemptedPids).toEqual([]);
  });

  test("first taskkill fails → second pid still attempted", () => {
    const { runner } = makeRunner([
      { status: 0, stdout: netstatOut },
      { status: 1, error: new Error("Access denied") }, // taskkill 1234
      { status: 0 }, // taskkill 1235
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toContain("1234");
    expect(r.attemptedPids).toContain("1235");
    expect(r.killedPids).toContain("1235");
    expect(r.killedPids).not.toContain("1234");
    expect(r.errors.join(" ")).toMatch(/taskkill 1234/);
  });
});

describe("killProcessOnPort — input validation", () => {
  test("rejects out-of-range port without spawning anything", () => {
    const spy = vi.fn();
    const r = killProcessOnPort(70000, "linux", spy as unknown as SpawnSyncFn);

    expect(spy).not.toHaveBeenCalled();
    expect(r.errors.join(" ")).toMatch(/invalid port/);
  });

  test("rejects non-integer port without spawning anything", () => {
    const spy = vi.fn();
    const r = killProcessOnPort(3.14 as number, "linux", spy as unknown as SpawnSyncFn);

    expect(spy).not.toHaveBeenCalled();
    expect(r.errors.join(" ")).toMatch(/invalid port/);
  });
});

// ─── ctx_insight helper follow-ups (#441 follow-up) ──────────────────────────
//
// 1. Hard timeout on every helper-internal spawnSync. A hung lsof/xdg-open/
//    taskkill would otherwise block the MCP tool indefinitely. We assert the
//    timeout option is propagated to the runner — the actual cap value is an
//    implementation detail, but its presence is the regression we lock.
//
// 2. Windows non-English locale support. The pre-followup parser keyed off
//    `state !== "LISTENING"` which is locale-translated (Windows-FR shows
//    `À l'écoute`, Windows-DE `ABHÖREN`, Windows-ES `ESCUCHANDO`, etc.), so
//    on non-EN Windows the helper would silently match zero rows and never
//    free a stuck dashboard port. The remote-address column is NOT
//    locale-translated; we now key off it instead.

describe("Helper spawnSync timeout (#441 follow-up)", () => {
  test("openBrowserSync passes a timeout to the runner", () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    openBrowserSync("http://x", "darwin", runner);

    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toBeDefined();
    expect(typeof (calls[0].opts as { timeout?: number }).timeout).toBe("number");
    expect((calls[0].opts as { timeout: number }).timeout).toBeGreaterThan(0);
  });

  test("killProcessOnPort (Linux) passes a timeout to lsof and kill", () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: "1234\n" },
      { status: 0 }, // kill 1234
    ]);
    killProcessOnPort(4747, "linux", runner);

    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(typeof (c.opts as { timeout?: number }).timeout).toBe("number");
      expect((c.opts as { timeout: number }).timeout).toBeGreaterThan(0);
    }
  });

  test("killProcessOnPort (Windows) passes a timeout to netstat and taskkill", () => {
    const winFixture = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:4747           0.0.0.0:0              LISTENING       1234",
      "",
    ].join("\r\n");
    const { runner, calls } = makeRunner([
      { status: 0, stdout: winFixture },
      { status: 0 }, // taskkill 1234
    ]);
    killProcessOnPort(4747, "win32", runner);

    expect(calls.map(c => c.cmd)).toEqual(["netstat", "taskkill"]);
    for (const c of calls) {
      expect(typeof (c.opts as { timeout?: number }).timeout).toBe("number");
      expect((c.opts as { timeout: number }).timeout).toBeGreaterThan(0);
    }
  });
});

describe("killProcessOnPort — Windows non-English locale (#441 follow-up)", () => {
  // Same regression fixture as the en-US Windows test, but with the STATE
  // column translated. Pre-followup, the helper required `state === "LISTENING"`
  // and so silently produced zero PIDs on non-EN Windows. The follow-up keys
  // off the remote-address column (locale-independent) so this fixture must
  // now match LISTENING rows 1234 + 1235 and skip the ESTABLISHED row 9876
  // and the UDP row 5555.
  const netstatFr = [
    "Connexions actives",
    "",
    "  Proto  Adresse locale         Adresse distante       État            PID",
    "  TCP    0.0.0.0:4747           0.0.0.0:0              À l'écoute      1234",
    "  TCP    192.168.1.5:54321      8.8.8.8:4747           ESTABLI         9876",
    "  UDP    0.0.0.0:4747           *:*                                    5555",
    "  TCP    [::]:4747              [::]:0                 À l'écoute      1235",
    "",
  ].join("\r\n");

  const netstatDe = [
    "Aktive Verbindungen",
    "",
    "  Proto  Lokale Adresse         Remoteadresse          Status          PID",
    "  TCP    0.0.0.0:4747           0.0.0.0:0              ABHÖREN         1234",
    "  TCP    192.168.1.5:54321      8.8.8.8:4747           HERGESTELLT     9876",
    "  TCP    [::]:4747              [::]:0                 ABHÖREN         1235",
    "",
  ].join("\r\n");

  test("French Windows netstat output: kills 1234 and 1235, ignores 9876 + 5555", () => {
    const { runner } = makeRunner([
      { status: 0, stdout: netstatFr },
      { status: 0 }, // taskkill 1234
      { status: 0 }, // taskkill 1235
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
    expect(r.attemptedPids).not.toContain("9876");
    expect(r.attemptedPids).not.toContain("5555");
    expect(r.killedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
  });

  test("German Windows netstat output: kills 1234 and 1235, ignores 9876", () => {
    const { runner } = makeRunner([
      { status: 0, stdout: netstatDe },
      { status: 0 }, // taskkill 1234
      { status: 0 }, // taskkill 1235
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
    expect(r.attemptedPids).not.toContain("9876");
    expect(r.killedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
  });

  test("a connected remote :port still does NOT match (remote-column anchor)", () => {
    // Sanity: the predicate must still reject the ESTABLISHED row whose
    // REMOTE is 8.8.8.8:4747. This was the original pre-#441 bug; the
    // follow-up must not regress it while changing the locale strategy.
    const onlyEstablished = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    192.168.1.5:54321      8.8.8.8:4747           ESTABLISHED     9876",
      "",
    ].join("\r\n");
    const { runner, calls } = makeRunner([{ status: 0, stdout: onlyEstablished }]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toEqual([]);
    expect(calls).toHaveLength(1); // netstat only — no taskkill issued
  });
});
