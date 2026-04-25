/**
 * Hook Integration Tests
 *
 * Consolidated from:
 * - tests/hook-integration.test.ts (pretooluse.mjs hook tests)
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
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Hook Integration Tests -- pretooluse.mjs
// ═══════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "..", "hooks", "pretooluse.mjs");

// Clean guidance throttle markers before each test so guidance fires fresh.
// Subprocess hooks scope markers two ways (#298): the legacy ppid-based dir
// (kept as fallback when no sessionId is passed) and the sessionId-scoped dir
// (derived from getSessionId which falls back to `pid-${process.ppid}` when
// the hook payload has no session_id).
const _wid = process.env.VITEST_WORKER_ID;
const _guidanceSuffix = _wid ? `${process.pid}-w${_wid}` : String(process.pid);
const _guidanceDir = resolve(tmpdir(), `context-mode-guidance-${_guidanceSuffix}`);
const _sessionGuidanceDir = resolve(tmpdir(), `context-mode-guidance-s-pid-${process.pid}`);

// MCP readiness sentinel — subprocess hooks check process.ppid (= this test's pid)
const mcpSentinel = resolve(tmpdir(), `context-mode-mcp-ready-${process.pid}`);

beforeEach(() => {
  try { rmSync(_guidanceDir, { recursive: true, force: true }); } catch {}
  try { rmSync(_sessionGuidanceDir, { recursive: true, force: true }); } catch {}
  writeFileSync(mcpSentinel, String(process.pid));
});

afterEach(() => {
  try { unlinkSync(mcpSentinel); } catch {}
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
    timeout: 30_000,
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

describe("Task (#241: no longer routed)", () => {
  test("Task tool returns empty stdout (passthrough, no routing)", () => {
    const result = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Analyze this codebase and summarize the architecture." },
    });
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
    // Task is no longer intercepted — hook produces no hookSpecificOutput
    assert.equal(result.stdout.trim(), "", "Expected empty stdout for passthrough");
  });

  test("TaskCreate returns empty stdout (passthrough)", () => {
    const result = runHook({
      tool_name: "TaskCreate",
      tool_input: { title: "my task" },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "", "Expected empty stdout for passthrough");
  });

  test("TaskUpdate returns empty stdout (passthrough)", () => {
    const result = runHook({
      tool_name: "TaskUpdate",
      tool_input: { id: "123", status: "done" },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "", "Expected empty stdout for passthrough");
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

  test("Agent routing block uses plugin-format tool names", () => {
    const result = runHook({ tool_name: "Agent", tool_input: { prompt: "Do something." } });
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

// ═══════════════════════════════════════════════════════════════════════
// resolveConfigDir — respects platform CONFIG_DIR env vars (#289)
// ═══════════════════════════════════════════════════════════════════════

describe("resolveConfigDir (#289)", () => {
  const HELPERS_PATH = join(__dirname, "..", "..", "hooks", "session-helpers.mjs");

  async function loadHelpers(env: Record<string, string> = {}) {
    // Use a subprocess to isolate env var changes
    const code = `
      ${Object.entries(env).map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join("\n")}
      const { resolveConfigDir, GEMINI_OPTS, CODEX_OPTS, VSCODE_OPTS, CURSOR_OPTS, KIRO_OPTS } = await import(${JSON.stringify(HELPERS_PATH)});
      const result = {
        claude_default: resolveConfigDir(),
        gemini_default: resolveConfigDir(GEMINI_OPTS),
        codex_default: resolveConfigDir(CODEX_OPTS),
        vscode_default: resolveConfigDir(VSCODE_OPTS),
        cursor_default: resolveConfigDir(CURSOR_OPTS),
        kiro_default: resolveConfigDir(KIRO_OPTS),
      };
      process.stdout.write(JSON.stringify(result));
    `;
    const r = spawnSync("node", ["--input-type=module", "-e", code], {
      encoding: "utf-8",
      env: { ...process.env, ...env, CONTEXT_MODE_SESSION_SUFFIX: "" },
      timeout: 10000,
    });
    return JSON.parse(r.stdout);
  }

  test("defaults to ~/<configDir> when no env var set", async () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const result = await loadHelpers({
      CLAUDE_CONFIG_DIR: "",
      GEMINI_CLI_HOME: "",
      CODEX_HOME: "",
    });
    expect(result.claude_default).toBe(join(home, ".claude"));
    expect(result.gemini_default).toBe(join(home, ".gemini"));
    expect(result.codex_default).toBe(join(home, ".codex"));
    expect(result.vscode_default).toBe(join(home, ".vscode"));
    expect(result.cursor_default).toBe(join(home, ".cursor"));
    expect(result.kiro_default).toBe(join(home, ".kiro"));
  });

  test("CLAUDE_CONFIG_DIR overrides Claude Code config path", async () => {
    const result = await loadHelpers({ CLAUDE_CONFIG_DIR: "/custom/claude-work" });
    expect(result.claude_default).toBe("/custom/claude-work");
    // Other platforms unaffected
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expect(result.gemini_default).toBe(join(home, ".gemini"));
  });

  test("GEMINI_CLI_HOME overrides Gemini CLI config path", async () => {
    const result = await loadHelpers({ GEMINI_CLI_HOME: "/custom/gemini" });
    expect(result.gemini_default).toBe("/custom/gemini");
  });

  test("CODEX_HOME overrides Codex CLI config path", async () => {
    const result = await loadHelpers({ CODEX_HOME: "/custom/codex" });
    expect(result.codex_default).toBe("/custom/codex");
  });

  test("tilde expansion works in env var values", async () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const result = await loadHelpers({ CLAUDE_CONFIG_DIR: "~/.claude-work" });
    expect(result.claude_default).toBe(join(home, ".claude-work"));
  });

  test("platforms without configDirEnv ignore env vars", async () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    // VS Code Copilot, Cursor, Kiro have no configDirEnv
    const result = await loadHelpers({});
    expect(result.vscode_default).toBe(join(home, ".vscode"));
    expect(result.cursor_default).toBe(join(home, ".cursor"));
    expect(result.kiro_default).toBe(join(home, ".kiro"));
  });

  test("session DB path uses resolved config dir", async () => {
    const customDir = mkdtempSync(join(tmpdir(), "ctx-config-dir-test-"));
    try {
      const code = `
        process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(customDir)};
        process.env.CLAUDE_PROJECT_DIR = "/test/project";
        process.env.CONTEXT_MODE_SESSION_SUFFIX = "";
        const { getSessionDBPath } = await import(${JSON.stringify(HELPERS_PATH)});
        process.stdout.write(getSessionDBPath());
      `;
      const r = spawnSync("node", ["--input-type=module", "-e", code], {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: customDir, CLAUDE_PROJECT_DIR: "/test/project", CONTEXT_MODE_SESSION_SUFFIX: "" },
        timeout: 10000,
      });
      expect(r.stdout).toContain(customDir);
      expect(r.stdout).toContain("context-mode");
      expect(r.stdout).toContain("sessions");
      expect(r.stdout).toMatch(/\.db$/);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });
});
