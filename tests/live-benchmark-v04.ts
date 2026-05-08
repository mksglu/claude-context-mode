/**
 * Context Mode v0.4.0 — Comprehensive Live Benchmark
 * Tests ALL 5 tools with real-world use cases
 */

import { PolyglotExecutor } from "../src/executor.js";
import { ContentStore } from "../src/store.js";
import { detectRuntimes } from "../src/runtime.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");

const runtimes = detectRuntimes();
const executor = new PolyglotExecutor({ runtimes });

interface BenchmarkResult {
  tool: string;
  useCase: string;
  rawBytes: number;
  contextBytes: number;
  savingsPercent: number;
  durationMs: number;
  details: string;
}

const results: BenchmarkResult[] = [];

async function benchmark(
  tool: string,
  useCase: string,
  rawBytes: number,
  fn: () => Promise<{ output: string; details?: string }>,
): Promise<void> {
  const start = Date.now();
  const { output, details } = await fn();
  const durationMs = Date.now() - start;
  const contextBytes = Buffer.byteLength(output);
  const savingsPercent = Math.round((1 - contextBytes / rawBytes) * 100);

  results.push({
    tool,
    useCase,
    rawBytes,
    contextBytes,
    savingsPercent,
    durationMs,
    details: details || "",
  });

  console.log(
    `  ✓ ${useCase}: ${(rawBytes / 1024).toFixed(1)}KB → ${contextBytes}B (${savingsPercent}% saved, ${durationMs}ms)`,
  );
}

