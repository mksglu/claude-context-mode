/**
 * Hook Integration Tests -- pretooluse.mjs
 *
 * Directly invokes the pretooluse.mjs hook script by piping simulated
 * JSON stdin (the same JSON that Claude Code sends) and asserts correct output.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "hooks", "pretooluse.mjs");

let passed = 0;
let failed = 0;
const results: {
  name: string;
  status: "PASS" | "FAIL";
  time: number;
  error?: string;
}[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    const time = performance.now() - start;
    passed++;
    results.push({ name, status: "PASS", time });
    console.log(`  ✓ ${name} (${time.toFixed(0)} ms)`);
  } catch (err: any) {
    const time = performance.now() - start;
    failed++;
    results.push({ name, status: "FAIL", time, error: err.message });
    console.log(`  ✗ ${name} (${time.toFixed(0)} ms)`);
    console.log(`    Error: ${err.message}`);
  }
}

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHook(input: Record<string, unknown>, env?: Record<string, string>): HookResult {
  const result = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 5000,
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/** Assert hook redirects Bash command to an echo message via updatedInput */
function assertRedirect(result: HookResult, substringInEcho: string) {
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
  assert.ok(result.stdout.length > 0, "Expected non-empty stdout for redirect");
  const parsed = JSON.parse(result.stdout);
  const hso = parsed.hookSpecificOutput;
  assert.ok(hso, "Expected hookSpecificOutput in response");
  assert.ok(hso.updatedInput, "Expected updatedInput in hookSpecificOutput");
  assert.ok(
    hso.updatedInput.command.includes("echo"),
    `Expected updatedInput.command to be an echo, got: ${hso.updatedInput.command}`,
  );
  assert.ok(
    hso.updatedInput.command.includes(substringInEcho),
    `Expected echo to contain "${substringInEcho}", got: ${hso.updatedInput.command}`,
  );
}

/** Assert hook denies with permissionDecision: deny */
function assertDeny(result: HookResult, substringInReason: string) {
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
  assert.ok(result.stdout.length > 0, "Expected non-empty stdout for deny");
  const parsed = JSON.parse(result.stdout);
  const hso = parsed.hookSpecificOutput;
  assert.ok(hso, "Expected hookSpecificOutput in response");
  assert.equal(hso.permissionDecision, "deny", `Expected permissionDecision=deny`);
  assert.ok(
    hso.reason.includes(substringInReason),
    `Expected reason to contain "${substringInReason}", got: ${hso.reason}`,
  );
}

function assertPassthrough(result: HookResult) {
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
  assert.equal(result.stdout, "", `Expected empty stdout for passthrough, got: "${result.stdout}"`);
}

function assertHookSpecificOutput(result: HookResult, key: string) {
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
  assert.ok(result.stdout.length > 0, "Expected non-empty stdout for hookSpecificOutput");
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.hookSpecificOutput, "Expected hookSpecificOutput in response");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.ok(
    parsed.hookSpecificOutput[key] !== undefined,
    `Expected hookSpecificOutput.${key} to be defined`,
  );
}

