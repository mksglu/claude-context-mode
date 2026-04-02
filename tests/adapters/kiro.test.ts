import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";

describe("KiroAdapter", () => {
  let adapter: KiroAdapter;

  beforeEach(() => {
    adapter = new KiroAdapter();
  });

  // ── Identity ───────────────────────────────────────────

  describe("identity", () => {
    it("name is Kiro", () => {
      expect(adapter.name).toBe("Kiro");
    });

    it("paradigm is json-stdio", () => {
      expect(adapter.paradigm).toBe("json-stdio");
    });
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("supports preToolUse and postToolUse", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
    });

    it("does not support preCompact or sessionStart", () => {
      expect(adapter.capabilities.preCompact).toBe(false);
      expect(adapter.capabilities.sessionStart).toBe(false);
    });

    it("cannot modify args or output", () => {
      expect(adapter.capabilities.canModifyArgs).toBe(false);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
    });
  });

  // ── Parse methods ─────────────────────────────────────

  describe("parse methods", () => {
    it("parsePreToolUseInput extracts tool_name and tool_input", () => {
      const result = adapter.parsePreToolUseInput({
        hook_event_name: "preToolUse",
        cwd: "/test/project",
        tool_name: "fs_read",
        tool_input: { path: "/test/file.ts" },
      });
      expect(result.toolName).toBe("fs_read");
      expect(result.toolInput).toEqual({ path: "/test/file.ts" });
      expect(result.projectDir).toBe("/test/project");
    });

    it("parsePostToolUseInput extracts tool_response", () => {
      const result = adapter.parsePostToolUseInput({
        hook_event_name: "postToolUse",
        cwd: "/test/project",
        tool_name: "execute_bash",
        tool_input: { command: "ls" },
        tool_response: { success: true, result: ["file1.ts"] },
      });
      expect(result.toolName).toBe("execute_bash");
      expect(result.toolOutput).toContain("success");
    });

    it("parsePreCompactInput throws", () => {
      expect(() => adapter.parsePreCompactInput({})).toThrow(
        /Kiro does not support PreCompact/,
      );
    });

    it("parseSessionStartInput throws", () => {
      expect(() => adapter.parseSessionStartInput({})).toThrow(
        /Kiro does not support SessionStart/,
      );
    });
  });

  // ── Format methods ─────────────────────────────────────

  describe("format methods", () => {
    it("formatPreToolUseResponse returns exitCode 2 for deny", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "blocked",
      });
      expect(result).toEqual({ exitCode: 2, stderr: "blocked" });
    });

    it("formatPreToolUseResponse returns exitCode 0 for context", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "context",
        additionalContext: "use sandbox",
      });
      expect(result).toEqual({ exitCode: 0, stdout: "use sandbox" });
    });

    it("formatPreToolUseResponse returns undefined for allow", () => {
      const result = adapter.formatPreToolUseResponse({ decision: "allow" });
      expect(result).toBeUndefined();
    });

    it("formatPostToolUseResponse returns undefined", () => {
      const result = adapter.formatPostToolUseResponse({ additionalContext: "test" });
      expect(result).toBeUndefined();
    });

    it("formatPreCompactResponse returns undefined", () => {
      const result = adapter.formatPreCompactResponse({
        context: "test",
      });
      expect(result).toBeUndefined();
    });

    it("formatSessionStartResponse returns undefined", () => {
      const result = adapter.formatSessionStartResponse({
        context: "test",
      });
      expect(result).toBeUndefined();
    });
  });

  // ── Hook config ───────────────────────────────────────

  describe("hook config", () => {
    it("generateHookConfig returns preToolUse and postToolUse entries", () => {
      const config = adapter.generateHookConfig("/some/plugin/root");
      expect(config).toHaveProperty("preToolUse");
      expect(config).toHaveProperty("postToolUse");
    });

    it("generateHookConfig commands point to kiro hook scripts", () => {
      const config = adapter.generateHookConfig("/some/plugin/root");
      const preEntries = config["preToolUse"] as Array<{ hooks: Array<{ command: string }> }>;
      expect(preEntries[0].hooks[0].command).toContain("kiro/pretooluse.mjs");
    });

    it("setHookPermissions returns empty array", () => {
      const set = adapter.setHookPermissions("/some/plugin/root");
      expect(set).toEqual([]);
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    it("settings path is ~/.kiro/settings/mcp.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".kiro", "settings", "mcp.json"),
      );
    });

    it("session dir is under ~/.kiro/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".kiro", "context-mode", "sessions"),
      );
    });

    it("session DB path contains project hash", () => {
      const dbPath = adapter.getSessionDBPath("/test/project");
      expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
      expect(dbPath).toContain(".kiro");
    });

    it("session events path contains project hash with -events.md suffix", () => {
      const eventsPath = adapter.getSessionEventsPath("/test/project");
      expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
      expect(eventsPath).toContain(".kiro");
    });
  });

});
