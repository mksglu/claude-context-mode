/**
 * Ecosystem Benchmark Test
 *
 * Benchmarks context-mode against REAL outputs from popular Claude Code
 * MCP servers and Skills that developers use daily:
 *
 *   - Context7 (documentation lookup)
 *   - Playwright (browser automation)
 *   - GitHub (PRs, issues via gh CLI)
 *   - Dev tools (build output, test output, tsc errors)
 *
 * All fixtures are captured from actual tool invocations — not synthetic data.
 * This provides honest, reproducible benchmarks for the open-source community.
 */

import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes, getRuntimeSummary } from "../src/runtime.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");

const runtimes = detectRuntimes();
const executor = new PolyglotExecutor({ runtimes });

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface EcosystemScenario {
  tool: string;
  name: string;
  fixture: string;
  description: string;
  language: "javascript" | "python";
  code: string;
}

interface BenchmarkRow {
  tool: string;
  name: string;
  rawBytes: number;
  contextBytes: number;
  savings: string;
  execMs: number;
}

// ─────────────────────────────────────────────────────────
// Scenarios grouped by ecosystem tool
// ─────────────────────────────────────────────────────────

const scenarios: EcosystemScenario[] = [
  // ── Context7 MCP ──
  {
    tool: "Context7",
    name: "React useEffect docs",
    fixture: "context7-react-docs.md",
    description: "Context7 query: React useEffect hook usage and cleanup",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const codeBlocks = FILE_CONTENT.match(/\`\`\`[\\s\\S]*?\`\`\`/g) || [];
      const sections = FILE_CONTENT.split(/^---+$/m).filter(Boolean);
      const apis = [...FILE_CONTENT.matchAll(/\`(use\\w+)\`/g)].map(m => m[1]);
      const uniqueApis = [...new Set(apis)];

      console.log("Context7 — React Docs Summary");
      console.log("Lines:", lines.length, "| Sections:", sections.length, "| Code blocks:", codeBlocks.length);
      console.log("APIs mentioned:", uniqueApis.join(", "));
      console.log("Key topics:");
      if (FILE_CONTENT.includes("cleanup")) console.log("  - Cleanup functions");
      if (FILE_CONTENT.includes("dependencies")) console.log("  - Dependency arrays");
      if (FILE_CONTENT.includes("fetch")) console.log("  - Data fetching patterns");
      if (FILE_CONTENT.includes("subscribe")) console.log("  - Event subscriptions");
      console.log("Total size:", FILE_CONTENT.length, "chars →", codeBlocks.length, "examples extracted");
    `,
  },
  {
    tool: "Context7",
    name: "Next.js App Router docs",
    fixture: "context7-nextjs-docs.md",
    description: "Context7 query: App Router server components data fetching",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const codeBlocks = FILE_CONTENT.match(/\`\`\`[\\s\\S]*?\`\`\`/g) || [];
      const sections = FILE_CONTENT.split(/^---+$/m).filter(Boolean);
      const patterns = [];
      if (FILE_CONTENT.includes("async")) patterns.push("async components");
      if (FILE_CONTENT.includes("cache")) patterns.push("caching strategies");
      if (FILE_CONTENT.includes("revalidate")) patterns.push("ISR/revalidation");
      if (FILE_CONTENT.includes("no-store")) patterns.push("no-cache SSR");
      if (FILE_CONTENT.includes("generateStaticParams")) patterns.push("static generation");
      if (FILE_CONTENT.includes("use client")) patterns.push("client components");

      console.log("Context7 — Next.js App Router Summary");
      console.log("Lines:", lines.length, "| Sections:", sections.length, "| Code blocks:", codeBlocks.length);
      console.log("Data fetching patterns:", patterns.join(", "));
      console.log("Migration from Pages Router:", FILE_CONTENT.includes("getServerSideProps") ? "Yes" : "No");
      console.log("Total size:", FILE_CONTENT.length, "chars → summary above");
    `,
  },
  {
    tool: "Context7",
    name: "Tailwind CSS docs",
    fixture: "context7-tailwind-docs.md",
    description: "Context7 query: Tailwind responsive design, flexbox, grid",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const codeBlocks = FILE_CONTENT.match(/\`\`\`[\\s\\S]*?\`\`\`/g) || [];
      const classes = [...FILE_CONTENT.matchAll(/(?:class(?:Name)?=")([^"]+)/g)].map(m => m[1]);
      const allClasses = classes.join(" ").split(/\\s+/);
      const responsive = allClasses.filter(c => /^(sm|md|lg|xl|2xl):/.test(c));
      const flexGrid = allClasses.filter(c => /^(flex|grid|col|row|gap|justify|items|self)/.test(c));

      console.log("Context7 — Tailwind CSS Summary");
      console.log("Lines:", lines.length, "| Code blocks:", codeBlocks.length);
      console.log("Total classes found:", allClasses.length);
      console.log("Responsive variants:", responsive.length, "→", [...new Set(responsive.map(c => c.split(":")[0]))].join(", "));
      console.log("Flex/Grid classes:", flexGrid.length);
      console.log("Total size:", FILE_CONTENT.length, "chars → summary above");
    `,
  },

  // ── Playwright MCP ──
  {
    tool: "Playwright",
    name: "Page snapshot (HN)",
    fixture: "playwright-snapshot.txt",
    description: "Playwright browser_snapshot: Hacker News accessibility tree",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const links = [...FILE_CONTENT.matchAll(/- link "([^"]+)"/g)].map(m => m[1]);
      const buttons = [...FILE_CONTENT.matchAll(/- button "([^"]+)"/g)].map(m => m[1]);
      const textItems = [...FILE_CONTENT.matchAll(/- text: (.+)/g)].map(m => m[1]);
      const refs = [...FILE_CONTENT.matchAll(/\\[ref=(\\w+)\\]/g)];

      console.log("Playwright — Page Snapshot Summary");
      console.log("Lines:", lines.length, "| DOM refs:", refs.length);
      console.log("Links:", links.length, "| Buttons:", buttons.length, "| Text nodes:", textItems.length);

      // Extract story titles (HN specific)
      const stories = links.filter(l => !l.startsWith("http") && l.length > 10 && !["new", "past", "comments", "ask", "show", "jobs", "submit", "login"].includes(l.toLowerCase()));
      console.log("Stories found:", Math.min(stories.length, 30));
      if (stories.length > 0) {
        console.log("Top 5:");
        stories.slice(0, 5).forEach((s, i) => console.log("  " + (i+1) + ". " + s));
      }
      console.log("Raw snapshot:", FILE_CONTENT.length, "chars → summary above");
    `,
  },
  {
    tool: "Playwright",
    name: "Network requests",
    fixture: "playwright-network.txt",
    description: "Playwright browser_network_requests: all HTTP requests",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.trim().split("\\n").filter(Boolean);
      const requests = lines.map(l => {
        const parts = l.split(" ");
        return { method: parts[0], status: parts[1], url: parts.slice(2).join(" ") };
      }).filter(r => r.method && r.status);

      console.log("Playwright — Network Summary");
      console.log("Requests:", requests.length);
      const byStatus = {};
      requests.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
      console.log("Status:", Object.entries(byStatus).map(([s,c]) => s + ":" + c).join(", "));
      const types = { doc: 0, css: 0, js: 0, img: 0, other: 0 };
      requests.forEach(r => {
        const url = r.url || "";
        if (url.endsWith(".css")) types.css++;
        else if (url.endsWith(".js")) types.js++;
        else if (/\\.(png|jpg|svg|gif|ico|webp)/.test(url)) types.img++;
        else if (url.includes("text/html") || requests.indexOf(r) === 0) types.doc++;
        else types.other++;
      });
      console.log("Types:", Object.entries(types).filter(([,v]) => v > 0).map(([k,v]) => k + ":" + v).join(", "));
    `,
  },

  // ── GitHub (gh CLI) ──
  {
    tool: "GitHub",
    name: "PR list (Next.js)",
    fixture: "github-prs.json",
    description: "gh pr list --repo vercel/next.js: 5 recent PRs with bodies",
    language: "javascript",
    code: `
      const prs = JSON.parse(FILE_CONTENT);
      console.log("GitHub — PR List Summary");
      console.log("PRs:", prs.length, "| Repo: vercel/next.js");

      let totalAdd = 0, totalDel = 0, totalFiles = 0;
      prs.forEach(pr => {
        totalAdd += pr.additions || 0;
        totalDel += pr.deletions || 0;
        totalFiles += pr.changedFiles || 0;
        const labels = (pr.labels || []).map(l => l.name).join(", ") || "none";
        console.log("  #" + pr.number + " " + pr.title);
        console.log("    by " + pr.author?.login + " | +" + (pr.additions||0) + " -" + (pr.deletions||0) + " | " + (pr.changedFiles||0) + " files | labels: " + labels);
      });
      console.log("Total: +" + totalAdd + " -" + totalDel + " across " + totalFiles + " files");
    `,
  },
  {
    tool: "GitHub",
    name: "Issues (React)",
    fixture: "github-issues.json",
    description: "gh issue list --repo facebook/react: 20 open issues",
    language: "javascript",
    code: `
      const issues = JSON.parse(FILE_CONTENT);
      console.log("GitHub — Issues Summary");
      console.log("Issues:", issues.length, "| Repo: facebook/react");

      const byLabel = {};
      issues.forEach(issue => {
        (issue.labels || []).forEach(l => {
          byLabel[l.name] = (byLabel[l.name] || 0) + 1;
        });
      });

      console.log("\\nBy label:");
      Object.entries(byLabel).sort((a,b) => b[1]-a[1]).slice(0, 8).forEach(([l,c]) => {
        console.log("  " + l + ": " + c);
      });

      console.log("\\nRecent issues:");
      issues.slice(0, 8).forEach(issue => {
        const labels = (issue.labels || []).map(l => l.name).join(", ") || "unlabeled";
        console.log("  #" + issue.number + " " + issue.title.slice(0, 60));
        console.log("    by " + issue.author?.login + " [" + labels + "]");
      });
    `,
  },

  // ── Dev Tools (existing fixtures) ──
  {
    tool: "vitest",
    name: "Test output (30 suites)",
    fixture: "test-output.txt",
    description: "vitest run: 30 test suites with pass/fail details",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const suitePass = lines.filter(l => l.trimStart().startsWith("\\u2713") && !l.startsWith("  ")).length;
      const suiteFail = lines.filter(l => l.trimStart().startsWith("\\u2717") && !l.startsWith("  ")).length;
      const testPass = lines.filter(l => l.match(/^\\s+\\u2713/)).length;
      const testFail = lines.filter(l => l.match(/^\\s+\\u2717/)).length;
      console.log("vitest — Test Results Summary");
      console.log("Suites:", suitePass, "passed,", suiteFail, "failed");
      console.log("Tests:", testPass, "passed,", testFail, "failed");
      const failLines = lines.filter(l => l.match(/^\\s+\\u2717/));
      if (failLines.length) {
        console.log("Failures:");
        failLines.slice(0, 5).forEach(l => console.log("  " + l.trim()));
      }
    `,
  },
  {
    tool: "tsc",
    name: "TypeScript errors (50)",
    fixture: "tsc-errors.txt",
    description: "tsc --noEmit: 50 type errors across 8 files",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.trim().split("\\n").filter(l => l.includes("error TS"));
      const byFile = {};
      const byCode = {};
      lines.forEach(l => {
        const file = l.split("(")[0];
        const code = l.match(/TS\\d+/)?.[0] || "?";
        byFile[file] = (byFile[file] || 0) + 1;
        byCode[code] = (byCode[code] || 0) + 1;
      });
      console.log("tsc — Error Summary");
      console.log("Errors:", lines.length, "in", Object.keys(byFile).length, "files");
      console.log("By file:");
      Object.entries(byFile).sort((a,b) => b[1]-a[1]).forEach(([f,c]) => console.log("  " + f + ":", c));
      console.log("Top codes:");
      Object.entries(byCode).sort((a,b) => b[1]-a[1]).slice(0,5).forEach(([c,n]) => console.log("  " + c + ":", n));
    `,
  },
  {
    tool: "next build",
    name: "Build output (100+ lines)",
    fixture: "build-output.txt",
    description: "next build: compiled routes, warnings, errors",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const errors = lines.filter(l => /error/i.test(l)).length;
      const warnings = lines.filter(l => /warn/i.test(l)).length;
      const routes = lines.filter(l => /^[○●ƒλ]/.test(l.trim()) || /^\\//.test(l.trim())).length;
      console.log("next build — Summary");
      console.log("Lines:", lines.length, "| Routes:", routes, "| Warnings:", warnings, "| Errors:", errors);
      if (errors > 0) {
        console.log("Error lines:");
        lines.filter(l => /error/i.test(l)).slice(0, 3).forEach(l => console.log("  " + l.trim()));
      }
    `,
  },
  {
    tool: "MCP tools/list",
    name: "MCP tools (40 tools)",
    fixture: "mcp-tools.json",
    description: "MCP server tools/list: 40 tools with JSON Schema",
    language: "javascript",
    code: `
      const tools = JSON.parse(FILE_CONTENT);
      console.log("MCP — Tools Discovery Summary");
      console.log("Total tools:", tools.length);
      const categories = {};
      tools.forEach(t => {
        const cat = t.name.split("_")[0] || "other";
        categories[cat] = (categories[cat] || 0) + 1;
      });
      console.log("Categories:", Object.entries(categories).map(([k,v]) => k + ":" + v).join(", "));
      console.log("\\nTool signatures:");
      tools.slice(0, 10).forEach(t => {
        const props = Object.keys(t.inputSchema?.properties || {});
        const req = t.inputSchema?.required || [];
        const sig = props.map(p => req.includes(p) ? p : p + "?").join(", ");
        console.log("  " + t.name + "(" + sig + ")");
      });
      if (tools.length > 10) console.log("  ... +" + (tools.length - 10) + " more");
    `,
  },
  {
    tool: "nginx",
    name: "Access log (500 req)",
    fixture: "access.log",
    description: "nginx access log: 500 HTTP requests with latency",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.trim().split("\\n");
      const statuses = {};
      let errors = 0, totalMs = 0, count = 0;
      lines.forEach(l => {
        const s = l.match(/" (\\d+) /)?.[1]; if (s) { statuses[s] = (statuses[s]||0)+1; if (+s >= 400) errors++; }
        const ms = l.match(/(\\d+)ms$/)?.[1]; if (ms) { totalMs += +ms; count++; }
      });
      console.log("nginx — Access Log Summary");
      console.log("Requests:", lines.length, "| Errors:", errors, "(" + ((errors/lines.length)*100).toFixed(1) + "%)");
      console.log("Avg latency:", Math.round(totalMs/count) + "ms");
      console.log("Status:", Object.entries(statuses).sort((a,b)=>b[1]-a[1]).map(([s,c])=>s+":"+c).join(", "));
    `,
  },
  {
    tool: "git",
    name: "Git log (150+ commits)",
    fixture: "git-log.txt",
    description: "git log --oneline: 150+ conventional commits",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.trim().split("\\n");
      const byType = {};
      lines.forEach(l => {
        const type = l.split(" ")[4]?.replace(":", "") || "other";
        byType[type] = (byType[type] || 0) + 1;
      });
      console.log("git — Log Summary");
      console.log("Commits:", lines.length);
      console.log("By type:", Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([t,c])=>t+":"+c).join(", "));
    `,
  },
];

// Add Python CSV scenario if available
if (runtimes.python) {
  scenarios.push({
    tool: "analytics",
    name: "Analytics CSV (500 rows)",
    fixture: "analytics.csv",
    description: "Event analytics: 500 events with user_id, action, status",
    language: "python",
    code: `
import csv, io
from collections import Counter

reader = csv.DictReader(io.StringIO(FILE_CONTENT))
rows = list(reader)

actions = Counter(r["action"] for r in rows)
statuses = Counter(r["status"] for r in rows)
unique_users = len(set(r["user_id"] for r in rows))
avg_ms = sum(int(r["duration_ms"]) for r in rows) / len(rows)

print(f"analytics — CSV Summary")
print(f"Events: {len(rows)} | Users: {unique_users} | Avg latency: {avg_ms:.0f}ms")
print(f"Actions: {dict(actions.most_common())}")
print(f"Statuses: {dict(statuses.most_common())}")
    `,
  });
}

// ─────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log(
    "\u2554" + "\u2550".repeat(74) + "\u2557",
  );
  console.log(
    "\u2551" +
      "   Context Mode — Ecosystem Benchmark (Real MCP & Skill Outputs)        " +
      "\u2551",
  );
  console.log(
    "\u255A" + "\u2550".repeat(74) + "\u255D",
  );
  console.log("");
  console.log("Runtimes:\n" + getRuntimeSummary(runtimes));
  console.log("\nFixtures: tests/fixtures/ (captured from real tool invocations)");
  console.log("");

  const rows: BenchmarkRow[] = [];
  let skipped = 0;

  // Group scenarios by tool
  const toolGroups = new Map<string, EcosystemScenario[]>();
  for (const s of scenarios) {
    const group = toolGroups.get(s.tool) || [];
    group.push(s);
    toolGroups.set(s.tool, group);
  }

  for (const [tool, group] of toolGroups) {
    console.log(`\u250C\u2500\u2500\u2500 ${tool.toUpperCase()} ${"─".repeat(Math.max(0, 68 - tool.length))}`);
    console.log("\u2502");

    for (const scenario of group) {
      const filePath = join(fixtureDir, scenario.fixture);

      if (!existsSync(filePath)) {
        console.log(`\u2502  SKIP: ${scenario.fixture} not found`);
        skipped++;
        continue;
      }

      const rawContent = readFileSync(filePath, "utf-8");
      const rawBytes = Buffer.byteLength(rawContent, "utf-8");

      const start = performance.now();
      const result = await executor.executeFile({
        path: filePath,
        language: scenario.language,
        code: scenario.code,
      });
      const execMs = Math.round(performance.now() - start);

      if (result.exitCode !== 0) {
        console.log(`\u2502  ERROR: ${scenario.name}`);
        console.log(`\u2502    ${result.stderr.slice(0, 200)}`);
        continue;
      }

      const contextBytes = Buffer.byteLength(result.stdout, "utf-8");
      const savings = ((1 - contextBytes / rawBytes) * 100).toFixed(0);

      rows.push({
        tool,
        name: scenario.name,
        rawBytes,
        contextBytes,
        savings: savings + "%",
        execMs,
      });

      console.log(`\u2502  \u2713 ${scenario.name} (${execMs}ms)`);
      console.log(
        `\u2502    ${(rawBytes / 1024).toFixed(1)}KB raw → ${contextBytes}B context (${savings}% saved)`,
      );
      console.log(`\u2502`);
      console.log(`\u2502    What Claude sees:`);
      result.stdout
        .trim()
        .split("\n")
        .slice(0, 6)
        .forEach((line) => console.log(`\u2502      ${line}`));
      const totalLines = result.stdout.trim().split("\n").length;
      if (totalLines > 6) console.log(`\u2502      ... +${totalLines - 6} more lines`);
      console.log(`\u2502`);
    }

    console.log(`\u2514${"─".repeat(74)}`);
    console.log("");
  }

  // ===== SUMMARY TABLE =====
  console.log(
    "\u2554" + "\u2550".repeat(74) + "\u2557",
  );
  console.log(
    "\u2551" +
      "                        Ecosystem Benchmark Results                      " +
      "\u2551",
  );
  console.log(
    "\u255A" + "\u2550".repeat(74) + "\u255D",
  );
  console.log("");

  // Per-tool summary
  const toolSummary = new Map<string, { rawBytes: number; contextBytes: number; count: number; totalMs: number }>();
  for (const r of rows) {
    const s = toolSummary.get(r.tool) || { rawBytes: 0, contextBytes: 0, count: 0, totalMs: 0 };
    s.rawBytes += r.rawBytes;
    s.contextBytes += r.contextBytes;
    s.count++;
    s.totalMs += r.execMs;
    toolSummary.set(r.tool, s);
  }

  console.log(
    "| Tool           | Scenarios | Raw Size   | Context    | Savings | Avg Time |",
  );
  console.log(
    "|----------------|-----------|------------|------------|---------|----------|",
  );
  for (const [tool, s] of toolSummary) {
    const savings = ((1 - s.contextBytes / s.rawBytes) * 100).toFixed(0) + "%";
    const avgMs = Math.round(s.totalMs / s.count) + "ms";
    console.log(
      `| ${tool.padEnd(14)} | ${String(s.count).padStart(9)} | ${((s.rawBytes / 1024).toFixed(1) + "KB").padStart(10)} | ${(s.contextBytes + "B").padStart(10)} | ${savings.padStart(7)} | ${avgMs.padStart(8)} |`,
    );
  }
  console.log(
    "|----------------|-----------|------------|------------|---------|----------|",
  );

  const totalRaw = rows.reduce((s, r) => s + r.rawBytes, 0);
  const totalCtx = rows.reduce((s, r) => s + r.contextBytes, 0);
  const totalMs = rows.reduce((s, r) => s + r.execMs, 0);
  const totalSavings = ((1 - totalCtx / totalRaw) * 100).toFixed(0) + "%";

  console.log(
    `| ${"TOTAL".padEnd(14)} | ${String(rows.length).padStart(9)} | ${((totalRaw / 1024).toFixed(1) + "KB").padStart(10)} | ${(totalCtx + "B").padStart(10)} | ${totalSavings.padStart(7)} | ${(Math.round(totalMs / rows.length) + "ms").padStart(8)} |`,
  );
  console.log("");

  // ===== DETAILED TABLE =====
  console.log(
    "| Scenario                          | Tool           | Raw        | Context   | Savings | Time  |",
  );
  console.log(
    "|-----------------------------------|----------------|------------|-----------|---------|-------|",
  );
  for (const r of rows) {
    console.log(
      `| ${r.name.padEnd(33)} | ${r.tool.padEnd(14)} | ${((r.rawBytes / 1024).toFixed(1) + "KB").padStart(10)} | ${(r.contextBytes + "B").padStart(9)} | ${r.savings.padStart(7)} | ${(r.execMs + "ms").padStart(5)} |`,
    );
  }
  console.log("");

  // ===== CONTEXT WINDOW IMPACT =====
  console.log(
    "\u2554" + "\u2550".repeat(74) + "\u2557",
  );
  console.log(
    "\u2551" +
      "                  Context Window Impact Analysis                         " +
      "\u2551",
  );
  console.log(
    "\u255A" + "\u2550".repeat(74) + "\u255D",
  );
  console.log("");

  const rawTokens = Math.ceil(totalRaw / 4);
  const ctxTokens = Math.ceil(totalCtx / 4);
  const multiplier = Math.floor(rawTokens / ctxTokens);

  console.log("  Claude's context window: 200,000 tokens");
  console.log("");
  console.log("  WITHOUT context-mode (raw file reads):");
  console.log(
    `    ${rawTokens.toLocaleString()} tokens consumed → ${((rawTokens / 200_000) * 100).toFixed(1)}% of context window`,
  );
  console.log("");
  console.log("  WITH context-mode (execute_file summaries):");
  console.log(
    `    ${ctxTokens.toLocaleString()} tokens consumed → ${((ctxTokens / 200_000) * 100).toFixed(2)}% of context window`,
  );
  console.log("");
  console.log(`  Tokens saved:    ${(rawTokens - ctxTokens).toLocaleString()}`);
  console.log(`  Context saved:   ${totalSavings}`);
  console.log(`  Multiplier:      ${multiplier}x more data per session`);
  console.log("");

  // ===== REAL WORKFLOW EXAMPLE =====
  console.log(
    "\u2554" + "\u2550".repeat(74) + "\u2557",
  );
  console.log(
    "\u2551" +
      "               Real Workflow: Debug a Next.js App                        " +
      "\u2551",
  );
  console.log(
    "\u255A" + "\u2550".repeat(74) + "\u255D",
  );
  console.log("");
  console.log('  Developer: "Tests are failing after upgrading Next.js. Fix it."');
  console.log("");
  console.log("  Claude needs to:");
  console.log("    1. Look up Next.js migration docs          → Context7");
  console.log("    2. Read test output (30 suites)            → vitest");
  console.log("    3. Read TypeScript errors (50)             → tsc");
  console.log("    4. Check build output                      → next build");
  console.log("    5. Review recent PRs for breaking changes  → GitHub");
  console.log("    6. Browse app to verify behavior           → Playwright");
  console.log("");

  const workflowTools = ["Context7", "vitest", "tsc", "next build", "GitHub", "Playwright"];
  let workflowRaw = 0;
  let workflowCtx = 0;
  for (const tool of workflowTools) {
    const toolRows = rows.filter(r => r.tool === tool);
    if (toolRows.length > 0) {
      const row = toolRows[0]; // Take first scenario per tool
      workflowRaw += row.rawBytes;
      workflowCtx += row.contextBytes;
    }
  }

  const wfRawTokens = Math.ceil(workflowRaw / 4);
  const wfCtxTokens = Math.ceil(workflowCtx / 4);

  console.log(
    `  WITHOUT context-mode: ${(workflowRaw / 1024).toFixed(1)}KB → ${wfRawTokens.toLocaleString()} tokens (${((wfRawTokens / 200_000) * 100).toFixed(1)}% of context GONE)`,
  );
  console.log(
    `  WITH context-mode:    ${(workflowCtx / 1024).toFixed(1)}KB → ${wfCtxTokens.toLocaleString()} tokens (${((wfCtxTokens / 200_000) * 100).toFixed(2)}% of context)`,
  );
  console.log(
    `  Result: ${((1 - workflowCtx / workflowRaw) * 100).toFixed(0)}% more context available for actual problem solving`,
  );
  console.log("");

  // ===== FINAL STATUS =====
  console.log("═".repeat(76));
  console.log(
    `Ecosystem Benchmark: ${rows.length} scenarios passed, ${skipped} skipped`,
  );
  console.log(
    `Overall: ${(totalRaw / 1024).toFixed(0)}KB raw → ${(totalCtx / 1024).toFixed(1)}KB context = ${totalSavings} savings (${multiplier}x multiplier)`,
  );
  console.log("═".repeat(76));
}

main().catch((err) => {
  console.error("Ecosystem benchmark error:", err);
  process.exit(1);
});
