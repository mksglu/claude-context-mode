/**
 * Hook Integration Tests -- pretooluse.sh
 *
 * Directly invokes the pretooluse.sh hook script by piping simulated
 * JSON stdin (the same JSON that Claude Code sends) and asserts correct output.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "hooks", "pretooluse.sh");

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

function runHook(input: Record<string, unknown>): HookResult {
  const result = spawnSync("bash", [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 5000,
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
  console.log("\nContext Mode — Hook Integration Tests (pretooluse.sh)");
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
      parsed.hookSpecificOutput.updatedInput.prompt.includes("CONTEXT WINDOW PROTECTION"),
      "Expected routing block in updatedInput.prompt",
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
      updated.prompt.includes("CONTEXT WINDOW PROTECTION"),
      "Expected routing block in prompt",
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
