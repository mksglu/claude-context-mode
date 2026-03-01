import { strict as assert } from "node:assert";
import { PolyglotExecutor } from "../src/executor.js";
import { createRequire } from "node:module";

let passed = 0;
let failed = 0;
const results: { name: string; status: "PASS" | "FAIL"; time: number; error?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    const time = performance.now() - start;
    passed++;
    results.push({ name, status: "PASS", time });
    console.log(`  ✓ ${name} (${time.toFixed(0)}ms)`);
  } catch (err: unknown) {
    const time = performance.now() - start;
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "FAIL", time, error: message });
    console.log(`  ✗ ${name} (${time.toFixed(0)}ms)`);
    console.log(`    ${message}`);
  }
}

// Resolve turndown path the same way server.ts will
const require = createRequire(import.meta.url);
const turndownPath = require.resolve("turndown");
const gfmPath = require.resolve("turndown-plugin-gfm");

const executor = new PolyglotExecutor();

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

console.log("\nturndown HTML-to-markdown conversion tests\n");

await test("converts headings", async () => {
  const result = await executor.execute({
    language: "javascript",
    code: buildConversionCode("<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>"),
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert(result.stdout.includes("# Title"), `expected '# Title', got: ${result.stdout}`);
  assert(result.stdout.includes("## Subtitle"));
  assert(result.stdout.includes("### Section"));
});

await test("converts links", async () => {
  const result = await executor.execute({
    language: "javascript",
    code: buildConversionCode('<p>Visit <a href="https://example.com">Example</a></p>'),
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert(result.stdout.includes("[Example](https://example.com)"));
});

await test("converts fenced code blocks", async () => {
  const result = await executor.execute({
    language: "javascript",
    code: buildConversionCode('<pre><code class="language-js">const x = 1;</code></pre>'),
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert(result.stdout.includes("```"), `expected fenced code block, got: ${result.stdout}`);
  assert(result.stdout.includes("const x = 1;"));
});

await test("strips script tags", async () => {
  const result = await executor.execute({
    language: "javascript",
    code: buildConversionCode("<p>Hello</p><script>alert('xss')</script><p>World</p>"),
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert(!result.stdout.includes("alert"), `script content leaked: ${result.stdout}`);
  assert(result.stdout.includes("Hello"));
  assert(result.stdout.includes("World"));
});

await test("strips style, nav, header, footer, noscript tags", async () => {
  const html = [
    "<style>body { color: red; }</style>",
    "<header><nav>Menu</nav></header>",
    "<main><p>Content</p></main>",
    "<footer>Footer</footer>",
    "<noscript>Enable JS</noscript>",
  ].join("");
  const result = await executor.execute({
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

await test("converts tables", async () => {
  const html = `
    <table>
      <thead><tr><th>Name</th><th>Age</th></tr></thead>
      <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
    </table>`;
  const result = await executor.execute({
    language: "javascript",
    code: buildConversionCode(html),
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert(result.stdout.includes("| Name"), `expected pipe table, got: ${result.stdout}`);
  assert(result.stdout.includes("| Alice"));
  assert(result.stdout.includes("| ---"), `expected table separator, got: ${result.stdout}`);
});

await test("handles nested tags correctly", async () => {
  const html = '<div><p>Outer <strong>bold <em>and italic</em></strong> text</p></div>';
  const result = await executor.execute({
    language: "javascript",
    code: buildConversionCode(html),
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert(result.stdout.includes("**bold"), `missing bold: ${result.stdout}`);
  assert(result.stdout.includes("italic"), `missing italic: ${result.stdout}`);
});

await test("handles malformed HTML gracefully", async () => {
  const html = "<p>Unclosed paragraph<p>Another<div>Nested badly</p></div>";
  const result = await executor.execute({
    language: "javascript",
    code: buildConversionCode(html),
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert(result.stdout.includes("Unclosed paragraph"), `lost content: ${result.stdout}`);
  assert(result.stdout.includes("Nested badly"), `lost nested content: ${result.stdout}`);
});

await test("decodes HTML entities", async () => {
  const result = await executor.execute({
    language: "javascript",
    code: buildConversionCode("<p>Tom &amp; Jerry &lt;3 &quot;cheese&quot;</p>"),
  });
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert(result.stdout.includes('Tom & Jerry <3 "cheese"'), `entities not decoded: ${result.stdout}`);
});

// Summary
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
