/**
 * Use Case Tests — Real-world scenarios using static fixtures
 *
 * Each use case represents a common task where Claude Code
 * would benefit from context-mode instead of raw Read/cat.
 */

import { strict as assert } from "node:assert";
import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes, getRuntimeSummary } from "../src/runtime.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");

const runtimes = detectRuntimes();
const executor = new PolyglotExecutor({ runtimes });

let passed = 0;
let failed = 0;

async function useCase(
  name: string,
  fixture: string,
  fn: (filePath: string) => Promise<void>,
) {
  const filePath = join(fixtureDir, fixture);
  const rawSize = readFileSync(filePath).byteLength;
  console.log(`\n--- ${name} ---`);
  console.log(`  Fixture: ${fixture} (${(rawSize / 1024).toFixed(1)}KB)`);
  try {
    await fn(filePath);
    passed++;
    console.log(`  Status: PASS`);
  } catch (err: any) {
    failed++;
    console.log(`  Status: FAIL — ${err.message}`);
  }
}

async function main() {
  console.log("Context Mode — Use Case Tests (Fixtures)");
  console.log("=========================================\n");
  console.log("Runtimes:\n" + getRuntimeSummary(runtimes));

  // ===== UC1: Triage failing tests =====
  await useCase(
    "UC1: Triage failing tests from vitest output",
    "test-output.txt",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const lines = FILE_CONTENT.split("\\n");
          const failSuites = lines.filter(l => l.match(/^\\s*\\u2717/) && !l.match(/^\\s{4,}/));
          const failTests = lines.filter(l => l.match(/^\\s{3,}\\u2717/));
          const passTests = lines.filter(l => l.match(/^\\s{3,}\\u2713/));

          console.log("Suites:", failSuites.length, "failed out of", failSuites.length + lines.filter(l => l.match(/^\\s*\\u2713/) && !l.match(/^\\s{4,}/)).length);
          console.log("Tests:", passTests.length, "passed,", failTests.length, "failed");

          if (failTests.length) {
            console.log("\\nFailing tests:");
            let currentFile = "";
            lines.forEach((l, i) => {
              if (l.match(/^\\s*\\u2717/) && !l.match(/^\\s{4,}/)) currentFile = l.trim();
              if (l.match(/^\\s{3,}\\u2717/)) {
                console.log("  " + currentFile);
                console.log("    " + l.trim());
                // Show error details (next few lines)
                for (let j = i+1; j < Math.min(i+4, lines.length); j++) {
                  const next = lines[j].trim();
                  if (next.startsWith("\\u2192") || next.startsWith("expected") || next.startsWith("received")) {
                    console.log("    " + next);
                  }
                }
              }
            });
          }
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("failed"), "Should report failures");
      console.log("  Output: " + r.stdout.trim().split("\n").length + " lines");
    },
  );

  // ===== UC2: Diagnose TypeScript errors =====
  await useCase(
    "UC2: Diagnose TypeScript errors by file and type",
    "tsc-errors.txt",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const lines = FILE_CONTENT.trim().split("\\n").filter(l => l.includes("error TS"));
          const byFile = {};
          const byCode = {};
          lines.forEach(l => {
            const file = l.split("(")[0];
            const code = l.match(/TS\\d+/)?.[0] || "?";
            const msg = l.split(": error ")[1] || l;
            byFile[file] = byFile[file] || [];
            byFile[file].push(code);
            byCode[code] = (byCode[code] || 0) + 1;
          });
          console.log("Total:", lines.length, "errors in", Object.keys(byFile).length, "files\\n");
          console.log("By file:");
          Object.entries(byFile).sort((a,b) => b[1].length - a[1].length).forEach(([f, codes]) => {
            console.log("  " + f + ": " + codes.length + " (" + [...new Set(codes)].join(", ") + ")");
          });
          console.log("\\nMost common:");
          Object.entries(byCode).sort((a,b) => b[1]-a[1]).slice(0,5).forEach(([c,n]) => console.log("  " + c + ": " + n + "x"));
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("errors"), "Should report error count");
    },
  );

  // ===== UC3: Review git diff =====
  await useCase(
    "UC3: Summarize git diff for code review",
    "git-diff.patch",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const content = FILE_CONTENT;
          const files = content.split("diff --git").slice(1);
          let totalAdd = 0, totalDel = 0;

          console.log("Code Review Summary (" + files.length + " files changed):\\n");
          files.forEach(section => {
            const name = section.match(/b\\/(\\S+)/)?.[1] || "unknown";
            const lines = section.split("\\n");
            const added = lines.filter(l => l.startsWith("+") && !l.startsWith("+++"));
            const deleted = lines.filter(l => l.startsWith("-") && !l.startsWith("---"));
            totalAdd += added.length;
            totalDel += deleted.length;

            // Detect change type
            const hasNewFn = added.some(l => l.includes("function ") || l.includes("class ") || l.includes("=> {"));
            const hasRemoved = deleted.length > added.length;
            const type = hasNewFn ? "feature" : hasRemoved ? "cleanup" : "modification";

            console.log("  " + name + " [" + type + "] +" + added.length + " -" + deleted.length);
          });
          console.log("\\nTotal: +" + totalAdd + " -" + totalDel + " (" + (totalAdd + totalDel) + " lines touched)");
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("files changed"), "Should list changed files");
    },
  );

  // ===== UC4: Analyze server access patterns =====
  await useCase(
    "UC4: Analyze access log for performance issues",
    "access.log",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const lines = FILE_CONTENT.trim().split("\\n");
          const stats = { total: lines.length, errors: 0, slow: 0, endpoints: {}, methods: {} };
          let totalMs = 0;

          lines.forEach(l => {
            const status = l.match(/" (\\d+) /)?.[1];
            const method = l.match(/"(\\w+) /)?.[1];
            const path = l.match(/"\\w+ (\\S+)/)?.[1];
            const ms = l.match(/(\\d+)ms$/)?.[1];

            if (status && +status >= 400) stats.errors++;
            if (ms) { totalMs += +ms; if (+ms > 1000) stats.slow++; }
            if (method) stats.methods[method] = (stats.methods[method]||0) + 1;
            if (path) stats.endpoints[path] = (stats.endpoints[path]||0) + 1;
          });

          console.log("Traffic: " + stats.total + " requests");
          console.log("Errors: " + stats.errors + " (" + ((stats.errors/stats.total)*100).toFixed(1) + "%)");
          console.log("Slow (>1s): " + stats.slow);
          console.log("Avg latency: " + Math.round(totalMs/stats.total) + "ms");
          console.log("\\nMethods:", Object.entries(stats.methods).map(([m,c])=>m+":"+c).join(" "));
          console.log("Top endpoints:");
          Object.entries(stats.endpoints).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(([p,c]) => console.log("  " + p + ": " + c));
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("requests"), "Should report request count");
    },
  );

  // ===== UC5: Audit dependencies =====
  await useCase(
    "UC5: Audit package.json for dependency overview",
    "package-large.json",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const pkg = JSON.parse(FILE_CONTENT);
          const deps = Object.entries(pkg.dependencies || {});
          const devDeps = Object.entries(pkg.devDependencies || {});
          console.log(pkg.name + "@" + pkg.version);
          console.log("\\nDependencies (" + deps.length + "):");
          // Group by category
          const ui = deps.filter(([n]) => n.includes("radix") || n.includes("lucide") || n.includes("tailwind") || n.includes("cva") || n.includes("clsx"));
          const data = deps.filter(([n]) => n.includes("prisma") || n.includes("trpc") || n.includes("tanstack"));
          const auth = deps.filter(([n]) => n.includes("auth"));
          const infra = deps.filter(([n]) => n.includes("stripe") || n.includes("resend") || n.includes("upload"));
          console.log("  UI: " + ui.map(([n])=>n).join(", "));
          console.log("  Data: " + data.map(([n])=>n).join(", "));
          console.log("  Auth: " + auth.map(([n])=>n).join(", "));
          console.log("  Services: " + infra.map(([n])=>n).join(", "));
          console.log("\\nDevDependencies (" + devDeps.length + "): " + devDeps.map(([n])=>n).join(", "));
          console.log("\\nScripts: " + Object.keys(pkg.scripts||{}).join(", "));
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("Dependencies"), "Should list deps");
    },
  );

  // ===== UC6: Analyze build errors =====
  await useCase(
    "UC6: Triage build output — find errors and warnings",
    "build-output.txt",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "shell",
        code: `
total=$(echo "$FILE_CONTENT" | wc -l | tr -d ' ')
errors=$(echo "$FILE_CONTENT" | grep -c "ERROR\\|error TS" || true)
warnings=$(echo "$FILE_CONTENT" | grep -ci "warning" || true)
compiled=$(echo "$FILE_CONTENT" | grep -c "Compiled\\|compiled\\|✓" || true)

echo "Build Summary ($total lines):"
echo "  Compiled: $compiled"
echo "  Warnings: $warnings"
echo "  Errors: $errors"

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "Errors:"
  echo "$FILE_CONTENT" | grep "ERROR\\|error TS" | head -5 | while read line; do
    echo "  $line"
  done
fi

if [ "$warnings" -gt 0 ]; then
  echo ""
  echo "Warnings (first 3):"
  echo "$FILE_CONTENT" | grep -i "warning" | head -3 | while read line; do
    echo "  $line"
  done
fi
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("Build Summary"), "Should have summary");
    },
  );

  // ===== UC7: MCP tool discovery =====
  await useCase(
    "UC7: Discover MCP server capabilities",
    "mcp-tools.json",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const tools = JSON.parse(FILE_CONTENT);
          // Group by category (infer from name prefix)
          const groups = {};
          tools.forEach(t => {
            const cat = t.name.split("_")[0] || "other";
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(t);
          });

          console.log("MCP Server: " + tools.length + " tools in " + Object.keys(groups).length + " categories\\n");
          Object.entries(groups).forEach(([cat, tools]) => {
            console.log(cat + " (" + tools.length + "):");
            tools.forEach(t => {
              const params = Object.keys(t.inputSchema?.properties || {});
              console.log("  " + t.name + "(" + params.join(", ") + ")");
            });
          });
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("tools"), "Should list tools");
    },
  );

  // ===== UC8: Understand source code structure =====
  await useCase(
    "UC8: Analyze TypeScript source code architecture",
    "source-example.ts",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const lines = FILE_CONTENT.split("\\n");
          const imports = [...FILE_CONTENT.matchAll(/^import .+ from "([^"]+)"/gm)].map(m => m[1]);
          const interfaces = [...FILE_CONTENT.matchAll(/^(?:export )?interface\\s+(\\w+)/gm)].map(m => m[1]);
          const types = [...FILE_CONTENT.matchAll(/^(?:export )?type\\s+(\\w+)/gm)].map(m => m[1]);
          const classes = [...FILE_CONTENT.matchAll(/^export class\\s+(\\w+)/gm)].map(m => m[1]);
          const funcs = [...FILE_CONTENT.matchAll(/^(?:export )?(?:async )?function\\s+(\\w+)/gm)].map(m => m[1]);
          const schemas = [...FILE_CONTENT.matchAll(/const\\s+(\\w+Schema)/gm)].map(m => m[1]);
          const routes = [...FILE_CONTENT.matchAll(/router\\.(get|post|put|delete|patch)\\("([^"]+)"/g)].map(m => m[1].toUpperCase() + " " + m[2]);

          console.log("File: " + lines.length + " lines");
          console.log("Imports: " + imports.join(", "));
          console.log("Interfaces: " + interfaces.join(", "));
          if (types.length) console.log("Types: " + types.join(", "));
          console.log("Classes: " + classes.join(", "));
          console.log("Functions: " + funcs.join(", "));
          if (schemas.length) console.log("Zod schemas: " + schemas.join(", "));
          if (routes.length) console.log("Routes: " + routes.join(", "));

          // Complexity hint
          const asyncFns = (FILE_CONTENT.match(/async /g) || []).length;
          const tryCatch = (FILE_CONTENT.match(/try \\{/g) || []).length;
          console.log("\\nComplexity: " + asyncFns + " async operations, " + tryCatch + " error handlers");
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("lines"), "Should report line count");
    },
  );

  // ===== UC9: Git history analysis =====
  await useCase(
    "UC9: Analyze git log for team activity",
    "git-log.txt",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const lines = FILE_CONTENT.trim().split("\\n");
          const authors = {};
          const types = {};
          const daily = {};

          lines.forEach(l => {
            const parts = l.split(" ");
            const date = parts[1];
            const author = parts.slice(2, 4).join(" ");
            const type = (parts[4] || "").replace(":", "");

            authors[author] = (authors[author] || 0) + 1;
            types[type] = (types[type] || 0) + 1;
            daily[date] = (daily[date] || 0) + 1;
          });

          const dates = Object.keys(daily).sort();
          console.log("Git History: " + lines.length + " commits");
          console.log("Period: " + dates[0] + " to " + dates[dates.length-1]);
          console.log("\\nContributors:");
          Object.entries(authors).sort((a,b)=>b[1]-a[1]).forEach(([a,c]) => console.log("  " + a + ": " + c + " commits"));
          console.log("\\nCommit types:");
          Object.entries(types).sort((a,b)=>b[1]-a[1]).forEach(([t,c]) => console.log("  " + t + ": " + c));
          console.log("\\nBusiest days:");
          Object.entries(daily).sort((a,b)=>b[1]-a[1]).slice(0,3).forEach(([d,c]) => console.log("  " + d + ": " + c + " commits"));
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("commits"), "Should report commit count");
    },
  );

  // ===== UC10: CSV analytics with Python =====
  if (runtimes.python) {
    await useCase(
      "UC10: Analyze analytics CSV with Python",
      "analytics.csv",
      async (path) => {
        const r = await executor.executeFile({
          path,
          language: "python",
          code: `
import csv, io
from collections import Counter

reader = csv.DictReader(io.StringIO(FILE_CONTENT))
rows = list(reader)

actions = Counter(r["action"] for r in rows)
statuses = Counter(r["status"] for r in rows)
resources = Counter(r["resource"] for r in rows)
unique_users = len(set(r["user_id"] for r in rows))
errors = [r for r in rows if r["status"] in ("error", "timeout")]
durations = [int(r["duration_ms"]) for r in rows]

print(f"Analytics: {len(rows)} events from {unique_users} unique users")
print(f"Avg duration: {sum(durations)/len(durations):.0f}ms (max: {max(durations)}ms)")
print(f"Error rate: {len(errors)}/{len(rows)} ({len(errors)/len(rows)*100:.1f}%)")
print(f"\\nActions: {dict(actions.most_common())}")
print(f"Resources: {dict(resources.most_common())}")
print(f"Statuses: {dict(statuses.most_common())}")

# Find slowest actions
by_action_duration = {}
for r in rows:
    a = r["action"]
    by_action_duration.setdefault(a, []).append(int(r["duration_ms"]))
print(f"\\nSlowest (avg ms):")
for a, ds in sorted(by_action_duration.items(), key=lambda x: -sum(x[1])/len(x[1])):
    print(f"  {a}: {sum(ds)/len(ds):.0f}ms")
          `,
        });
        assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
        assert.ok(r.stdout.includes("events"), "Should report event count");
      },
    );
  }

  // ===== UC11: API response processing =====
  await useCase(
    "UC11: Process API response — filter and aggregate",
    "api-response.json",
    async (path) => {
      const r = await executor.executeFile({
        path,
        language: "javascript",
        code: `
          const users = JSON.parse(FILE_CONTENT);
          const admins = users.filter(u => u.role === "admin");
          const verified = users.filter(u => u.metadata.verified);
          const byTheme = {};
          const byLang = {};
          users.forEach(u => {
            const t = u.metadata.preferences.theme;
            const l = u.metadata.preferences.language;
            byTheme[t] = (byTheme[t]||0) + 1;
            byLang[l] = (byLang[l]||0) + 1;
          });
          const avgLogins = users.reduce((s,u) => s + u.metadata.loginCount, 0) / users.length;

          console.log("API Response: " + users.length + " users");
          console.log("Roles: " + admins.length + " admins, " + (users.length - admins.length) + " users");
          console.log("Verified: " + verified.length + "/" + users.length);
          console.log("Avg login count: " + avgLogins.toFixed(0));
          console.log("Themes: " + Object.entries(byTheme).map(([k,v])=>k+":"+v).join(", "));
          console.log("Languages: " + Object.entries(byLang).map(([k,v])=>k+":"+v).join(", "));
          console.log("\\nMost active:");
          users.sort((a,b) => b.metadata.loginCount - a.metadata.loginCount).slice(0,3)
            .forEach(u => console.log("  " + u.name + ": " + u.metadata.loginCount + " logins"));
        `,
      });
      assert.equal(r.exitCode, 0, "Should exit 0: " + r.stderr);
      assert.ok(r.stdout.includes("users"), "Should report user count");
    },
  );

  // ===== SUMMARY =====
  console.log("\n" + "=".repeat(60));
  console.log(
    `Use Cases: ${passed} passed, ${failed} failed (${passed + failed} total)`,
  );
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Use case error:", err);
  process.exit(1);
});
