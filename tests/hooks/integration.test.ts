/**
 * Hook Integration Tests
 *
 * Consolidated from:
 * - tests/hook-integration.test.ts (pretooluse.mjs hook tests)
 * - tests/routing-instructions.test.ts (writeRoutingInstructions TDD tests)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Hook Integration Tests -- pretooluse.mjs
// ═══════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "..", "hooks", "pretooluse.mjs");

// Clean guidance throttle markers before each test so guidance fires fresh.
// Subprocess hooks use process.ppid (= this test's pid) + VITEST_WORKER_ID.
const _wid = process.env.VITEST_WORKER_ID;
const _guidanceSuffix = _wid ? `${process.pid}-w${_wid}` : String(process.pid);
const _guidanceDir = resolve(tmpdir(), `context-mode-guidance-${_guidanceSuffix}`);
beforeEach(() => {
  try { rmSync(_guidanceDir, { recursive: true, force: true }); } catch {}
});

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHook(input: Record<string, unknown>, env?: Record<string, string>, { bom = false } = {}): HookResult {
  const json = JSON.stringify(input);
  const result = spawnSync("node", [HOOK_PATH], {
    input: bom ? "\uFEFF" + json : json,
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
    hso.permissionDecisionReason.includes(substringInReason),
    `Expected permissionDecisionReason to contain "${substringInReason}", got: ${hso.permissionDecisionReason}`,
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

describe("Bash: Redirected Commands", () => {
  test("Bash + curl: redirected to echo via updatedInput", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "curl -s http://example.com" },
    });
    assertRedirect(result, "context-mode");
  });

  test("Bash + wget: redirected to echo via updatedInput", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "wget http://example.com/file.tar.gz" },
    });
    assertRedirect(result, "context-mode");
  });

  test("Bash + node -e with inline HTTP call: redirected to echo", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: `node -e "fetch('http://api.example.com/data')"` },
    });
    assertRedirect(result, "context-mode");
  });

  test("Bash + ./gradlew build: redirected to execute sandbox (Issue #38)", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "./gradlew build --info" },
    });
    assertRedirect(result, "Build tool redirected");
  });

  test("Bash + mvn package: redirected to execute sandbox (Issue #38)", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "mvn clean package -DskipTests" },
    });
    assertRedirect(result, "Build tool redirected");
  });
});

describe("Bash: Allowed Commands", () => {
  test("Bash + git status: additionalContext with BASH_GUIDANCE", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext, "Expected additionalContext for Bash");
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> in Bash additionalContext",
    );
  });

  test("Bash + mkdir /tmp/test: additionalContext with BASH_GUIDANCE", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "mkdir /tmp/test" },
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext, "Expected additionalContext for Bash");
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> in Bash additionalContext",
    );
  });
});

describe("WebFetch", () => {
  test("WebFetch + any URL: denied with sandbox redirect", () => {
    const result = runHook({
      tool_name: "WebFetch",
      tool_input: { url: "https://docs.example.com/api" },
    });
    assertDeny(result, "fetch_and_index");
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes("https://docs.example.com/api"),
      "Expected original URL in reason",
    );
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes("Do NOT use curl"),
      "Expected curl warning in reason",
    );
  });
});

describe("Task", () => {
  test("Task + prompt: hookSpecificOutput with updatedInput containing routing block", () => {
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

  test("Task + Bash subagent: upgraded to general-purpose for MCP access", () => {
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

  test("Task + Explore subagent: keeps original subagent_type", () => {
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
});

describe("Read", () => {
  test("Read + file_path: hookSpecificOutput with additionalContext nudge", () => {
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
});

describe("Grep", () => {
  test("Grep + pattern: hookSpecificOutput with additionalContext nudge", () => {
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
});

describe("Passthrough Tools", () => {
  test("Glob + pattern: passthrough", () => {
    const result = runHook({
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
    });
    assertPassthrough(result);
  });

  test("WebSearch: passthrough", () => {
    const result = runHook({
      tool_name: "WebSearch",
      tool_input: { query: "typescript best practices" },
    });
    assertPassthrough(result);
  });

  test("Unknown tool (Edit): passthrough", () => {
    const result = runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
    });
    assertPassthrough(result);
  });
});

describe("Security Policy Enforcement", () => {
  let ISOLATED_HOME: string;
  let MOCK_PROJECT_DIR: string;
  let secEnv: Record<string, string>;

  beforeAll(() => {
    // Set up isolated temp dirs for security tests
    ISOLATED_HOME = join(tmpdir(), `hook-sec-home-${Date.now()}`);
    MOCK_PROJECT_DIR = join(tmpdir(), `hook-sec-project-${Date.now()}`);
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

    secEnv = { HOME: ISOLATED_HOME, CLAUDE_PROJECT_DIR: MOCK_PROJECT_DIR };
  });

  afterAll(() => {
    try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch {}
    try { rmSync(MOCK_PROJECT_DIR, { recursive: true, force: true }); } catch {}
  });

  test("Security: Bash + sudo denied by deny pattern", () => {
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "sudo apt install vim" } },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.includes("deny pattern"));
  });

  test("Security: Bash + git allowed, falls through to Stage 2", () => {
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "git status" } },
      secEnv,
    );
    // git is in allow list -> falls through to Stage 2 routing
    // Stage 2: git is not curl/wget/fetch -> additionalContext with BASH_GUIDANCE
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext, "Allowed Bash command should get additionalContext");
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> in Bash additionalContext",
    );
  });

  test("Security: MCP execute + shell + sudo denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute",
        tool_input: { language: "shell", code: "sudo rm -rf /" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  });

  test("Security: MCP execute + python (non-shell) passthrough", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute",
        tool_input: { language: "python", code: "print('hello')" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "", "Non-shell language should passthrough");
  });

  test("Security: MCP execute_file + .env path denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        tool_input: { path: ".env", language: "shell", code: "cat" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.includes("Read deny pattern"));
  });

  test("Security: MCP execute_file + safe path passthrough", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        tool_input: { path: "src/app.ts", language: "javascript", code: "console.log('ok')" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "", "Safe path should passthrough");
  });

  test("Security: MCP execute_file + safe path but sudo in shell code denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        tool_input: { path: "src/app.sh", language: "shell", code: "sudo rm -rf /" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  });

  test("Security: MCP batch_execute with sudo in one command denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
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

  test("Security: MCP batch_execute with all allowed commands passthrough", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
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
});

describe("Plugin Tool Name Format in ROUTING_BLOCK", () => {
  // When installed via Claude Code plugin marketplace, tool names follow:
  //   mcp__plugin_<plugin-id>_<server-name>__<tool-name>
  // For context-mode: mcp__plugin_context-mode_context-mode__<tool-name>
  // The short form mcp__context-mode__* only works for direct MCP registration.

  const PLUGIN_PREFIX = "mcp__plugin_context-mode_context-mode__";
  const SHORT_PREFIX = "mcp__context-mode__";

  test("Task routing block uses plugin-format tool names", () => {
    const result = runHook({ tool_name: "Task", tool_input: { prompt: "Do something." } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes(PLUGIN_PREFIX + "ctx_batch_execute"), "Expected plugin-format ctx_batch_execute");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "ctx_search"), "Expected plugin-format ctx_search");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "ctx_execute"), "Expected plugin-format ctx_execute");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "ctx_fetch_and_index"), "Expected plugin-format ctx_fetch_and_index");
    assert.ok(!prompt.includes(SHORT_PREFIX + "ctx_batch_execute"), "Must not contain short-form ctx_batch_execute");
  });

  test("Read nudge uses plugin-format execute_file tool name", () => {
    const result = runHook({ tool_name: "Read", tool_input: { file_path: "/some/file.ts" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(PLUGIN_PREFIX + "ctx_execute_file"), "Expected plugin-format ctx_execute_file in Read nudge");
    assert.ok(!ctx.includes(SHORT_PREFIX + "ctx_execute_file"), "Read nudge must not contain short-form ctx_execute_file");
  });

  test("Grep nudge uses plugin-format execute tool name", () => {
    const result = runHook({ tool_name: "Grep", tool_input: { pattern: "TODO" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(PLUGIN_PREFIX + "ctx_execute"), "Expected plugin-format ctx_execute in Grep nudge");
    assert.ok(!ctx.includes(SHORT_PREFIX + "ctx_execute"), "Grep nudge must not contain short-form ctx_execute");
  });

  test("WebFetch deny reason uses plugin-format fetch_and_index tool name", () => {
    const result = runHook({ tool_name: "WebFetch", tool_input: { url: "https://example.com" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes(PLUGIN_PREFIX + "ctx_fetch_and_index"), "Expected plugin-format ctx_fetch_and_index in WebFetch deny");
    assert.ok(!reason.includes(SHORT_PREFIX + "ctx_fetch_and_index"), "WebFetch deny must not contain short-form");
  });

  test("Bash inline-HTTP redirect uses plugin-format execute tool name", () => {
    const bashCmd = "python3 -c 'import requests; requests.get(url)'";
    const result = runHook({ tool_name: "Bash", tool_input: { command: bashCmd } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const cmd = parsed.hookSpecificOutput.updatedInput.command;
    assert.ok(cmd.includes(PLUGIN_PREFIX + "ctx_execute"), "Expected plugin-format ctx_execute in inline-HTTP redirect");
    assert.ok(!cmd.includes(SHORT_PREFIX + "ctx_execute"), "Inline-HTTP redirect must not contain short-form ctx_execute");
  });
});

describe("Skill Commands", () => {
  const SKILLS_DIR = join(__dirname, "..", "..", "skills");

  test("ctx-doctor skill directory exists with valid SKILL.md", () => {
    const skillMd = join(SKILLS_DIR, "ctx-doctor", "SKILL.md");
    assert.ok(existsSync(skillMd), "skills/ctx-doctor/SKILL.md must exist");
    const content = readFileSync(skillMd, "utf-8");
    assert.ok(content.includes("name: ctx-doctor"), "SKILL.md name must be ctx-doctor");
    assert.ok(content.includes("/context-mode:ctx-doctor"), "Trigger must reference ctx-doctor");
  });

  test("ctx-upgrade skill directory exists with valid SKILL.md", () => {
    const skillMd = join(SKILLS_DIR, "ctx-upgrade", "SKILL.md");
    assert.ok(existsSync(skillMd), "skills/ctx-upgrade/SKILL.md must exist");
    const content = readFileSync(skillMd, "utf-8");
    assert.ok(content.includes("name: ctx-upgrade"), "SKILL.md name must be ctx-upgrade");
    assert.ok(content.includes("/context-mode:ctx-upgrade"), "Trigger must reference ctx-upgrade");
  });

  test("ctx-stats skill directory exists with valid SKILL.md", () => {
    const skillMd = join(SKILLS_DIR, "ctx-stats", "SKILL.md");
    assert.ok(existsSync(skillMd), "skills/ctx-stats/SKILL.md must exist");
    const content = readFileSync(skillMd, "utf-8");
    assert.ok(content.includes("name: ctx-stats"), "SKILL.md name must be ctx-stats");
    assert.ok(content.includes("/context-mode:ctx-stats"), "Trigger must reference ctx-stats");
  });

  test("old skill directories (doctor, upgrade, stats) no longer exist", () => {
    for (const old of ["doctor", "upgrade", "stats"]) {
      assert.ok(
        !existsSync(join(SKILLS_DIR, old)),
        `Old skill directory skills/${old} must not exist`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Routing Instructions Tests -- writeRoutingInstructions()
// ═══════════════════════════════════════════════════════════════════════

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ctx-test-${prefix}-`));
}

function createPluginRoot(base: string): string {
  // Simulate a plugin root with configs/codex/AGENTS.md
  const pluginRoot = join(base, "plugin");
  const configDir = join(pluginRoot, "configs", "codex");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "AGENTS.md"),
    "# context-mode — MANDATORY routing rules\n\nUse context-mode MCP tools.\n",
    "utf-8",
  );
  return pluginRoot;
}

describe("Routing instructions — platform capabilities", () => {
  test("Codex CLI has sessionStart === false (hookless)", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("codex");
    expect(adapter.capabilities.sessionStart).toBe(false);
  });

  test("Claude Code has sessionStart === true (has hooks)", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("claude-code");
    expect(adapter.capabilities.sessionStart).toBe(true);
  });

  test("Gemini CLI has sessionStart === true (has hooks)", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("gemini-cli");
    expect(adapter.capabilities.sessionStart).toBe(true);
  });

  test("OpenCode has sessionStart === true (has hooks)", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("opencode");
    expect(adapter.capabilities.sessionStart).toBe(true);
  });

  test("VS Code Copilot has sessionStart === true (has hooks)", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("vscode-copilot");
    expect(adapter.capabilities.sessionStart).toBe(true);
  });
});

describe("Routing instructions — writeRoutingInstructions()", () => {
  let tempDir: string;
  let projectDir: string;
  let pluginRoot: string;

  beforeEach(() => {
    tempDir = createTempDir("routing");
    projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    pluginRoot = createPluginRoot(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates AGENTS.md when file does not exist", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    const result = adapter.writeRoutingInstructions(projectDir, pluginRoot);
    const targetPath = resolve(projectDir, "AGENTS.md");

    expect(result).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);

    const content = readFileSync(targetPath, "utf-8");
    expect(content).toContain("context-mode");
  });

  test("appends to existing AGENTS.md that does not contain context-mode", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // Pre-create AGENTS.md with unrelated content
    const targetPath = resolve(projectDir, "AGENTS.md");
    const existingContent = "# My Project Agents\n\nSome existing rules.\n";
    writeFileSync(targetPath, existingContent, "utf-8");

    const result = adapter.writeRoutingInstructions(projectDir, pluginRoot);

    expect(result).toBe(targetPath);

    const content = readFileSync(targetPath, "utf-8");
    // Should preserve original content
    expect(content).toContain("My Project Agents");
    expect(content).toContain("Some existing rules.");
    // Should append context-mode instructions
    expect(content).toContain("context-mode");
  });

  test("skips when AGENTS.md already contains context-mode (idempotent)", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // Pre-create AGENTS.md WITH context-mode content
    const targetPath = resolve(projectDir, "AGENTS.md");
    const existingContent = "# context-mode routing\n\nAlready configured.\n";
    writeFileSync(targetPath, existingContent, "utf-8");

    const result = adapter.writeRoutingInstructions(projectDir, pluginRoot);

    // Should return null (no-op)
    expect(result).toBeNull();

    // Content should be unchanged
    const content = readFileSync(targetPath, "utf-8");
    expect(content).toBe(existingContent);
  });

  test("double-write is idempotent", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // First write — creates
    const result1 = adapter.writeRoutingInstructions(projectDir, pluginRoot);
    expect(result1).not.toBeNull();

    const contentAfterFirst = readFileSync(resolve(projectDir, "AGENTS.md"), "utf-8");

    // Second write — should be no-op
    const result2 = adapter.writeRoutingInstructions(projectDir, pluginRoot);
    expect(result2).toBeNull();

    const contentAfterSecond = readFileSync(resolve(projectDir, "AGENTS.md"), "utf-8");
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  test("returns null when source config file is missing", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // Use a plugin root WITHOUT configs/codex/AGENTS.md
    const emptyPluginRoot = join(tempDir, "empty-plugin");
    mkdirSync(emptyPluginRoot, { recursive: true });

    const result = adapter.writeRoutingInstructions(projectDir, emptyPluginRoot);
    expect(result).toBeNull();
    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(false);
  });
});

describe("Routing instructions — hookless platform gate", () => {
  let tempDir: string;
  let projectDir: string;
  let pluginRoot: string;

  beforeEach(() => {
    tempDir = createTempDir("gate");
    projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    pluginRoot = createPluginRoot(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("hookless platform (codex) triggers writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("codex");

    // Simulate startup gate
    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(true);
  });

  test("hook-capable platform (claude-code) does NOT trigger writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("claude-code");

    // Simulate startup gate
    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    // AGENTS.md should NOT be created
    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(false);
  });

  test("hook-capable platform (gemini-cli) does NOT trigger writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("gemini-cli");

    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(false);
  });

  test("hook-capable platform (opencode) does NOT trigger writeRoutingInstructions", async () => {
    const { getAdapter } = await import("../../src/adapters/detect.js");
    const adapter = await getAdapter("opencode");

    if (!adapter.capabilities.sessionStart) {
      adapter.writeRoutingInstructions(projectDir, pluginRoot);
    }

    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(false);
  });
});

describe("UTF-8 BOM handling (core/stdin.mjs path)", () => {
  test("pretooluse.mjs parses BOM-prefixed stdin without error", () => {
    const result = runHook({
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
    }, undefined, { bom: true });
    assertPassthrough(result);
  });

  test("pretooluse.mjs handles BOM-prefixed Bash input correctly", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "curl -s http://example.com" },
    }, undefined, { bom: true });
    assertRedirect(result, "context-mode");
  });
});