async function main() {
  console.log("\n=== Context Mode v0.4.0 — Live Benchmarks ===\n");

  // ─────────────────────────────────────────────────────
  // 1. fetch_and_index — Web Documentation
  // ─────────────────────────────────────────────────────
  console.log("── fetch_and_index (Web Docs) ──\n");

  // Test: Fetch example.com
  const fetchCode = `
    const resp = await fetch("https://example.com");
    const html = await resp.text();
    console.log(html);
  `;
  const rawExample = await executor.execute({ language: "javascript", code: fetchCode });
  const rawExampleBytes = Buffer.byteLength(rawExample.stdout);

  const store1 = new ContentStore();
  await benchmark("fetch_and_index", "example.com (simple HTML)", rawExampleBytes, async () => {
    // Simulate what fetch_and_index does
    const htmlCode = `
      const resp = await fetch("https://example.com");
      let html = await resp.text();
      html = html.replace(/<script[^>]*>[\\s\\S]*?<\\/script>/gi, "");
      html = html.replace(/<style[^>]*>[\\s\\S]*?<\\/style>/gi, "");
      html = html.replace(/<[^>]+>/g, "");
      html = html.replace(/\\n{3,}/g, "\\n\\n").trim();
      console.log(html);
    `;
    const result = await executor.execute({ language: "javascript", code: htmlCode });
    const indexed = store1.index({ content: result.stdout, source: "example.com" });
    const output = `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: example.com`;
    return { output, details: `${indexed.totalChunks} chunks` };
  });

  // Test: Fetch httpbin.org (API docs)
  const rawHttpbin = await executor.execute({
    language: "javascript",
    code: 'const r = await fetch("https://httpbin.org"); console.log(await r.text());',
  });
  const rawHttpbinBytes = Buffer.byteLength(rawHttpbin.stdout);

  if (rawHttpbinBytes > 100) {
    await benchmark("fetch_and_index", "httpbin.org (API reference)", rawHttpbinBytes, async () => {
      const htmlCode = `
        const resp = await fetch("https://httpbin.org");
        let html = await resp.text();
        html = html.replace(/<script[^>]*>[\\s\\S]*?<\\/script>/gi, "");
        html = html.replace(/<style[^>]*>[\\s\\S]*?<\\/style>/gi, "");
        html = html.replace(/<nav[^>]*>[\\s\\S]*?<\\/nav>/gi, "");
        html = html.replace(/<h1[^>]*>(.*?)<\\/h1>/gi, "\\n# $1\\n");
        html = html.replace(/<h2[^>]*>(.*?)<\\/h2>/gi, "\\n## $1\\n");
        html = html.replace(/<h3[^>]*>(.*?)<\\/h3>/gi, "\\n### $1\\n");
        html = html.replace(/<code[^>]*>([^<]*)<\\/code>/gi, "\\\`$1\\\`");
        html = html.replace(/<[^>]+>/g, "");
        html = html.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        html = html.replace(/\\n{3,}/g, "\\n\\n").trim();
        console.log(html);
      `;
      const result = await executor.execute({ language: "javascript", code: htmlCode });
      const store2 = new ContentStore();
      const indexed = store2.index({ content: result.stdout, source: "httpbin.org" });
      const output = `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: httpbin.org`;
      store2.close();
      return { output, details: `${indexed.totalChunks} chunks` };
    });
  }

  // ─────────────────────────────────────────────────────
  // 2. execute — Code Execution
  // ─────────────────────────────────────────────────────
  console.log("\n── execute (Code Execution) ──\n");

  // Test: npm ls (package tree)
  const rawNpmLs = await executor.execute({
    language: "shell",
    code: "cd /Users/mksglu/Server/Mert/context-mode-claude-code-plugin/context-mode && npm ls 2>/dev/null || true",
  });
  const rawNpmLsBytes = Buffer.byteLength(rawNpmLs.stdout);

  await benchmark("execute", "npm ls → dependency summary", rawNpmLsBytes, async () => {
    const result = await executor.execute({
      language: "shell",
      code: 'cd /Users/mksglu/Server/Mert/context-mode-claude-code-plugin/context-mode && echo "Dependencies: $(npm ls --depth=0 2>/dev/null | grep -c "├\\|└") direct, $(npm ls --all 2>/dev/null | wc -l | tr -d " ") total"',
    });
    return { output: result.stdout.trim(), details: "dep summary" };
  });

  // Test: System info
  const rawSysinfo = await executor.execute({
    language: "shell",
    code: "uname -a && sw_vers && sysctl -n hw.ncpu hw.memsize && df -h / && uptime",
  });
  const rawSysinfoBytes = Buffer.byteLength(rawSysinfo.stdout);

  await benchmark("execute", "System info → compact summary", rawSysinfoBytes, async () => {
    const result = await executor.execute({
      language: "javascript",
      code: `
        const { execSync } = require("child_process");
        const run = (c) => execSync(c).toString().trim();
        const os = run("uname -s");
        const ver = run("sw_vers -productVersion");
        const cpu = run("sysctl -n hw.ncpu");
        const mem = Math.round(parseInt(run("sysctl -n hw.memsize")) / 1073741824);
        console.log(\`\${os} \${ver} | \${cpu} cores | \${mem}GB RAM\`);
      `,
    });
    return { output: result.stdout.trim(), details: "compact info" };
  });

  // Test: Git log
  const rawGitLog = readFileSync(join(fixtureDir, "git-log.txt"), "utf-8");
  const rawGitLogBytes = Buffer.byteLength(rawGitLog);

  await benchmark("execute", "Git log (153 commits) → summary", rawGitLogBytes, async () => {
    const result = await executor.execute({
      language: "javascript",
      code: `
        const fs = require("fs");
        const log = fs.readFileSync("${join(fixtureDir, "git-log.txt")}", "utf-8");
        const lines = log.trim().split("\\n");
        const authors = {};
        lines.forEach(l => {
          const m = l.match(/^[a-f0-9]+ (.+?) \\d{4}/);
          if (m) authors[m[1]] = (authors[m[1]] || 0) + 1;
        });
        const top = Object.entries(authors).sort((a,b) => b[1]-a[1]).slice(0,3);
        console.log(\`\${lines.length} commits | Top: \${top.map(([n,c]) => n+"("+c+")").join(", ")}\`);
      `,
    });
    return { output: result.stdout.trim(), details: "git summary" };
  });

  // ─────────────────────────────────────────────────────
  // 3. execute_file — File Processing
  // ─────────────────────────────────────────────────────
  console.log("\n── execute_file (File Processing) ──\n");

  const fileTests = [
    {
      name: "Access log (500 req) → status breakdown",
      fixture: "access.log",
      code: `
        const lines = FILE_CONTENT.trim().split("\\n");
        const status = {};
        lines.forEach(l => { const m = l.match(/" (\\d{3}) /); if (m) status[m[1]] = (status[m[1]]||0)+1; });
        console.log(\`\${lines.length} requests | \${Object.entries(status).map(([s,c]) => s+":"+c).join(" ")}\`);
      `,
    },
    {
      name: "Analytics CSV (500 rows) → metric summary",
      fixture: "analytics.csv",
      code: `
        const rows = FILE_CONTENT.trim().split("\\n").slice(1);
        const events = {};
        rows.forEach(r => { const cols = r.split(","); events[cols[1]] = (events[cols[1]]||0)+1; });
        console.log(\`\${rows.length} events | Types: \${Object.entries(events).map(([e,c]) => e+":"+c).join(" ")}\`);
      `,
    },
    {
      name: "MCP tools.json (40 tools) → tool index",
      fixture: "mcp-tools.json",
      code: `
        const tools = JSON.parse(FILE_CONTENT);
        const names = (tools.tools || tools).map(t => t.name);
        console.log(\`\${names.length} tools: \${names.slice(0,5).join(", ")}...\`);
      `,
    },
    {
      name: "Test output (30 suites) → pass/fail",
      fixture: "test-output.txt",
      code: `
        const lines = FILE_CONTENT.trim().split("\\n");
        const pass = lines.filter(l => l.includes("✓") || l.includes("PASS")).length;
        const fail = lines.filter(l => l.includes("✗") || l.includes("FAIL")).length;
        console.log(\`\${pass} passed, \${fail} failed out of \${lines.length} lines\`);
      `,
    },
    {
      name: "package.json (23 deps) → dep summary",
      fixture: "package-large.json",
      code: `
        const pkg = JSON.parse(FILE_CONTENT);
        const deps = Object.keys(pkg.dependencies || {}).length;
        const dev = Object.keys(pkg.devDependencies || {}).length;
        console.log(\`\${pkg.name}@\${pkg.version} | \${deps} deps, \${dev} devDeps\`);
      `,
    },
  ];

  for (const ft of fileTests) {
    const raw = readFileSync(join(fixtureDir, ft.fixture), "utf-8");
    const rawBytes = Buffer.byteLength(raw);
    await benchmark("execute_file", ft.name, rawBytes, async () => {
      const result = await executor.executeFile({
        path: join(fixtureDir, ft.fixture),
        language: "javascript",
        code: ft.code,
      });
      return { output: result.stdout.trim() };
    });
  }

  // ─────────────────────────────────────────────────────
  // 4. index + search — Knowledge Base
  // ─────────────────────────────────────────────────────
  console.log("\n── index + search (Knowledge Base) ──\n");

  const store = new ContentStore();

  // Context7 React docs fixture
  const reactFixturePath = join(fixtureDir, "context7-react-docs.md");
  const reactRaw = readFileSync(reactFixturePath, "utf-8");
  const reactRawBytes = Buffer.byteLength(reactRaw);

  await benchmark("index+search", "Context7 React docs → search useEffect", reactRawBytes, async () => {
    store.index({ content: reactRaw, source: "Context7: React" });
    const results = store.search("useEffect cleanup", 2);
    const output = results.map((r, i) => `[${i + 1}] ${r.title}: ${r.content.substring(0, 80)}...`).join("\n");
    return { output, details: `${results.length} results` };
  });

  // Supabase Edge Functions fixture
  const supaFixturePath = join(fixtureDir, "context7-supabase-edge.md");
  try {
    const supaRaw = readFileSync(supaFixturePath, "utf-8");
    const supaRawBytes = Buffer.byteLength(supaRaw);

    await benchmark("index+search", "Context7 Supabase Edge → search RLS", supaRawBytes, async () => {
      store.index({ content: supaRaw, source: "Context7: Supabase" });
      const results = store.search("edge function deploy", 2);
      const output = results.map((r, i) => `[${i + 1}] ${r.title}: ${r.content.substring(0, 80)}...`).join("\n");
      return { output, details: `${results.length} results` };
    });
  } catch { /* fixture may not exist */ }

  // Next.js fixture
  const nextFixturePath = join(fixtureDir, "context7-nextjs-docs.md");
  try {
    const nextRaw = readFileSync(nextFixturePath, "utf-8");
    const nextRawBytes = Buffer.byteLength(nextRaw);

    await benchmark("index+search", "Context7 Next.js docs → search routing", nextRawBytes, async () => {
      store.index({ content: nextRaw, source: "Context7: Next.js" });
      const results = store.search("app router", 2);
      const output = results.map((r, i) => `[${i + 1}] ${r.title}: ${r.content.substring(0, 80)}...`).join("\n");
      return { output, details: `${results.length} results` };
    });
  } catch { /* fixture may not exist */ }

  store.close();

  // ─────────────────────────────────────────────────────
  // Summary Table
  // ─────────────────────────────────────────────────────
  console.log("\n\n=== BENCHMARK SUMMARY ===\n");
  console.log("| Tool | Use Case | Raw | Context | Savings | Time |");
  console.log("|------|----------|-----|---------|---------|------|");
  for (const r of results) {
    console.log(
      `| ${r.tool} | ${r.useCase} | ${(r.rawBytes / 1024).toFixed(1)}KB | ${r.contextBytes}B | ${r.savingsPercent}% | ${r.durationMs}ms |`,
    );
  }

  // Aggregate stats
  const totalRaw = results.reduce((s, r) => s + r.rawBytes, 0);
  const totalCtx = results.reduce((s, r) => s + r.contextBytes, 0);
  const avgSavings = Math.round((1 - totalCtx / totalRaw) * 100);
  console.log(`\nAggregate: ${(totalRaw / 1024).toFixed(1)}KB raw → ${(totalCtx / 1024).toFixed(1)}KB context (${avgSavings}% average savings)`);
  console.log(`Total benchmarks: ${results.length}`);

  // Write results to JSON for README consumption
  writeFileSync(
    join(__dirname, "benchmark-results-v04.json"),
    JSON.stringify({ version: "0.4.0", date: new Date().toISOString(), results, aggregate: { totalRaw, totalCtx, avgSavings } }, null, 2),
  );
  console.log("\nResults saved to tests/benchmark-results-v04.json");

  store1.close();
}

main().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
