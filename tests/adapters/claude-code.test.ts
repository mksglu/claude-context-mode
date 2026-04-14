import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { fakeHome, realHome } from "../setup-home";
import {
  PRE_TOOL_USE_MATCHERS,
  POST_TOOL_USE_MATCHERS,
  POST_TOOL_USE_MATCHER_PATTERN,
} from "../../src/adapters/claude-code/hooks.js";

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("has all capabilities enabled", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
      expect(adapter.capabilities.preCompact).toBe(true);
      expect(adapter.capabilities.sessionStart).toBe(true);
      expect(adapter.capabilities.canModifyArgs).toBe(true);
      expect(adapter.capabilities.canModifyOutput).toBe(true);
      expect(adapter.capabilities.canInjectSessionContext).toBe(true);
    });

    it("paradigm is json-stdio", () => {
      expect(adapter.paradigm).toBe("json-stdio");
    });
  });

  // ── parsePreToolUseInput ──────────────────────────────

  describe("parsePreToolUseInput", () => {
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      savedEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = savedEnv;
    });

    it("extracts toolName from tool_name", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      expect(event.toolName).toBe("Bash");
    });

    it("extracts toolInput from tool_input", () => {
      const input = { command: "ls", timeout: 5000 };
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: input,
      });
      expect(event.toolInput).toEqual(input);
    });

    it("extracts sessionId from transcript_path UUID", () => {
      const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        transcript_path: `/home/user/.claude/projects/foo/${uuid}.jsonl`,
      });
      expect(event.sessionId).toBe(uuid);
    });

    it("falls back to session_id field", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        session_id: "sess-from-field",
      });
      expect(event.sessionId).toBe("sess-from-field");
    });

    it("falls back to CLAUDE_SESSION_ID env", () => {
      process.env.CLAUDE_SESSION_ID = "env-session-id";
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
      });
      expect(event.sessionId).toBe("env-session-id");
    });

    it("falls back to pid", () => {
      delete process.env.CLAUDE_SESSION_ID;
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
      });
      expect(event.sessionId).toBe(`pid-${process.ppid}`);
    });

    it("uses CLAUDE_PROJECT_DIR for projectDir", () => {
      process.env.CLAUDE_PROJECT_DIR = "/my/project";
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
      });
      expect(event.projectDir).toBe("/my/project");
    });
  });

  // ── formatPreToolUseResponse ──────────────────────────

  describe("formatPreToolUseResponse", () => {
    it("formats deny with permissionDecision", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "Not allowed",
      });
      expect(result).toEqual({
        permissionDecision: "deny",
        reason: "Not allowed",
      });
    });

    it("formats deny with default reason when none provided", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
      });
      expect(result).toEqual({
        permissionDecision: "deny",
        reason: "Blocked by context-mode hook",
      });
    });

    it("formats modify with updatedInput", () => {
      const updatedInput = { command: "ls -la" };
      const result = adapter.formatPreToolUseResponse({
        decision: "modify",
        updatedInput,
      });
      expect(result).toEqual({ updatedInput });
    });

    it("returns undefined for allow", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "allow",
      });
      expect(result).toBeUndefined();
    });
  });

  // ── formatPostToolUseResponse ─────────────────────────

  describe("formatPostToolUseResponse", () => {
    it("formats additionalContext", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "Some extra info",
      });
      expect(result).toEqual({ additionalContext: "Some extra info" });
    });

    it("formats updatedMCPToolOutput for updatedOutput", () => {
      const result = adapter.formatPostToolUseResponse({
        updatedOutput: "New output",
      });
      expect(result).toEqual({ updatedMCPToolOutput: "New output" });
    });

    it("returns undefined for empty response", () => {
      const result = adapter.formatPostToolUseResponse({});
      expect(result).toBeUndefined();
    });

    it("includes both additionalContext and updatedMCPToolOutput when both provided", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "context",
        updatedOutput: "output",
      });
      expect(result).toEqual({
        additionalContext: "context",
        updatedMCPToolOutput: "output",
      });
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    it("settings path is ~/.claude/settings.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".claude", "settings.json"),
      );
    });

    it("session dir is under ~/.claude/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".claude", "context-mode", "sessions"),
      );
    });

    it("creates session dirs under fake HOME instead of the contributor real HOME", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir.startsWith(fakeHome)).toBe(true);
      expect(sessionDir.startsWith(join(realHome, ".claude", "context-mode"))).toBe(false);
    });

    it("DB path uses sha256 hash of projectDir", () => {
      const projectDir = "/my/project";
      const hash = createHash("sha256")
        .update(projectDir)
        .digest("hex")
        .slice(0, 16);
      const dbPath = adapter.getSessionDBPath(projectDir);
      expect(dbPath).toBe(
        join(homedir(), ".claude", "context-mode", "sessions", `${hash}.db`),
      );
    });
  });

  // ── validateHooks (Issue #94) ─────────────────────────

  describe("validateHooks", () => {
    let tempDir: string;
    let pluginRoot: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "claude-doctor-test-"));
      pluginRoot = mkdtempSync(join(tmpdir(), "plugin-root-test-"));
      Object.defineProperty(adapter, "getSettingsPath", {
        value: () => join(tempDir, "settings.json"),
        configurable: true,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    });

    it("returns PASS when hooks exist in plugin hooks.json but not settings.json", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
      writeFileSync(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }],
            }],
          },
        }),
      );

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("pass");
      expect(sessionStart?.status).toBe("pass");
    });

    it("returns PASS when hooks exist in .claude-plugin/hooks/hooks.json", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      mkdirSync(join(pluginRoot, ".claude-plugin", "hooks"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }],
            }],
          },
        }),
      );

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("pass");
      expect(sessionStart?.status).toBe("pass");
    });

    it("returns FAIL when hooks are in neither settings.json nor plugin hooks.json", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("fail");
      expect(sessionStart?.status).toBe("fail");
    });

    it("returns PASS when hooks exist in settings.json (existing behavior)", () => {
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "context-mode hook claude-code pretooluse" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "context-mode hook claude-code sessionstart" }],
            }],
          },
        }),
      );

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("pass");
      expect(sessionStart?.status).toBe("pass");
    });
  });

  // ── configureAllHooks — stale hook cleanup (Issue #187) ──

  describe("configureAllHooks", () => {
    let tempDir: string;
    let pluginRoot: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "claude-hooks-test-"));
      pluginRoot = mkdtempSync(join(tmpdir(), "plugin-root-hooks-"));
      // Create hook scripts in the pluginRoot so they're "valid"
      mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
      writeFileSync(join(pluginRoot, "hooks", "pretooluse.mjs"), "");
      writeFileSync(join(pluginRoot, "hooks", "sessionstart.mjs"), "");
      Object.defineProperty(adapter, "getSettingsPath", {
        value: () => join(tempDir, "settings.json"),
        configurable: true,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    });

    it("removes stale hook entries pointing to non-existent paths", () => {
      const staleRoot = "/tmp/non-existent-old-version-dir";
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${staleRoot}/hooks/sessionstart.mjs"` }],
            }],
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: `node "${staleRoot}/hooks/pretooluse.mjs"` }],
            }],
          },
        }),
      );

      const changes = adapter.configureAllHooks(pluginRoot);
      expect(changes).toContain("Removed 1 stale SessionStart hook(s)");
      expect(changes).toContain("Removed 1 stale PreToolUse hook(s)");
    });

    it("preserves non-context-mode hooks from other plugins", () => {
      const staleRoot = "/tmp/non-existent-old-version-dir";
      const otherPluginHook = {
        matcher: "Bash",
        hooks: [{ type: "command", command: "node /some/other-plugin/hooks/check.mjs" }],
      };
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              otherPluginHook,
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: `node "${staleRoot}/hooks/pretooluse.mjs"` }],
              },
            ],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const preToolUseEntries = settings.hooks.PreToolUse;
      // Should have the other plugin's hook + the fresh context-mode hook
      expect(preToolUseEntries.length).toBe(2);
      expect(preToolUseEntries[0]).toEqual(otherPluginHook);
    });

    it("handles multiple stale versions from upgrade chains", () => {
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: "",
                hooks: [{ type: "command", command: 'node "/old/path/0.9.17/hooks/sessionstart.mjs"' }],
              },
              {
                matcher: "",
                hooks: [{ type: "command", command: 'node "/old/path/1.0.50/hooks/sessionstart.mjs"' }],
              },
            ],
          },
        }),
      );

      const changes = adapter.configureAllHooks(pluginRoot);
      expect(changes).toContain("Removed 2 stale SessionStart hook(s)");
    });

    it("preserves CLI dispatcher format hooks (path-independent)", () => {
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "context-mode hook claude-code sessionstart" }],
            }],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      // Should have the dispatcher entry updated (or kept) + fresh entry
      const sessionStartEntries = settings.hooks.SessionStart;
      expect(sessionStartEntries.length).toBeGreaterThanOrEqual(1);
    });

    it("works correctly on fresh install with no existing hooks", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      const changes = adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(changes.some((c: string) => c.includes("stale"))).toBe(false);
    });

    it("skips settings.json registration when plugin hooks.json already has all required hooks", () => {
      // Plugin hooks.json has both PreToolUse and SessionStart
      mkdirSync(join(pluginRoot, ".claude-plugin", "hooks"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }],
            }],
          },
        }),
      );

      // settings.json starts empty
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      const changes = adapter.configureAllHooks(pluginRoot);

      // Should NOT have written hook entries to settings.json
      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      expect(settings.hooks?.PreToolUse).toBeUndefined();
      expect(settings.hooks?.SessionStart).toBeUndefined();
      // Should report that plugin hooks are sufficient
      expect(changes.some((c: string) => c.includes("plugin hooks.json"))).toBe(true);
    });

    it("still cleans stale entries even when plugin hooks.json is present", () => {
      const staleRoot = "/tmp/non-existent-old-version-dir";

      // Plugin hooks.json has all required hooks
      mkdirSync(join(pluginRoot, "hooks", "hooks_dir"), { recursive: true });
      writeFileSync(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }],
            }],
          },
        }),
      );

      // settings.json has stale entries
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${staleRoot}/hooks/sessionstart.mjs"` }],
            }],
          },
        }),
      );

      const changes = adapter.configureAllHooks(pluginRoot);

      // Should clean stale entries
      expect(changes).toContain("Removed 1 stale SessionStart hook(s)");
      // Should NOT re-register in settings.json
      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const sessionHooks = settings.hooks?.SessionStart;
      expect(!sessionHooks || sessionHooks.length === 0).toBe(true);
    });

    it("registers fresh hooks with correct pluginRoot paths after cleanup", () => {
      const staleRoot = "/tmp/old-version";
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${staleRoot}/hooks/sessionstart.mjs"` }],
            }],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const sessionHooks = settings.hooks.SessionStart;
      expect(sessionHooks).toHaveLength(1);
      // The fresh entry should point to the new pluginRoot (path may use \ on Windows)
      const command = sessionHooks[0].hooks[0].command;
      expect(command).toContain(pluginRoot);
      expect(command).toContain("sessionstart.mjs");
    });

    it("removes existing valid context-mode hooks from settings.json when plugin hooks.json covers all required hooks", () => {
      // Plugin hooks.json covers all required hooks (pluginRoot already has scripts from beforeEach)
      writeFileSync(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }] }],
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }] }],
          },
        }),
      );

      // settings.json has VALID (non-stale) context-mode hooks — paths exist, so they won't be
      // removed by the stale-path filter. But they duplicate what hooks.json already registers,
      // causing two concurrent hook processes for every tool call (the root cause of #NNN).
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash|WebFetch|Read|Grep|Agent",
              hooks: [{ type: "command", command: `node "${join(pluginRoot, "hooks", "pretooluse.mjs")}"` }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${join(pluginRoot, "hooks", "sessionstart.mjs")}"` }],
            }],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      // Valid duplicate hooks should be removed — hooks.json is the source of truth
      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      expect(settings.hooks?.PreToolUse ?? []).toHaveLength(0);
      expect(settings.hooks?.SessionStart ?? []).toHaveLength(0);
    });
  });

  // ── Hook matchers (#229, #241) ────────────────────────

  describe("hook matchers (#229, #241)", () => {
    it("PRE_TOOL_USE_MATCHERS does NOT contain 'Task' (#241)", () => {
      expect(PRE_TOOL_USE_MATCHERS).not.toContain("Task");
    });

    it("PRE_TOOL_USE_MATCHERS contains 'Agent' for subagent routing", () => {
      expect(PRE_TOOL_USE_MATCHERS).toContain("Agent");
    });

    it("POST_TOOL_USE_MATCHERS contains all tools that extractEvents handles", () => {
      const required = [
        "Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
        "TodoWrite", "TaskCreate", "TaskUpdate",
        "EnterPlanMode", "ExitPlanMode",
        "Skill", "Agent", "AskUserQuestion", "EnterWorktree",
        "mcp__",
      ];
      for (const tool of required) {
        expect(POST_TOOL_USE_MATCHERS).toContain(tool);
      }
    });

    it("POST_TOOL_USE_MATCHERS does NOT contain tools that produce zero events (#229)", () => {
      const excluded = [
        "TaskGet", "TaskList", "TaskStop", "TaskOutput",
        "ExitWorktree", "WebFetch", "WebSearch",
        "RemoteTrigger", "CronCreate", "CronDelete", "CronList",
      ];
      for (const tool of excluded) {
        expect(POST_TOOL_USE_MATCHERS).not.toContain(tool);
      }
    });

    it("POST_TOOL_USE_MATCHER_PATTERN is pipe-separated string", () => {
      expect(POST_TOOL_USE_MATCHER_PATTERN).toBe(POST_TOOL_USE_MATCHERS.join("|"));
    });
  });

  // ── parseSessionStartInput ────────────────────────────

  describe("parseSessionStartInput", () => {
    it("parses source field correctly", () => {
      const event = adapter.parseSessionStartInput({
        session_id: "sess-1",
        source: "compact",
      });
      expect(event.source).toBe("compact");
    });

    it("defaults source to startup for unknown values", () => {
      const event = adapter.parseSessionStartInput({
        session_id: "sess-1",
        source: "something-else",
      });
      expect(event.source).toBe("startup");
    });
  });
});
