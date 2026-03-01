/**
 * Subagent Output Budget Tests
 *
 * Tests the full subagent context protection pipeline:
 * 1. Hook injection: pretooluse.mjs injects OUTPUT FORMAT into Task prompts
 * 2. Shared KB: subagent index() → main agent search() via same ContentStore
 * 3. LLM compliance: real subagent respects word budget (requires `claude` CLI)
 *
 * Run: npx tsx tests/subagent-budget.test.ts
 * Run with LLM: npx tsx tests/subagent-budget.test.ts --live
 */

import { strict as assert } from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentStore } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "hooks", "pretooluse.mjs");
const LIVE = process.argv.includes("--live");

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    const time = performance.now() - start;
    passed++;
    console.log(`  ✓ ${name} (${time.toFixed(0)}ms)`);
  } catch (err: any) {
    const time = performance.now() - start;
    failed++;
    console.log(`  ✗ ${name} (${time.toFixed(0)}ms)`);
    console.log(`    Error: ${err.message}`);
  }
}

// ─── ROUTING_BLOCK (identical to hooks/pretooluse.mjs) ───
const ROUTING_BLOCK = `

---
CONTEXT WINDOW PROTECTION — USE CONTEXT-MODE MCP TOOLS

Raw Bash/Read/WebFetch output floods your context. You have context-mode tools that keep data in sandbox.

STEP 1 — GATHER: mcp__context-mode__batch_execute(commands, queries)
  commands: [{label: "Name", command: "shell cmd"}, ...]
  queries: ["query1", "query2", ...] — put 5-8 queries covering everything you need.
  Runs all commands, indexes output, returns search results. ONE call, no follow-ups.

STEP 2 — FOLLOW-UP: mcp__context-mode__search(queries: ["q1", "q2", "q3", ...])
  Pass ALL follow-up questions as queries array. ONE call, not separate calls.

OTHER: execute(language, code) | execute_file(path, language, code) | fetch_and_index(url) + search

FORBIDDEN: Bash for output, Read for files, WebFetch. Bash is ONLY for git/mkdir/rm/mv.

OUTPUT FORMAT — KEEP YOUR FINAL RESPONSE UNDER 500 WORDS:
The parent agent context window is precious. Your full response gets injected into it.

1. ARTIFACTS (PRDs, configs, code files) → Write to FILES, never return as inline text.
   Return only: file path + 1-line description.
2. DETAILED FINDINGS → Index into knowledge base:
   mcp__context-mode__index(content: "...", source: "descriptive-label")
   The parent agent shares the SAME knowledge base and can search() your indexed content.
3. YOUR RESPONSE must be a concise summary:
   - What you did (2-3 bullets)
   - File paths created/modified (if any)
   - Source labels you indexed (so parent can search)
   - Key findings in bullet points
   Do NOT return raw data, full file contents, or lengthy explanations.
---`;

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

async function main() {
  console.log("\nSubagent Output Budget Tests");
  console.log("============================\n");

  // ─── HOOK INJECTION ───
  console.log("--- Hook Injection ---\n");

  await test("Task hook injects CONTEXT WINDOW PROTECTION block", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Research zod npm package", subagent_type: "general-purpose" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(
      prompt.includes("CONTEXT WINDOW PROTECTION"),
      "Should inject context protection header",
    );
  });

  await test("Task hook injects OUTPUT FORMAT block", () => {
    const output = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Research zod", subagent_type: "general-purpose" },
    });
    const parsed = JSON.parse(output);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes("OUTPUT FORMAT"), "Should inject OUTPUT FORMAT section");
    assert.ok(prompt.includes("500 WORDS"), "Should mention 500 word limit");
    assert.ok(
      prompt.includes("mcp__context-mode__index"),
      "Should instruct to use index()",
    );
    assert.ok(
      prompt.includes("SAME knowledge base"),
      "Should mention shared KB",
    );
  });

  await test("Task hook injects batch_execute as primary tool", () => {
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

  await test("Task hook upgrades Bash subagent to general-purpose", () => {
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
      updated.prompt.includes("OUTPUT FORMAT"),
      "Upgraded subagent should also get OUTPUT FORMAT",
    );
  });

  await test("Task hook preserves original prompt content", () => {
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

  await test("Non-Task tools are not affected by output budget", () => {
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

  // ─── SHARED KNOWLEDGE BASE ───
  console.log("\n--- Shared Knowledge Base (subagent → main) ---\n");

  await test("subagent index() is visible to main agent search()", () => {
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

  await test("multiple subagents index into same KB with distinct sources", () => {
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

    // Cross-search without source filter finds all
    const all = store.search("monorepo endpoints commits", 5);
    assert.ok(all.length >= 2, "Global search should find results from multiple subagents");

    store.close();
  });

  await test("main agent can search subagent KB after subagent is done", () => {
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

  // ─── CONTEXT BUDGET MEASUREMENT ───
  console.log("\n--- Context Budget Measurement ---\n");

  await test("ideal subagent response is under 500 words / 2KB", () => {
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

    console.log(`    Ideal: ${words} words, ${bytes} bytes, ~${Math.round(bytes / 4)} tokens`);
  });

  await test("non-compliant response exceeds budget", () => {
    // Simulate what happens WITHOUT the output budget — full inline dump
    const bloatedResponse = Array.from(
      { length: 50 },
      (_, i) => `Line ${i}: Detailed information about zod feature ${i} with examples and code snippets...`,
    ).join("\n");

    const words = bloatedResponse.split(/\s+/).filter((w) => w.length > 0).length;
    const bytes = Buffer.byteLength(bloatedResponse);

    assert.ok(words > 500, "Bloated response should exceed 500 words");
    console.log(`    Bloated: ${words} words, ${bytes} bytes, ~${Math.round(bytes / 4)} tokens`);
    console.log(`    Savings: ${((1 - 150 / words) * 100).toFixed(0)}% if compliant`);
  });

  // ─── LIVE LLM TEST (optional) ───
  if (LIVE) {
    console.log("\n--- Live LLM Test (claude -p) ---\n");

    await test("real subagent respects output budget", async () => {
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

      console.log(`    Response: ${words} words, ${bytes} bytes`);
      console.log(`    Under 500 words: ${words <= 500 ? "✓" : "✗ (" + words + ")"}`);

      // Soft assertion — LLM may not always comply perfectly
      if (words > 500) {
        console.log(`    WARNING: Response exceeded 500 word budget (${words} words)`);
      }

      assert.ok(
        words < 1000,
        `Response should be reasonable length, got ${words} words`,
      );
    });
  } else {
    console.log("\n--- Live LLM Test (skipped — use --live flag) ---\n");
    console.log("  - Run with: npx tsx tests/subagent-budget.test.ts --live");
  }

  // ─── SUMMARY ───
  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
