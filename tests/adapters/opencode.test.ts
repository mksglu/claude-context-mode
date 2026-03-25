import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCodeAdapter } from "../../src/adapters/opencode/index.js";

describe("OpenCodeAdapter", () => {
  let adapter: OpenCodeAdapter;

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("sessionStart is true", () => {
      expect(adapter.capabilities.sessionStart).toBe(true);
    });

    it("canInjectSessionContext is false", () => {
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
    });

    it("preToolUse and postToolUse are true", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
    });

    it("paradigm is ts-plugin", () => {
      expect(adapter.paradigm).toBe("ts-plugin");
    });
  });

  // ── parsePreToolUseInput ──────────────────────────────

  describe("parsePreToolUseInput", () => {
    it("extracts sessionId from sessionID (camelCase)", () => {
      const event = adapter.parsePreToolUseInput({
        tool: "shell",
        sessionID: "oc-session-123",
      });
      expect(event.sessionId).toBe("oc-session-123");
    });

    it("projectDir falls back to cwd when no OPENCODE_PROJECT_DIR", () => {
      const event = adapter.parsePreToolUseInput({
        tool: "shell",
      });
      expect(event.projectDir).toBe(process.cwd());
    });

    it("extracts toolName from tool", () => {
      const event = adapter.parsePreToolUseInput({
        tool: "read_file",
        args: { path: "/some/file" },
      });
      expect(event.toolName).toBe("read_file");
    });

    it("falls back to pid when no sessionID", () => {
      const event = adapter.parsePreToolUseInput({
        tool: "shell",
      });
      expect(event.sessionId).toBe(`pid-${process.ppid}`);
    });
  });

  // ── formatPreToolUseResponse ──────────────────────────

  describe("formatPreToolUseResponse", () => {
    it("throws Error for deny decision", () => {
      expect(() =>
        adapter.formatPreToolUseResponse({
          decision: "deny",
          reason: "Blocked",
        }),
      ).toThrow("Blocked");
    });

    it("throws Error with default message when no reason for deny", () => {
      expect(() =>
        adapter.formatPreToolUseResponse({
          decision: "deny",
        }),
      ).toThrow("Blocked by context-mode hook");
    });

    it("returns args object for modify", () => {
      const updatedInput = { command: "echo hi" };
      const result = adapter.formatPreToolUseResponse({
        decision: "modify",
        updatedInput,
      });
      expect(result).toEqual({ args: updatedInput });
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
    it("formats updatedOutput as output field", () => {
      const result = adapter.formatPostToolUseResponse({
        updatedOutput: "New output",
      });
      expect(result).toEqual({ output: "New output" });
    });

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

    it("extracts sessionId from sessionID", () => {
      const event = adapter.parseSessionStartInput({ sessionID: "oc-123" });
      expect(event.sessionId).toBe("oc-123");
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    it("settings path is opencode.json (relative)", () => {
      expect(adapter.getSettingsPath()).toBe(resolve("opencode.json"));
    });

    it("session dir is under ~/.config/opencode/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".config", "opencode", "context-mode", "sessions"),
      );
    });
  });
});
