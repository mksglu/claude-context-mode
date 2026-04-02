import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OpenClawAdapter } from "../../src/adapters/openclaw/index.js";

describe("OpenClawAdapter", () => {
  let adapter: OpenClawAdapter;

  beforeEach(() => {
    adapter = new OpenClawAdapter();
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("sessionStart is true", () => {
      expect(adapter.capabilities.sessionStart).toBe(true);
    });

    it("canInjectSessionContext is true (via before_prompt_build)", () => {
      expect(adapter.capabilities.canInjectSessionContext).toBe(true);
    });

    it("preToolUse and postToolUse are true", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
    });

    it("preCompact is true (via registerContextEngine)", () => {
      expect(adapter.capabilities.preCompact).toBe(true);
    });

    it("paradigm is ts-plugin", () => {
      expect(adapter.paradigm).toBe("ts-plugin");
    });

    it("name is OpenClaw", () => {
      expect(adapter.name).toBe("OpenClaw");
    });
  });

  // ── parsePreToolUseInput ──────────────────────────────

  describe("parsePreToolUseInput", () => {
    it("extracts toolName from toolName field", () => {
      const event = adapter.parsePreToolUseInput({
        toolName: "shell",
        sessionId: "oc-session-123",
      });
      expect(event.toolName).toBe("shell");
      expect(event.sessionId).toBe("oc-session-123");
    });

    it("extracts toolName from tool_name field (fallback)", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "read_file",
        params: { path: "/some/file" },
      });
      expect(event.toolName).toBe("read_file");
      expect(event.toolInput).toEqual({ path: "/some/file" });
    });

    it("extracts params from params field", () => {
      const event = adapter.parsePreToolUseInput({
        toolName: "Bash",
        params: { command: "ls -la" },
      });
      expect(event.toolInput).toEqual({ command: "ls -la" });
    });

    it("extracts params from tool_input field (fallback)", () => {
      const event = adapter.parsePreToolUseInput({
        toolName: "Bash",
        tool_input: { command: "ls -la" },
      });
      expect(event.toolInput).toEqual({ command: "ls -la" });
    });

    it("projectDir falls back to cwd", () => {
      const event = adapter.parsePreToolUseInput({
        toolName: "shell",
      });
      expect(event.projectDir).toBe(process.cwd());
    });

    it("falls back to pid when no sessionId", () => {
      const event = adapter.parsePreToolUseInput({
        toolName: "shell",
      });
      expect(event.sessionId).toBe(`pid-${process.ppid}`);
    });
  });

  // ── parsePostToolUseInput ─────────────────────────────

  describe("parsePostToolUseInput", () => {
    it("extracts output from output field", () => {
      const event = adapter.parsePostToolUseInput({
        toolName: "Bash",
        output: "some output",
      });
      expect(event.toolOutput).toBe("some output");
    });

    it("extracts output from tool_output field (fallback)", () => {
      const event = adapter.parsePostToolUseInput({
        tool_name: "Bash",
        tool_output: "some output",
      });
      expect(event.toolOutput).toBe("some output");
    });

    it("extracts isError from isError field", () => {
      const event = adapter.parsePostToolUseInput({
        toolName: "Bash",
        isError: true,
      });
      expect(event.isError).toBe(true);
    });

    it("extracts isError from is_error field (fallback)", () => {
      const event = adapter.parsePostToolUseInput({
        tool_name: "Bash",
        is_error: true,
      });
      expect(event.isError).toBe(true);
    });
  });

  // ── formatPreToolUseResponse ──────────────────────────

  describe("formatPreToolUseResponse", () => {
    it("returns block object for deny decision", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "Blocked",
      });
      expect(result).toEqual({
        block: true,
        blockReason: "Blocked",
      });
    });

    it("returns block object with default message when no reason for deny", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
      });
      expect(result).toEqual({
        block: true,
        blockReason: "Blocked by context-mode hook",
      });
    });

    it("returns params object for modify", () => {
      const updatedInput = { command: "echo hi" };
      const result = adapter.formatPreToolUseResponse({
        decision: "modify",
        updatedInput,
      });
      expect(result).toEqual({ params: updatedInput });
    });

    it("returns block for ask decision", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "ask",
        reason: "Confirm action",
      });
      expect(result).toEqual({
        block: true,
        blockReason: "Confirm action",
      });
    });

    it("returns undefined for allow", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "allow",
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined for context decision", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "context",
        additionalContext: "Use context-mode",
      });
      expect(result).toBeUndefined();
    });
  });

  // ── formatPostToolUseResponse ─────────────────────────

  describe("formatPostToolUseResponse", () => {
    it("formats additionalContext", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "Extra info",
      });
      expect(result).toEqual({ additionalContext: "Extra info" });
    });

    it("returns undefined for empty response", () => {
      const result = adapter.formatPostToolUseResponse({});
      expect(result).toBeUndefined();
    });
  });

  // ── parseSessionStartInput ────────────────────────────

  describe("parseSessionStartInput", () => {
    it("parses startup source by default", () => {
      const event = adapter.parseSessionStartInput({});
      expect(event.source).toBe("startup");
      expect(event.projectDir).toBe(process.cwd());
    });

    it("parses compact source", () => {
      const event = adapter.parseSessionStartInput({ source: "compact" });
      expect(event.source).toBe("compact");
    });

    it("parses resume source", () => {
      const event = adapter.parseSessionStartInput({ source: "resume" });
      expect(event.source).toBe("resume");
    });

    it("parses clear source", () => {
      const event = adapter.parseSessionStartInput({ source: "clear" });
      expect(event.source).toBe("clear");
    });

    it("extracts sessionId", () => {
      const event = adapter.parseSessionStartInput({ sessionId: "oc-123" });
      expect(event.sessionId).toBe("oc-123");
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    it("settings path is openclaw.json (relative)", () => {
      expect(adapter.getSettingsPath()).toBe(resolve("openclaw.json"));
    });

    it("session dir is under ~/.openclaw/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".openclaw", "context-mode", "sessions"),
      );
    });

    it("session DB path includes project hash", () => {
      const dbPath = adapter.getSessionDBPath("/test/project");
      expect(dbPath).toContain(".openclaw");
      expect(dbPath).toContain("context-mode");
      expect(dbPath).toContain("sessions");
      expect(dbPath).toMatch(/\.db$/);
    });

    it("session events path includes project hash", () => {
      const eventsPath = adapter.getSessionEventsPath("/test/project");
      expect(eventsPath).toContain(".openclaw");
      expect(eventsPath).toMatch(/-events\.md$/);
    });
  });

  // ── Hook config generation ────────────────────────────

  describe("generateHookConfig", () => {
    it("generates hook entries for tool_call:before and tool_call:after", () => {
      const config = adapter.generateHookConfig("/fake/root");
      expect(config["tool_call:before"]).toBeDefined();
      expect(config["tool_call:after"]).toBeDefined();
      expect(config["command:new"]).toBeDefined();
    });
  });

  // ── Plugin registration check ─────────────────────────

  describe("checkPluginRegistration", () => {
    it("returns warn when no config found", () => {
      const result = adapter.checkPluginRegistration();
      expect(result.status).toMatch(/fail|warn/);
    });
  });

  // ── Upgrade ───────────────────────────────────────────

  describe("setHookPermissions", () => {
    it("returns empty array (no shell scripts needed)", () => {
      const paths = adapter.setHookPermissions("/fake/root");
      expect(paths).toEqual([]);
    });
  });
});
