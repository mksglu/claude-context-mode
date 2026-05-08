/**
 * Context Comparison Test
 *
 * Uses static fixtures to show exactly what enters Claude's context window:
 *   WITHOUT context-mode: raw file content (every byte enters context)
 *   WITH context-mode: only the printed summary enters context
 *
 * Fixtures in tests/fixtures/ represent real-world data Claude Code encounters daily.
 */

import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes, getRuntimeSummary } from "../src/runtime.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");

const runtimes = detectRuntimes();
const executor = new PolyglotExecutor({ runtimes });

interface Scenario {
  name: string;
  fixture: string;
  description: string;
  language: "javascript" | "python" | "shell";
  code: string;
}

const scenarios: Scenario[] = [
  {
    name: "API Response (15 users)",
    fixture: "api-response.json",
    description:
      "GET /api/users response — JSON array with nested metadata, preferences",
    language: "javascript",
    code: `
      const users = JSON.parse(FILE_CONTENT);
      const admins = users.filter(u => u.role === "admin");
      const verified = users.filter(u => u.metadata.verified);
      const themes = {};
      users.forEach(u => { themes[u.metadata.preferences.theme] = (themes[u.metadata.preferences.theme] || 0) + 1; });
      console.log("Users:", users.length, "| Admins:", admins.length, "| Verified:", verified.length);
      console.log("Themes:", Object.entries(themes).map(([k,v]) => k + ":" + v).join(", "));
      console.log("Recent:", users.sort((a,b) => new Date(b.lastLogin) - new Date(a.lastLogin)).slice(0,3).map(u => u.name).join(", "));
    `,
  },
  {
    name: "package.json (33 deps)",
    fixture: "package-large.json",
    description:
      "Next.js SaaS app — 23 deps + 10 devDeps with scripts",
    language: "javascript",
    code: `
      const pkg = JSON.parse(FILE_CONTENT);
      const deps = Object.entries(pkg.dependencies || {});
      const devDeps = Object.entries(pkg.devDependencies || {});
      console.log(pkg.name + "@" + pkg.version);
      console.log("Deps:", deps.length, "| DevDeps:", devDeps.length);
      console.log("Scripts:", Object.keys(pkg.scripts || {}).join(", "));
      console.log("Stack: Next.js, tRPC, Prisma, NextAuth, Stripe, Tailwind v4");
      const ui = deps.filter(([n]) => n.includes("radix") || n.includes("lucide"));
      if (ui.length) console.log("UI libs:", ui.map(([n]) => n).join(", "));
    `,
  },
  {
    name: "Test output (30 suites)",
    fixture: "test-output.txt",
    description:
      "vitest run output — 30 test suites with pass/fail details",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const suitePass = lines.filter(l => l.trimStart().startsWith("\\u2713") && !l.startsWith("  ")).length;
      const suiteFail = lines.filter(l => l.trimStart().startsWith("\\u2717") && !l.startsWith("  ")).length;
      const testPass = lines.filter(l => l.match(/^\\s+\\u2713/)).length;
      const testFail = lines.filter(l => l.match(/^\\s+\\u2717/)).length;
      const failDetails = [];
      let currentSuite = "";
      lines.forEach(l => {
        if (l.trimStart().startsWith("\\u2717") && !l.startsWith("  ")) currentSuite = l.trim();
        if (l.match(/^\\s+\\u2717/)) failDetails.push(currentSuite + " > " + l.trim());
        if (l.includes("\\u2192") || l.includes("expected:") || l.includes("received:")) failDetails.push("    " + l.trim());
      });
      console.log("Suites:", suitePass, "passed,", suiteFail, "failed");
      console.log("Tests:", testPass, "passed,", testFail, "failed");
      if (failDetails.length) {
        console.log("\\nFailures:");
        failDetails.slice(0, 10).forEach(l => console.log("  " + l));
      }
    `,
  },
  {
    name: "TypeScript errors (50)",
    fixture: "tsc-errors.txt",
    description:
      "tsc --noEmit output — 50 type errors across 8 source files",
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
      console.log("Errors:", lines.length, "in", Object.keys(byFile).length, "files");
      console.log("\\nBy file:");
      Object.entries(byFile).sort((a,b) => b[1]-a[1]).forEach(([f,c]) => console.log("  " + f + ":", c));
      console.log("\\nTop error codes:");
      Object.entries(byCode).sort((a,b) => b[1]-a[1]).slice(0,5).forEach(([c,n]) => console.log("  " + c + ":", n));
    `,
  },
  {
    name: "git diff (6 files)",
    fixture: "git-diff.patch",
    description:
      "git diff HEAD~1 — 6 files changed with additions/deletions",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const files = lines.filter(l => l.startsWith("diff --git")).map(l => l.split(" b/")[1]);
      const added = lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
      const removed = lines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;
      console.log("Changed:", files.length, "files | +" + added, "-" + removed);
      files.forEach(f => {
        const section = FILE_CONTENT.split("diff --git").find(s => s.includes("b/" + f)) || "";
        const a = section.split("\\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
        const r = section.split("\\n").filter(l => l.startsWith("-") && !l.startsWith("---")).length;
        console.log("  " + f + " (+" + a + " -" + r + ")");
      });
    `,
  },
  {
    name: "Access log (500 requests)",
    fixture: "access.log",
    description:
      "nginx access log — 500 HTTP requests with IPs, status codes, durations",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.trim().split("\\n");
      const statuses = {};
      let errors = 0, totalMs = 0, count = 0;
      lines.forEach(l => {
        const s = l.match(/" (\\d+) /)?.[1]; if (s) { statuses[s] = (statuses[s]||0)+1; if (+s >= 400) errors++; }
        const ms = l.match(/(\\d+)ms$/)?.[1]; if (ms) { totalMs += +ms; count++; }
      });
      console.log("Requests:", lines.length, "| Errors:", errors, "(" + ((errors/lines.length)*100).toFixed(1) + "%)");
      console.log("Avg latency:", Math.round(totalMs/count) + "ms");
      console.log("Status:", Object.entries(statuses).sort((a,b)=>b[1]-a[1]).map(([s,c])=>s+":"+c).join(", "));
    `,
  },
  {
    name: "Build output (100+ lines)",
    fixture: "build-output.txt",
    description:
      "next build output — compiled files, warnings, errors, route manifest",
    language: "shell",
    code: `
errors=$(echo "$FILE_CONTENT" | grep -c "^ERROR\\|error TS" || true)
warnings=$(echo "$FILE_CONTENT" | grep -c "Warning\\|warning" || true)
compiled=$(echo "$FILE_CONTENT" | grep -c "Compiled\\|compiled" || true)
echo "Build: $compiled compiled, $warnings warnings, $errors errors"
if [ "$errors" -gt 0 ]; then
  echo "Errors:"
  echo "$FILE_CONTENT" | grep "ERROR\\|error TS" | head -5
fi
    `,
  },
  {
    name: "Source code (200 lines TS)",
    fixture: "source-example.ts",
    description:
      "Express + Prisma + Zod service — interfaces, schemas, class, routes",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.split("\\n");
      const imports = [...FILE_CONTENT.matchAll(/^import .+ from "([^"]+)"/gm)].map(m => m[1]);
      const interfaces = [...FILE_CONTENT.matchAll(/^(?:export )?interface\\s+(\\w+)/gm)].map(m => m[1]);
      const classes = [...FILE_CONTENT.matchAll(/^export class\\s+(\\w+)/gm)].map(m => m[1]);
      const funcs = [...FILE_CONTENT.matchAll(/^(?:export )?(?:async )?function\\s+(\\w+)/gm)].map(m => m[1]);
      const schemas = [...FILE_CONTENT.matchAll(/^(?:export )?const\\s+(\\w+Schema)/gm)].map(m => m[1]);
      const routes = [...FILE_CONTENT.matchAll(/router\\.(get|post|put|delete|patch)\\("([^"]+)"/g)].map(m => m[1].toUpperCase() + " " + m[2]);
      console.log("Lines:", lines.length, "| Imports:", imports.length);
      console.log("From:", imports.join(", "));
      console.log("Interfaces:", interfaces.join(", ") || "none");
      console.log("Classes:", classes.join(", ") || "none");
      console.log("Functions:", funcs.join(", ") || "none");
      console.log("Schemas:", schemas.join(", ") || "none");
      console.log("Routes:", routes.join(", ") || "none");
    `,
  },
  {
    name: "MCP tools (40 tools)",
    fixture: "mcp-tools.json",
    description:
      "MCP server tools/list response — 40 tools with JSON Schema inputs",
    language: "javascript",
    code: `
      const tools = JSON.parse(FILE_CONTENT);
      console.log("MCP Server:", tools.length, "tools");
      tools.forEach(t => {
        const props = Object.keys(t.inputSchema?.properties || {});
        const req = t.inputSchema?.required || [];
        const sig = props.map(p => req.includes(p) ? p : p + "?").join(", ");
        console.log("  " + t.name + "(" + sig + ")");
      });
    `,
  },
  {
    name: "Git log (150+ commits)",
    fixture: "git-log.txt",
    description:
      "git log --oneline — 150+ commits with authors and conventional commits",
    language: "javascript",
    code: `
      const lines = FILE_CONTENT.trim().split("\\n");
      const byAuthor = {};
      const byType = {};
      lines.forEach(l => {
        const parts = l.split(" ");
        const author = parts[2] + " " + parts[3];
        byAuthor[author] = (byAuthor[author] || 0) + 1;
        const type = parts[4]?.replace(":", "") || "other";
        byType[type] = (byType[type] || 0) + 1;
      });
      console.log("Commits:", lines.length, "| Period:", lines[lines.length-1].split(" ")[1], "to", lines[0].split(" ")[1]);
      console.log("\\nBy author:");
      Object.entries(byAuthor).sort((a,b)=>b[1]-a[1]).forEach(([a,c]) => console.log("  " + a + ":", c));
      console.log("\\nBy type:");
      Object.entries(byType).sort((a,b)=>b[1]-a[1]).forEach(([t,c]) => console.log("  " + t + ":", c));
    `,
  },
];

// Add Python scenario if available
if (runtimes.python) {
  scenarios.push({
    name: "Analytics CSV (500 rows)",
    fixture: "analytics.csv",
    description:
      "Event analytics — 500 events with user_id, action, resource, status",
    language: "python",
    code: `
import csv, io
from collections import Counter

reader = csv.DictReader(io.StringIO(FILE_CONTENT))
rows = list(reader)

actions = Counter(r["action"] for r in rows)
statuses = Counter(r["status"] for r in rows)
unique_users = len(set(r["user_id"] for r in rows))
errors = [r for r in rows if r["status"] in ("error", "timeout")]
avg_ms = sum(int(r["duration_ms"]) for r in rows) / len(rows)

print(f"Events: {len(rows)} | Users: {unique_users} | Avg latency: {avg_ms:.0f}ms")
print(f"Error rate: {len(errors)}/{len(rows)} ({len(errors)/len(rows)*100:.1f}%)")
print(f"Actions: {dict(actions.most_common())}")
print(f"Statuses: {dict(statuses.most_common())}")
    `,
  });
}

// ===== RUN COMPARISON =====
async function main() {
  console.log("");
  console.log(
    "\u2554" +
      "\u2550".repeat(66) +
      "\u2557",
  );
  console.log(
    "\u2551" +
      "     Context Mode — Before vs After Comparison (Fixtures)      " +
      "\u2551",
  );
  console.log(
    "\u255A" +
      "\u2550".repeat(66) +
      "\u255D",
  );
  console.log("");
  console.log("Runtimes:\n" + getRuntimeSummary(runtimes));
  console.log("\nFixtures: tests/fixtures/");
  console.log("");

  let totalRawBytes = 0;
  let totalContextBytes = 0;

  const rows: {
    name: string;
    rawBytes: number;
    contextBytes: number;
    savings: string;
  }[] = [];

  for (const scenario of scenarios) {
    const filePath = join(fixtureDir, scenario.fixture);

    let rawContent: string;
    try {
      rawContent = readFileSync(filePath, "utf-8");
    } catch {
      console.log(`  SKIP: ${scenario.fixture} not found`);
      continue;
    }

    const rawBytes = Buffer.byteLength(rawContent, "utf-8");

    const result = await executor.executeFile({
      path: filePath,
      language: scenario.language,
      code: scenario.code,
    });

    if (result.exitCode !== 0) {
      console.log(
        `  ERROR in ${scenario.name}: ${result.stderr.slice(0, 200)}`,
      );
      continue;
    }

    const contextBytes = Buffer.byteLength(result.stdout, "utf-8");
    const savings = ((1 - contextBytes / rawBytes) * 100).toFixed(0);

    totalRawBytes += rawBytes;
    totalContextBytes += contextBytes;

    rows.push({ name: scenario.name, rawBytes, contextBytes, savings: savings + "%" });

    // Show comparison
    console.log(`\u250C\u2500\u2500\u2500 ${scenario.name}`);
    console.log(`\u2502 ${scenario.description}`);
    console.log(`\u2502`);
    console.log(
      `\u2502 WITHOUT context-mode (raw Read/cat):`,
    );
    console.log(
      `\u2502   ${(rawBytes / 1024).toFixed(1)}KB enters Claude's context (${Math.ceil(rawContent.length / 4).toLocaleString()} tokens est.)`,
    );
    console.log(`\u2502`);
    console.log(
      `\u2502 WITH context-mode (execute_file):`,
    );
    console.log(
      `\u2502   ${contextBytes}B enters Claude's context (${Math.ceil(result.stdout.length / 4)} tokens est.)`,
    );
    console.log(`\u2502`);
    console.log(
      `\u2502 \u2192 Savings: ${savings}%`,
    );
    console.log(`\u2502`);
    console.log(
      `\u2502 What Claude actually sees:`,
    );
    result.stdout
      .trim()
      .split("\n")
      .forEach((line) => console.log(`\u2502   ${line}`));
    console.log(`\u2514${"─".repeat(66)}`);
    console.log("");
  }

  // ===== SUMMARY TABLE =====
  console.log(
    "\u2554" +
      "\u2550".repeat(66) +
      "\u2557",
  );
  console.log(
    "\u2551" +
      "                       Summary Table                           " +
      "\u2551",
  );
  console.log(
    "\u255A" +
      "\u2550".repeat(66) +
      "\u255D",
  );
  console.log("");
  console.log(
    "| Scenario                     | Without (raw)  | With (ctx-mode) | Savings |",
  );
  console.log(
    "|------------------------------|----------------|-----------------|---------|",
  );
  for (const r of rows) {
    const rawStr = `${(r.rawBytes / 1024).toFixed(1)}KB`;
    const ctxStr = `${r.contextBytes}B`;
    console.log(
      `| ${r.name.padEnd(28)} | ${rawStr.padStart(14)} | ${ctxStr.padStart(15)} | ${r.savings.padStart(7)} |`,
    );
  }
  console.log(
    "|------------------------------|----------------|-----------------|---------|",
  );
  const totalSavings = (
    (1 - totalContextBytes / totalRawBytes) *
    100
  ).toFixed(0);
  console.log(
    `| ${"TOTAL".padEnd(28)} | ${((totalRawBytes / 1024).toFixed(1) + "KB").padStart(14)} | ${(totalContextBytes + "B").padStart(15)} | ${(totalSavings + "%").padStart(7)} |`,
  );
  console.log("");

  // ===== TOKEN IMPACT =====
  const totalRawTokens = Math.ceil(totalRawBytes / 4);
  const totalCtxTokens = Math.ceil(totalContextBytes / 4);

  console.log(
    "\u2554" +
      "\u2550".repeat(66) +
      "\u2557",
  );
  console.log(
    "\u2551" +
      "                  Context Window Impact                        " +
      "\u2551",
  );
  console.log(
    "\u255A" +
      "\u2550".repeat(66) +
      "\u255D",
  );
  console.log("");
  console.log(
    `  Claude's context window:  200,000 tokens`,
  );
  console.log("");
  console.log(
    `  WITHOUT context-mode:`,
  );
  console.log(
    `    ${totalRawTokens.toLocaleString()} tokens consumed → ${((totalRawTokens / 200_000) * 100).toFixed(1)}% of context used just reading files`,
  );
  console.log("");
  console.log(
    `  WITH context-mode:`,
  );
  console.log(
    `    ${totalCtxTokens.toLocaleString()} tokens consumed → ${((totalCtxTokens / 200_000) * 100).toFixed(2)}% of context`,
  );
  console.log("");
  console.log(
    `  Tokens saved: ${(totalRawTokens - totalCtxTokens).toLocaleString()}`,
  );
  console.log(
    `  Multiplier:   ${Math.floor(totalRawTokens / totalCtxTokens)}x more files per session`,
  );
  console.log("");

  // ===== REAL SESSION EXAMPLE =====
  console.log(
    "\u2554" +
      "\u2550".repeat(66) +
      "\u2557",
  );
  console.log(
    "\u2551" +
      "              Real Debugging Session Example                   " +
      "\u2551",
  );
  console.log(
    "\u255A" +
      "\u2550".repeat(66) +
      "\u255D",
  );
  console.log("");
  console.log("  Developer: 'Fix the failing tests and type errors'");
  console.log("");
  console.log("  Claude needs to:");
  console.log(
    "    1. Read test output (30 suites)    ",
  );
  console.log(
    "    2. Read tsc errors (50 errors)     ",
  );
  console.log(
    "    3. Read the source file            ",
  );
  console.log(
    "    4. Read git diff (recent changes)  ",
  );
  console.log(
    "    5. Read package.json (deps)        ",
  );
  console.log("");

  // Calculate actual savings for this scenario
  const debugFixtures = ["test-output.txt", "tsc-errors.txt", "source-example.ts", "git-diff.patch", "package-large.json"];
  let debugRaw = 0;
  let debugCtx = 0;
  for (const f of debugFixtures) {
    const row = rows.find(r => scenarios.find(s => s.fixture === f)?.name === r.name);
    if (row) {
      debugRaw += row.rawBytes;
      debugCtx += row.contextBytes;
    }
  }

  console.log(
    `  WITHOUT context-mode: ${(debugRaw / 1024).toFixed(1)}KB → ${Math.ceil(debugRaw / 4).toLocaleString()} tokens (${((debugRaw / 4 / 200_000) * 100).toFixed(1)}% of context GONE)`,
  );
  console.log(
    `  WITH context-mode:    ${(debugCtx / 1024).toFixed(1)}KB → ${Math.ceil(debugCtx / 4).toLocaleString()} tokens (${((debugCtx / 4 / 200_000) * 100).toFixed(2)}% of context)`,
  );
  console.log(
    `  Result: ${((1 - debugCtx / debugRaw) * 100).toFixed(0)}% more context available for actual problem solving.`,
  );
  console.log("");
}

main().catch((err) => {
  console.error("Comparison test error:", err);
  process.exit(1);
});
