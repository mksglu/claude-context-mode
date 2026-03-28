import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GeminiCLIAdapter } from "../../src/adapters/gemini-cli/index.js";

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
