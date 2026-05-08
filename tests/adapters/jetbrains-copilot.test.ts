import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { JetBrainsCopilotAdapter } from "../../src/adapters/jetbrains-copilot/index.js";

describe("JetBrainsCopilotAdapter", () => {
  let adapter: JetBrainsCopilotAdapter;

  beforeEach(() => {
    adapter = new JetBrainsCopilotAdapter();
  });

  // ── Class export ──────────────────────────────────────

  describe("exports", () => {
    it("exports JetBrainsCopilotAdapter class", () => {
      expect(JetBrainsCopilotAdapter).toBeDefined();
      expect(adapter).toBeInstanceOf(JetBrainsCopilotAdapter);
    });

    it("platform name is jetbrains-copilot", () => {
      expect(adapter.name).toContain("JetBrains");
    });
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("all hook capabilities enabled (same as vscode-copilot)", () => {
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

  // ── getSessionDir ─────────────────────────────────────

  describe("getSessionDir", () => {
    it("returns path under ~/.config/JetBrains/context-mode/sessions", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toContain("JetBrains");
      expect(sessionDir).toContain("context-mode");
      expect(sessionDir).toContain("sessions");
    });
  });

  // ── getSessionDBPath ──────────────────────────────────

  describe("getSessionDBPath", () => {
    it("produces correct hash-based path", () => {
      const projectDir = "/home/user/my-project";
      const dbPath = adapter.getSessionDBPath(projectDir);

      const expectedHash = createHash("sha256")
        .update(projectDir)
        .digest("hex")
        .slice(0, 16);

      expect(dbPath).toContain(expectedHash);
      expect(dbPath).toMatch(/\.db$/);
      expect(dbPath).toContain("context-mode");
      expect(dbPath).toContain("sessions");
    });

    it("produces different paths for different project dirs", () => {
      const path1 = adapter.getSessionDBPath("/project/a");
      const path2 = adapter.getSessionDBPath("/project/b");
      expect(path1).not.toBe(path2);
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

    it("extracts tool_name from input", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
        tool_input: { filePath: "/some/file" },
      });
      expect(event.toolName).toBe("readFile");
    });

    it("extracts tool_input from input", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
        tool_input: { filePath: "/some/file" },
      });
      expect(event.toolInput).toEqual({ filePath: "/some/file" });
    });

    it("extracts sessionId from sessionId (camelCase)", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
        sessionId: "jb-sess-abc",
      });
      expect(event.sessionId).toBe("jb-sess-abc");
    });

    it("uses IDEA_INITIAL_DIRECTORY for projectDir", () => {
      process.env.IDEA_INITIAL_DIRECTORY = "/jetbrains/project";
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.projectDir).toBe("/jetbrains/project");
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

    it("formats modify with hookSpecificOutput wrapper", () => {
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
    it("wraps additionalContext in hookSpecificOutput", () => {
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

    it("wraps updatedOutput with decision:block", () => {
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

  // ── checkPluginRegistration ───────────────────────────

  describe("checkPluginRegistration", () => {
    it("returns warn status (no .idea/mcp.json in test env)", () => {
      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("warn");
      expect(result.check).toContain("registration");
    });
  });

  // ── parseSessionStartInput ────────────────────────────

  describe("parseSessionStartInput", () => {
    it("parses source field correctly", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "jb-sess",
        source: "clear",
      });
      expect(event.source).toBe("clear");
    });

    it("extracts sessionId from camelCase field", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "jb-sess-123",
      });
      expect(event.sessionId).toBe("jb-sess-123");
    });
  });
});
