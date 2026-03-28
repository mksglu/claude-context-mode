import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { VSCodeCopilotAdapter } from "../../src/adapters/vscode-copilot/index.js";

describe("VSCodeCopilotAdapter", () => {
  let adapter: VSCodeCopilotAdapter;

  beforeEach(() => {
    adapter = new VSCodeCopilotAdapter();
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("all hook capabilities enabled", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
      expect(adapter.capabilities.preCompact).toBe(true);
      expect(adapter.capabilities.sessionStart).toBe(true);
      expect(adapter.capabilities.canModifyArgs).toBe(true);
    });

    it("canModifyOutput is true", () => {
      expect(adapter.capabilities.canModifyOutput).toBe(true);
    });

    it("canInjectSessionContext is true", () => {
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

    it("extracts sessionId from sessionId (camelCase NOT session_id)", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
        sessionId: "vscode-sess-abc",
      });
      expect(event.sessionId).toBe("vscode-sess-abc");
    });

    it("does not extract sessionId from session_id (snake_case)", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
        session_id: "should-not-use-this",
      });
      // Should fall back to VSCODE_PID or pid, not session_id
      expect(event.sessionId).not.toBe("should-not-use-this");
    });

    it("uses VSCODE_PID for sessionId fallback", () => {
      process.env.VSCODE_PID = "99999";
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.sessionId).toBe("vscode-99999");
    });

    it("uses CLAUDE_PROJECT_DIR for projectDir", () => {
      process.env.CLAUDE_PROJECT_DIR = "/vscode/project";
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.projectDir).toBe("/vscode/project");
    });

    it("extracts toolName from tool_name", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "f1e_readFile",
        tool_input: { filePath: "/some/file" },
      });
      expect(event.toolName).toBe("f1e_readFile");
    });
  });

  // ── formatPreToolUseResponse ──────────────────────────

  describe("formatPreToolUseResponse", () => {
    it("formats deny with permissionDecision (same as Claude)", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "Not allowed",
      });
      expect(result).toEqual({
        permissionDecision: "deny",
        reason: "Not allowed",
      });
    });

    it("formats modify with hookSpecificOutput wrapper and hookEventName", () => {
      const updatedInput = { filePath: "/new/path" };
      const result = adapter.formatPreToolUseResponse({
        decision: "modify",
        updatedInput,
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput,
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
    it("wraps additionalContext in hookSpecificOutput with hookEventName", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "Extra context",
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "Extra context",
        },
      });
    });

    it("wraps updatedOutput with decision:block in hookSpecificOutput", () => {
      const result = adapter.formatPostToolUseResponse({
        updatedOutput: "Replaced output",
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          decision: "block",
          reason: "Replaced output",
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
    it("settings path is .github/hooks/context-mode.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(".github", "hooks", "context-mode.json"),
      );
    });

    it("session dir is under ~/.vscode/context-mode/sessions/ or .github/", () => {
      // The adapter uses .github/ if it exists, otherwise ~/.vscode/
      // We just verify it returns a valid path containing context-mode/sessions
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toContain("context-mode");
      expect(sessionDir).toContain("sessions");
    });
  });

  // ── parseSessionStartInput ────────────────────────────

  describe("parseSessionStartInput", () => {
    it("parses source field correctly", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "vsc-sess",
        source: "clear",
      });
      expect(event.source).toBe("clear");
    });

    it("extracts sessionId from camelCase field", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "vsc-sess-123",
      });
      expect(event.sessionId).toBe("vsc-sess-123");
    });
  });
});
