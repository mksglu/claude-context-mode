import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";
import { HOOK_TYPES, HOOK_SCRIPTS } from "../../src/adapters/gemini-cli/hooks.js";

describe("GeminiCLIAdapter", () => {
  let adapter: GeminiCLIAdapter;

  beforeEach(() => {
    adapter = new GeminiCLIAdapter();
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
        tool_name: "shell",
        tool_input: { command: "ls" },
      });
      expect(event.toolName).toBe("shell");
    });

    it("uses GEMINI_PROJECT_DIR for projectDir", () => {
      process.env.GEMINI_PROJECT_DIR = "/gemini/project";
      delete process.env.CLAUDE_PROJECT_DIR;
      const event = adapter.parsePreToolUseInput({
        tool_name: "shell",
      });
      expect(event.projectDir).toBe("/gemini/project");
    });

    it("falls back to CLAUDE_PROJECT_DIR for projectDir", () => {
      delete process.env.GEMINI_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = "/claude/project";
      const event = adapter.parsePreToolUseInput({
        tool_name: "shell",
      });
      expect(event.projectDir).toBe("/claude/project");
    });

    it("prefers input.cwd over env vars when both provided", () => {
      process.env.GEMINI_PROJECT_DIR = "/env/gemini";
      process.env.CLAUDE_PROJECT_DIR = "/env/claude";
      const event = adapter.parsePreToolUseInput({
        tool_name: "shell",
        cwd: "/wire/cwd",
      } as unknown as Record<string, unknown>);
      expect(event.projectDir).toBe("/wire/cwd");
    });

    it("falls back to process.cwd() when wire cwd and env both missing", () => {
      delete process.env.GEMINI_PROJECT_DIR;
      delete process.env.CLAUDE_PROJECT_DIR;
      const event = adapter.parsePreToolUseInput({
        tool_name: "shell",
      });
      expect(event.projectDir).toBe(process.cwd());
    });

    it("post/precompact/sessionstart parsers also fall back to process.cwd()", () => {
      delete process.env.GEMINI_PROJECT_DIR;
      delete process.env.CLAUDE_PROJECT_DIR;
      const post = adapter.parsePostToolUseInput({ tool_name: "shell" });
      expect(post.projectDir).toBe(process.cwd());

      const compact = adapter.parsePreCompactInput({ session_id: "s1" });
      expect(compact.projectDir).toBe(process.cwd());

      const start = adapter.parseSessionStartInput({ session_id: "s1" });
      expect(start.projectDir).toBe(process.cwd());
    });

    it("extracts sessionId from session_id field", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "shell",
        session_id: "gemini-session-abc",
      });
      expect(event.sessionId).toBe("gemini-session-abc");
    });

    it("falls back to pid when no session_id", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "shell",
      });
      expect(event.sessionId).toBe(`pid-${process.ppid}`);
    });
  });

  // ── formatPreToolUseResponse ──────────────────────────

  describe("formatPreToolUseResponse", () => {
    it("formats deny with decision:'deny' NOT permissionDecision", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "Blocked",
      });
      expect(result).toEqual({
        decision: "deny",
        reason: "Blocked",
      });
      // KEY DIFFERENCE: should NOT have permissionDecision
      expect(result).not.toHaveProperty("permissionDecision");
    });

    it("formats modify with hookSpecificOutput.tool_input", () => {
      const updatedInput = { command: "echo hello" };
      const result = adapter.formatPreToolUseResponse({
        decision: "modify",
        updatedInput,
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          tool_input: updatedInput,
        },
      });
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
    it("formats updatedOutput with decision:'deny' and reason", () => {
      const result = adapter.formatPostToolUseResponse({
        updatedOutput: "Replaced output",
      });
      expect(result).toEqual({
        decision: "deny",
        reason: "Replaced output",
      });
    });

    it("formats additionalContext with hookSpecificOutput.additionalContext", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "Extra context",
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          additionalContext: "Extra context",
        },
      });
    });

    it("returns undefined for empty response", () => {
      const result = adapter.formatPostToolUseResponse({});
      expect(result).toBeUndefined();
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    it("settings path is ~/.gemini/settings.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".gemini", "settings.json"),
      );
    });

    it("session dir is under ~/.gemini/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".gemini", "context-mode", "sessions"),
      );
    });
  });

  // ── BeforeAgent hook (UserPromptSubmit equivalent) ────

  describe("BeforeAgent hook", () => {
    it("HOOK_TYPES declares BeforeAgent (gemini types.ts:547-559)", () => {
      expect(HOOK_TYPES.BEFORE_AGENT).toBe("BeforeAgent");
    });

    it("HOOK_SCRIPTS maps BeforeAgent to beforeagent.mjs", () => {
      expect(HOOK_SCRIPTS["BeforeAgent"]).toBe("beforeagent.mjs");
    });

    it("hooks/gemini-cli/beforeagent.mjs exists on disk", () => {
      const scriptPath = resolve(
        __dirname,
        "..",
        "..",
        "hooks",
        "gemini-cli",
        "beforeagent.mjs",
      );
      expect(existsSync(scriptPath)).toBe(true);
    });

    it("generateHookConfig wires BeforeAgent into settings (matcher: '')", () => {
      const config = adapter.generateHookConfig("/plugin/root") as Record<
        string,
        Array<{ matcher?: string; hooks?: Array<{ command?: string; type?: string }> }>
      >;
      expect(config["BeforeAgent"]).toBeDefined();
      expect(config["BeforeAgent"].length).toBe(1);
      expect(config["BeforeAgent"][0].matcher).toBe("");
      expect(config["BeforeAgent"][0].hooks?.[0].type).toBe("command");
      expect(config["BeforeAgent"][0].hooks?.[0].command).toContain(
        "beforeagent.mjs",
      );
    });
  });

  // ── parseSessionStartInput ────────────────────────────

  describe("parseSessionStartInput", () => {
    it("parses source field correctly", () => {
      const event = adapter.parseSessionStartInput({
        session_id: "sess-1",
        source: "resume",
      });
      expect(event.source).toBe("resume");
    });

    it("defaults source to startup for unknown values", () => {
      const event = adapter.parseSessionStartInput({
        session_id: "sess-1",
        source: "unknown-source",
      });
      expect(event.source).toBe("startup");
    });
  });
});
