import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../../src/adapters/codex/index.js";

describe("CodexAdapter", () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("all capabilities are false", () => {
      expect(adapter.capabilities.preToolUse).toBe(false);
      expect(adapter.capabilities.postToolUse).toBe(false);
      expect(adapter.capabilities.preCompact).toBe(false);
      expect(adapter.capabilities.sessionStart).toBe(false);
      expect(adapter.capabilities.canModifyArgs).toBe(false);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
    });

    it("paradigm is mcp-only", () => {
      expect(adapter.paradigm).toBe("mcp-only");
    });
  });

  // ── Parse methods (all throw) ─────────────────────────

  describe("parse methods", () => {
    it("parsePreToolUseInput throws", () => {
      expect(() => adapter.parsePreToolUseInput({})).toThrow(
        /Codex CLI does not support hooks/,
      );
    });

    it("parsePostToolUseInput throws", () => {
      expect(() => adapter.parsePostToolUseInput({})).toThrow(
        /Codex CLI does not support hooks/,
      );
    });

    it("parsePreCompactInput throws", () => {
      expect(() => adapter.parsePreCompactInput({})).toThrow(
        /Codex CLI does not support hooks/,
      );
    });

    it("parseSessionStartInput throws", () => {
      expect(() => adapter.parseSessionStartInput({})).toThrow(
        /Codex CLI does not support hooks/,
      );
    });
  });

  // ── Format methods (all return undefined) ─────────────

  describe("format methods", () => {
    it("formatPreToolUseResponse returns undefined", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "test",
      });
      expect(result).toBeUndefined();
    });

    it("formatPostToolUseResponse returns undefined", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "test",
      });
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

  // ── Hook config (all empty) ───────────────────────────

  describe("hook config", () => {
    it("generateHookConfig returns empty object", () => {
      const config = adapter.generateHookConfig("/some/plugin/root");
      expect(config).toEqual({});
    });

    it("configureAllHooks returns empty array", () => {
      const changes = adapter.configureAllHooks("/some/plugin/root");
      expect(changes).toEqual([]);
    });

    it("setHookPermissions returns empty array", () => {
      const set = adapter.setHookPermissions("/some/plugin/root");
      expect(set).toEqual([]);
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    it("settings path is ~/.codex/config.toml", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".codex", "config.toml"),
      );
    });

    it("session dir is under ~/.codex/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".codex", "context-mode", "sessions"),
      );
    });
  });
});