async function main() {
  console.log("\nContext Mode — Hook Integration Tests (pretooluse.mjs)");
  console.log("======================================================\n");

  // ===== BASH: REDIRECTED COMMANDS =====
  console.log("--- Bash: Redirected Commands ---\n");

  await test("Bash + curl: redirected to echo via updatedInput", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "curl -s http://example.com" },
    });
    assertRedirect(result, "context-mode");
  });

  await test("Bash + wget: redirected to echo via updatedInput", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "wget http://example.com/file.tar.gz" },
    });
    assertRedirect(result, "context-mode");
  });

  await test("Bash + node -e with inline HTTP call: redirected to echo", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: `node -e "fetch('http://api.example.com/data')"` },
    });
    assertRedirect(result, "context-mode");
  });

  // ===== BASH: ALLOWED COMMANDS =====
  console.log("\n--- Bash: Allowed Commands ---\n");

  await test("Bash + git status: passthrough", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    assertPassthrough(result);
  });

  await test("Bash + mkdir /tmp/test: passthrough", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "mkdir /tmp/test" },
    });
    assertPassthrough(result);
  });

  // ===== WEBFETCH =====
  console.log("\n--- WebFetch ---\n");

  await test("WebFetch + any URL: denied with sandbox redirect", () => {
    const result = runHook({
      tool_name: "WebFetch",
      tool_input: { url: "https://docs.example.com/api" },
    });
    assertDeny(result, "fetch_and_index");
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.hookSpecificOutput.reason.includes("https://docs.example.com/api"),
      "Expected original URL in reason",
    );
    assert.ok(
      parsed.hookSpecificOutput.reason.includes("Do NOT use curl"),
      "Expected curl warning in reason",
    );
  });

  // ===== TASK =====
  console.log("\n--- Task ---\n");

  await test("Task + prompt: hookSpecificOutput with updatedInput containing routing block", () => {
    const result = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Analyze this codebase and summarize the architecture." },
    });
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
    assert.ok(result.stdout.length > 0, "Expected non-empty stdout");
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput, "Expected hookSpecificOutput");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.ok(parsed.hookSpecificOutput.updatedInput, "Expected updatedInput");
    assert.ok(
      parsed.hookSpecificOutput.updatedInput.prompt.includes("<context_window_protection>"),
      "Expected <context_window_protection> XML tag in updatedInput.prompt",
    );
    assert.ok(
      parsed.hookSpecificOutput.updatedInput.prompt.includes("</context_window_protection>"),
      "Expected </context_window_protection> closing tag in updatedInput.prompt",
    );
    assert.ok(
      parsed.hookSpecificOutput.updatedInput.prompt.includes("<tool_selection_hierarchy>"),
      "Expected <tool_selection_hierarchy> tag in updatedInput.prompt",
    );
    assert.ok(
      parsed.hookSpecificOutput.updatedInput.prompt.includes("<forbidden_actions>"),
      "Expected <forbidden_actions> tag in updatedInput.prompt",
    );
    assert.ok(
      parsed.hookSpecificOutput.updatedInput.prompt.includes(
        "Analyze this codebase and summarize the architecture.",
      ),
      "Expected original prompt preserved in updatedInput.prompt",
    );
  });

  await test("Task + Bash subagent: upgraded to general-purpose for MCP access", () => {
    const result = runHook({
      tool_name: "Task",
      tool_input: {
        prompt: "Research this GitHub repository.",
        subagent_type: "Bash",
        description: "Research repo",
      },
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const updated = parsed.hookSpecificOutput.updatedInput;
    assert.equal(
      updated.subagent_type,
      "general-purpose",
      `Expected subagent_type upgraded to general-purpose, got: ${updated.subagent_type}`,
    );
    assert.ok(
      updated.prompt.includes("<context_window_protection>"),
      "Expected XML routing block in prompt",
    );
    assert.ok(
      updated.prompt.includes("Research this GitHub repository."),
      "Expected original prompt preserved",
    );
    assert.equal(
      updated.description,
      "Research repo",
      "Expected other fields preserved",
    );
  });

  await test("Task + Explore subagent: keeps original subagent_type", () => {
    const result = runHook({
      tool_name: "Task",
      tool_input: {
        prompt: "Find all TypeScript files.",
        subagent_type: "Explore",
      },
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const updated = parsed.hookSpecificOutput.updatedInput;
    assert.ok(
      updated.subagent_type === undefined || updated.subagent_type === "Explore",
      `Expected subagent_type to remain Explore or undefined, got: ${updated.subagent_type}`,
    );
  });

  // ===== READ =====
  console.log("\n--- Read ---\n");

  await test("Read + file_path: hookSpecificOutput with additionalContext nudge", () => {
    const result = runHook({
      tool_name: "Read",
      tool_input: { file_path: "/some/path/to/file.ts" },
    });
    assertHookSpecificOutput(result, "additionalContext");
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("context-mode"),
      "Expected nudge to mention context-mode",
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> XML wrapper in Read nudge",
    );
  });

  // ===== GREP =====
  console.log("\n--- Grep ---\n");

  await test("Grep + pattern: hookSpecificOutput with additionalContext nudge", () => {
    const result = runHook({
      tool_name: "Grep",
      tool_input: { pattern: "TODO", path: "/src" },
    });
    assertHookSpecificOutput(result, "additionalContext");
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("context-mode"),
      "Expected nudge to mention context-mode",
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> XML wrapper in Grep nudge",
    );
  });

  // ===== PASSTHROUGH TOOLS =====
  console.log("\n--- Passthrough Tools ---\n");

  await test("Glob + pattern: passthrough", () => {
    const result = runHook({
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
    });
    assertPassthrough(result);
  });

  await test("WebSearch: passthrough", () => {
    const result = runHook({
      tool_name: "WebSearch",
      tool_input: { query: "typescript best practices" },
    });
    assertPassthrough(result);
  });

  await test("Unknown tool (Edit): passthrough", () => {
    const result = runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
    });
    assertPassthrough(result);
  });

  // ===== SECURITY POLICY ENFORCEMENT =====
  console.log("\n--- Security Policy Enforcement ---\n");

  // Set up isolated temp dirs for security tests
  const ISOLATED_HOME = join(tmpdir(), `hook-sec-home-${Date.now()}`);
  const MOCK_PROJECT_DIR = join(tmpdir(), `hook-sec-project-${Date.now()}`);
  const mockClaudeDir = join(MOCK_PROJECT_DIR, ".claude");
  mkdirSync(join(ISOLATED_HOME, ".claude"), { recursive: true });
  mkdirSync(mockClaudeDir, { recursive: true });

  // Write deny/allow patterns to project settings
  writeFileSync(
    join(mockClaudeDir, "settings.json"),
    JSON.stringify({
      permissions: {
        deny: ["Bash(sudo *)", "Bash(rm -rf /*)", "Read(.env)", "Read(**/.env*)"],
        allow: ["Bash(git:*)", "Bash(ls:*)"],
      },
    }),
  );

  const secEnv = { HOME: ISOLATED_HOME, CLAUDE_PROJECT_DIR: MOCK_PROJECT_DIR };

  await test("Security: Bash + sudo denied by deny pattern", () => {
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "sudo apt install vim" } },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(parsed.hookSpecificOutput.reason.includes("deny pattern"));
  });

  await test("Security: Bash + git allowed, falls through to Stage 2", () => {
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "git status" } },
      secEnv,
    );
    // git is in allow list → falls through to Stage 2 routing
    // Stage 2: git is not curl/wget/fetch → passthrough (exit 0, empty stdout)
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "", "Allowed command should passthrough to Stage 2");
  });

  await test("Security: MCP execute + shell + sudo denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__execute",
        tool_input: { language: "shell", code: "sudo rm -rf /" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  });

  await test("Security: MCP execute + python (non-shell) passthrough", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__execute",
        tool_input: { language: "python", code: "print('hello')" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "", "Non-shell language should passthrough");
  });

  await test("Security: MCP execute_file + .env path denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__execute_file",
        tool_input: { path: ".env", language: "shell", code: "cat" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(parsed.hookSpecificOutput.reason.includes("Read deny pattern"));
  });

  await test("Security: MCP execute_file + safe path passthrough", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__execute_file",
        tool_input: { path: "src/app.ts", language: "javascript", code: "console.log('ok')" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "", "Safe path should passthrough");
  });

  await test("Security: MCP execute_file + safe path but sudo in shell code denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__execute_file",
        tool_input: { path: "src/app.sh", language: "shell", code: "sudo rm -rf /" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  });

  await test("Security: MCP batch_execute with sudo in one command denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__batch_execute",
        tool_input: {
          commands: [
            { label: "list", command: "ls -la" },
            { label: "evil", command: "sudo rm -rf /" },
          ],
        },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  });

  await test("Security: MCP batch_execute with all allowed commands passthrough", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__batch_execute",
        tool_input: {
          commands: [
            { label: "list", command: "ls -la" },
            { label: "git", command: "git log --oneline -5" },
          ],
        },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "", "All allowed commands should passthrough");
  });

  // Clean up temp dirs
  try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch {}
  try { rmSync(MOCK_PROJECT_DIR, { recursive: true, force: true }); } catch {}


  // ===== PLUGIN TOOL NAME FORMAT =====
  // When installed via Claude Code plugin marketplace, tool names follow:
  //   mcp__plugin_<plugin-id>_<server-name>__<tool-name>
  // For context-mode: mcp__plugin_context-mode_context-mode__<tool-name>
  // The short form mcp__context-mode__* only works for direct MCP registration.
  console.log("\n--- Plugin Tool Name Format in ROUTING_BLOCK ---\n");

  const PLUGIN_PREFIX = "mcp__plugin_context-mode_context-mode__";
  const SHORT_PREFIX = "mcp__context-mode__";

  await test("Task routing block uses plugin-format tool names", () => {
    const result = runHook({ tool_name: "Task", tool_input: { prompt: "Do something." } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes(PLUGIN_PREFIX + "batch_execute"), "Expected plugin-format batch_execute");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "search"), "Expected plugin-format search");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "execute"), "Expected plugin-format execute");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "fetch_and_index"), "Expected plugin-format fetch_and_index");
    assert.ok(!prompt.includes(SHORT_PREFIX + "batch_execute"), "Must not contain short-form batch_execute");
  });

  await test("Read nudge uses plugin-format execute_file tool name", () => {
    const result = runHook({ tool_name: "Read", tool_input: { file_path: "/some/file.ts" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(PLUGIN_PREFIX + "execute_file"), "Expected plugin-format execute_file in Read nudge");
    assert.ok(!ctx.includes(SHORT_PREFIX + "execute_file"), "Read nudge must not contain short-form execute_file");
  });

  await test("Grep nudge uses plugin-format execute tool name", () => {
    const result = runHook({ tool_name: "Grep", tool_input: { pattern: "TODO" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(PLUGIN_PREFIX + "execute"), "Expected plugin-format execute in Grep nudge");
    assert.ok(!ctx.includes(SHORT_PREFIX + "execute"), "Grep nudge must not contain short-form execute");
  });

  await test("WebFetch deny reason uses plugin-format fetch_and_index tool name", () => {
    const result = runHook({ tool_name: "WebFetch", tool_input: { url: "https://example.com" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const reason = parsed.hookSpecificOutput.reason;
    assert.ok(reason.includes(PLUGIN_PREFIX + "fetch_and_index"), "Expected plugin-format fetch_and_index in WebFetch deny");
    assert.ok(!reason.includes(SHORT_PREFIX + "fetch_and_index"), "WebFetch deny must not contain short-form");
  });

  await test("Bash inline-HTTP redirect uses plugin-format execute tool name", () => {
    const bashCmd = "python3 -c 'import requests; requests.get(url)'";
    const result = runHook({ tool_name: "Bash", tool_input: { command: bashCmd } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const cmd = parsed.hookSpecificOutput.updatedInput.command;
    assert.ok(cmd.includes(PLUGIN_PREFIX + "execute"), "Expected plugin-format execute in inline-HTTP redirect");
    assert.ok(!cmd.includes(SHORT_PREFIX + "execute"), "Inline-HTTP redirect must not contain short-form execute");
  });

  // ===== SUMMARY =====
  console.log("\n" + "=".repeat(60));
  console.log(
    `Results: ${passed} passed, ${failed} failed (${passed + failed} total)`,
  );
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
