import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { QwenCodeAdapter } from "../../src/adapters/qwen-code/index.js";
import { hashProjectDirCanonical, resolveSessionDbPath } from "../../src/session/db.js";
import { fakeHome, realHome } from "../setup-home";

describe("QwenCodeAdapter", () => {
  let adapter: QwenCodeAdapter;

  beforeEach(() => {
    adapter = new QwenCodeAdapter();
  });

  // -- Capabilities -----------------------------------------------

  describe("capabilities", () => {
    it("adapter.name is 'Qwen Code'", () => {
      expect(adapter.name).toBe("Qwen Code");
    });

    it("paradigm is json-stdio", () => {
      expect(adapter.paradigm).toBe("json-stdio");
    });

    it("has all capabilities enabled matching Claude Code", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
      expect(adapter.capabilities.preCompact).toBe(true);
      expect(adapter.capabilities.sessionStart).toBe(true);
      expect(adapter.capabilities.canModifyArgs).toBe(true);
      expect(adapter.capabilities.canModifyOutput).toBe(true);
      expect(adapter.capabilities.canInjectSessionContext).toBe(true);
    });
  });

  // -- parsePreToolUseInput ---------------------------------------

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

    it("extracts sessionId from session_id field (not transcript_path first like Claude)", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        session_id: "qwen-sess-123",
      });
      expect(event.sessionId).toBe("qwen-sess-123");
    });

    it("uses QWEN_PROJECT_DIR for projectDir", () => {
      process.env.QWEN_PROJECT_DIR = "/my/qwen/project";
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
      });
      expect(event.projectDir).toBe("/my/qwen/project");
    });

    it("falls back to pid when no session_id provided", () => {
      delete process.env.QWEN_SESSION_ID;
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
      });
      expect(event.sessionId).toBe(`pid-${process.ppid}`);
    });
  });

  // -- formatPreToolUseResponse -----------------------------------

  describe("formatPreToolUseResponse", () => {
    it("formats deny with hookSpecificOutput containing deny reason", () => {
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

  // -- Config paths -----------------------------------------------

  describe("config paths", () => {
    it("settings path is ~/.qwen/settings.json (NOT ~/.claude/)", () => {
      const settingsPath = adapter.getSettingsPath();
      expect(settingsPath).toBe(
        resolve(homedir(), ".qwen", "settings.json"),
      );
      expect(settingsPath).not.toContain(".claude");
    });

    it("session dir is under ~/.qwen/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".qwen", "context-mode", "sessions"),
      );
    });

    it("creates session dirs under fake HOME instead of the contributor real HOME", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir.startsWith(fakeHome)).toBe(true);
      expect(sessionDir.startsWith(join(realHome, ".qwen", "context-mode"))).toBe(false);
    });

    // C2 narrowing: per-project DB path is composed by callers via
    // resolveSessionDbPath + adapter.getSessionDir().
    it("DB path uses canonical hash of projectDir", () => {
      const projectDir = "/my/project";
      const hash = hashProjectDirCanonical(projectDir);
      const dbPath = resolveSessionDbPath({
        projectDir,
        sessionsDir: adapter.getSessionDir(),
      });
      expect(dbPath).toBe(
        join(homedir(), ".qwen", "context-mode", "sessions", `${hash}.db`),
      );
    });
  });

  // -- extractSessionId -------------------------------------------

  describe("extractSessionId", () => {
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      savedEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = savedEnv;
    });

    it("checks session_id field first (NOT transcript_path first like Claude)", () => {
      // Qwen Code should prioritize session_id over transcript_path
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        session_id: "qwen-direct-id",
        transcript_path: "/some/path/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl",
      });
      expect(event.sessionId).toBe("qwen-direct-id");
    });
  });

  // -- validateHooks ----------------------------------------------

  describe("validateHooks", () => {
    let tempDir: string;
    let pluginRoot: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "qwen-doctor-test-"));
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

    it("returns pass status (not warn) when hooks exist in settings.json", () => {
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "context-mode hook qwen-code pretooluse" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "context-mode hook qwen-code sessionstart" }],
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

    it("returns fail when no hooks are configured", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("fail");
      expect(sessionStart?.status).toBe("fail");
    });
  });

  // -- checkPluginRegistration ------------------------------------

  describe("checkPluginRegistration", () => {
    it("handles no plugin registry gracefully", () => {
      // Qwen Code may not have a plugin registry — should not throw
      const result = adapter.checkPluginRegistration();
      expect(result).toBeDefined();
      expect(result.check).toBe("Plugin registration");
      // Should return warn (not fail/throw) since no registry exists
      expect(["pass", "warn"]).toContain(result.status);
    });
  });

  // -- configureAllHooks (SLICE Qwen-2: Z6 — all 5 hooks) --------

  describe("configureAllHooks", () => {
    let tempDir: string;
    let pluginRoot: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "qwen-cfg-test-"));
      pluginRoot = mkdtempSync(join(tmpdir(), "qwen-cfg-plugin-"));
      Object.defineProperty(adapter, "getSettingsPath", {
        value: () => join(tempDir, "settings.json"),
        configurable: true,
      });
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ hooks: {} }));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    });

    it("writes ALL 5 declared hooks (PreToolUse, PostToolUse, SessionStart, PreCompact, UserPromptSubmit)", () => {
      adapter.configureAllHooks(pluginRoot);
      const written = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const hookKeys = Object.keys(written.hooks ?? {}).sort();
      expect(hookKeys).toEqual(
        ["PostToolUse", "PreCompact", "PreToolUse", "SessionStart", "UserPromptSubmit"],
      );
    });

    it("each declared hook entry references the matching script", () => {
      adapter.configureAllHooks(pluginRoot);
      const written = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const expectedScripts: Record<string, string> = {
        PreToolUse: "pretooluse.mjs",
        PostToolUse: "posttooluse.mjs",
        SessionStart: "sessionstart.mjs",
        PreCompact: "precompact.mjs",
        UserPromptSubmit: "userpromptsubmit.mjs",
      };
      for (const [hookName, script] of Object.entries(expectedScripts)) {
        const entries = written.hooks[hookName];
        expect(Array.isArray(entries)).toBe(true);
        expect(entries.length).toBeGreaterThan(0);
        const cmd = entries[0].hooks[0].command as string;
        expect(cmd).toContain(script);
      }
    });
  });

  // -- parseSessionStartInput ------------------------------------

  describe("parseSessionStartInput", () => {
    it("parses source field correctly", () => {
      const event = adapter.parseSessionStartInput!({
        session_id: "sess-1",
        source: "compact",
      });
      expect(event.source).toBe("compact");
    });

    it("defaults source to startup for unknown values", () => {
      const event = adapter.parseSessionStartInput!({
        session_id: "sess-1",
        source: "something-else",
      });
      expect(event.source).toBe("startup");
    });
  });
});
