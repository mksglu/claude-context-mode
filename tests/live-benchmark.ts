/**
 * Live Benchmark — Context7 + Skills context savings measurement.
 *
 * Measures real-world context savings when using index+search
 * vs loading full content into context.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentStore } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");
const skillDir = join(__dirname, "..", "skills", "context-mode");

interface BenchmarkResult {
  scenario: string;
  source: string;
  rawBytes: number;
  searchQueries: string[];
  searchResultBytes: number;
  chunksCreated: number;
  codeChunks: number;
  savings: number;
  exactCodePreserved: boolean;
}

const results: BenchmarkResult[] = [];

function benchmark(opts: {
  scenario: string;
  source: string;
  content: string;
  queries: string[];
}): BenchmarkResult {
  const store = new ContentStore();
  const rawBytes = Buffer.byteLength(opts.content);

  const indexed = store.index({ content: opts.content, source: opts.source });

  let totalSearchBytes = 0;
  let hasExactCode = true;

  for (const q of opts.queries) {
    const results = store.search(q, 1);
    if (results.length > 0) {
      totalSearchBytes += Buffer.byteLength(
        results[0].title + "\n" + results[0].content,
      );
      if (
        results[0].contentType === "code" &&
        !results[0].content.includes("```")
      ) {
        hasExactCode = false;
      }
    }
  }

  store.close();

  const savings =
    totalSearchBytes > 0
      ? ((1 - totalSearchBytes / rawBytes) * 100)
      : 0;

  return {
    scenario: opts.scenario,
    source: opts.source,
    rawBytes,
    searchQueries: opts.queries,
    searchResultBytes: totalSearchBytes,
    chunksCreated: indexed.totalChunks,
    codeChunks: indexed.codeChunks,
    savings,
    exactCodePreserved: hasExactCode,
  };
}

async function main() {
  console.log("\nContext Mode — Live Benchmark (Index + Search)");
  console.log("===============================================\n");

  // ===== CONTEXT7: Supabase Edge Functions =====
  const supabaseFixture = join(fixtureDir, "context7-supabase-edge.md");
  if (!existsSync(supabaseFixture)) {
    const { writeFileSync: writeSyncFn } = await import("node:fs");
    const content = readFileSync("/tmp/context7-edge-functions.md", "utf-8");
    writeSyncFn(supabaseFixture, content);
  }

  results.push(
    benchmark({
      scenario: "Supabase Edge Functions (5 examples)",
      source: "Context7: Supabase",
      content: readFileSync(supabaseFixture, "utf-8"),
      queries: [
        "CORS handling edge function",
        "database connection Deno Postgres",
        "unit test edge function invoke",
      ],
    }),
  );

  // ===== CONTEXT7: React useEffect =====
  results.push(
    benchmark({
      scenario: "React useEffect docs",
      source: "Context7: React",
      content: readFileSync(
        join(fixtureDir, "context7-react-docs.md"),
        "utf-8",
      ),
      queries: [
        "useEffect cleanup function",
        "fetch data ignore stale",
        "dependency array rules",
      ],
    }),
  );

  // ===== CONTEXT7: Next.js App Router =====
  results.push(
    benchmark({
      scenario: "Next.js App Router docs",
      source: "Context7: Next.js",
      content: readFileSync(
        join(fixtureDir, "context7-nextjs-docs.md"),
        "utf-8",
      ),
      queries: [
        "App Router data fetching",
        "server components",
        "route handlers",
      ],
    }),
  );

  // ===== CONTEXT7: Tailwind CSS =====
  results.push(
    benchmark({
      scenario: "Tailwind CSS docs",
      source: "Context7: Tailwind",
      content: readFileSync(
        join(fixtureDir, "context7-tailwind-docs.md"),
        "utf-8",
      ),
      queries: [
        "responsive breakpoints",
        "custom colors theme",
      ],
    }),
  );

  // ===== SKILLS: context-mode skill =====
  const skillFile = join(skillDir, "SKILL.md");
  if (existsSync(skillFile)) {
    results.push(
      benchmark({
        scenario: "Skill: context-mode (main prompt)",
        source: "Skill: context-mode",
        content: readFileSync(skillFile, "utf-8"),
        queries: [
          "when to use execute vs execute_file",
          "language selection guide",
          "anti-patterns avoid",
        ],
      }),
    );
  }

  // ===== SKILLS: reference docs =====
  const refDir = join(skillDir, "references");
  if (existsSync(refDir)) {
    const refFiles = [
      "patterns-javascript.md",
      "patterns-python.md",
      "patterns-shell.md",
      "anti-patterns.md",
    ];

    let combinedContent = "";
    for (const f of refFiles) {
      const fp = join(refDir, f);
      if (existsSync(fp)) {
        combinedContent += readFileSync(fp, "utf-8") + "\n\n---\n\n";
      }
    }

    if (combinedContent.length > 0) {
      results.push(
        benchmark({
          scenario: "Skill references (4 files combined)",
          source: "Skill Refs: context-mode",
          content: combinedContent,
          queries: [
            "JSON parse transform pattern",
            "CSV analysis Python",
            "file processing shell awk",
          ],
        }),
      );
    }
  }

  // ===== MCP tools/list =====
  results.push(
    benchmark({
      scenario: "MCP tools/list (40 tools)",
      source: "MCP: tools/list",
      content: (() => {
        const raw = readFileSync(
          join(fixtureDir, "mcp-tools.json"),
          "utf-8",
        );
        const tools = JSON.parse(raw);
        return tools
          .map(
            (t: { name: string; description: string }) =>
              `### ${t.name}\n\n${t.description}`,
          )
          .join("\n\n---\n\n");
      })(),
      queries: [
        "browser screenshot tool",
        "file search glob",
        "git commit tool",
      ],
    }),
  );

  // ===== RESULTS =====
  console.log("--- Results ---\n");
  console.log(
    "| Scenario | Source | Raw | Search (3q) | Savings | Chunks | Code |",
  );
  console.log(
    "|----------|--------|-----|-------------|---------|--------|------|",
  );

  let totalRaw = 0;
  let totalSearch = 0;

  for (const r of results) {
    totalRaw += r.rawBytes;
    totalSearch += r.searchResultBytes;
    const rawKB = (r.rawBytes / 1024).toFixed(1);
    const searchB = r.searchResultBytes;
    console.log(
      `| ${r.scenario} | ${r.source} | ${rawKB}KB | ${searchB}B | ${r.savings.toFixed(0)}% | ${r.chunksCreated} | ${r.codeChunks} |`,
    );
  }

  console.log("");
  console.log(`Total raw: ${(totalRaw / 1024).toFixed(1)}KB`);
  console.log(`Total search results: ${(totalSearch / 1024).toFixed(1)}KB`);
  console.log(
    `Overall savings: ${((1 - totalSearch / totalRaw) * 100).toFixed(0)}%`,
  );
  console.log(
    `Multiplier: ${(totalRaw / totalSearch).toFixed(1)}x less context`,
  );

  // Token estimation
  const rawTokens = Math.ceil(totalRaw / 4);
  const searchTokens = Math.ceil(totalSearch / 4);
  console.log(
    `\nEstimated tokens: ${rawTokens.toLocaleString()} → ${searchTokens.toLocaleString()} (saved ${(rawTokens - searchTokens).toLocaleString()})`,
  );

  // Code preservation check
  const allPreserved = results.every((r) => r.exactCodePreserved);
  console.log(`Code examples preserved: ${allPreserved ? "YES" : "PARTIAL"}`);

  // JSON output for markdown generation
  console.log("\n--- JSON ---");
  console.log(JSON.stringify({ results, totalRaw, totalSearch }, null, 2));
}

main().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
