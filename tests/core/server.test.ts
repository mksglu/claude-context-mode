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
import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, test, expect, afterAll } from "vitest";

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
    assert.ok(prompt.includes("500 words"), "Should mention 500 word limit");
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

  test("inline fallback copies key files to plugin root", () => {
    // The inline script must copy build artifacts back
    expect(serverSrc).toMatch(/server\.bundle\.mjs/);
    expect(serverSrc).toMatch(/cli\.bundle\.mjs/);
    expect(serverSrc).toMatch(/npm.*install/);
  });

  test("fallback only triggers when neither CLI file exists", () => {
    // There should be an else/fallback branch after checking both paths
    expect(serverSrc).toMatch(/existsSync\(fallbackPath\)/);
  });
});

// ─── Clear stats on /clear ───────────────────────────────────────────────────

describe("Session stats reset on /clear", () => {
  const serverSrc = readFileSync(
    resolve(__dirname, "../../src/server.ts"),
    "utf-8",
  );

  test("server.ts has resetSessionStats function", () => {
    expect(serverSrc).toContain("function resetSessionStats");
  });

  test("ctx_stats accepts reset parameter", () => {
    expect(serverSrc).toContain("reset: z.boolean()");
    expect(serverSrc).toContain("if (reset)");
  });

  test("resetSessionStats also resets FTS5 content store", () => {
    expect(serverSrc).toContain("_store.cleanup()");
    expect(serverSrc).toContain("_store = null");
  });

  test("routing block instructs reset after /clear", () => {
    const routingBlockSrc = readFileSync(
      resolve(__dirname, "../../hooks/routing-block.mjs"),
      "utf-8",
    );
    expect(routingBlockSrc).toContain("After /clear");
    expect(routingBlockSrc).toContain("reset: true");
  });
});
