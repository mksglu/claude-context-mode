import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir, platform as osPlatform } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeDesktopAdapter } from "../../src/adapters/claude-desktop/index.js";
import { detectPlatform, getSessionDirSegments } from "../../src/adapters/detect.js";

describe("ClaudeDesktopAdapter", () => {
  let adapter: ClaudeDesktopAdapter;

  beforeEach(() => {
    adapter = new ClaudeDesktopAdapter();
  });

  // ── Identity ───────────────────────────────────────────

  describe("identity", () => {
    it("name is Claude Desktop", () => {
      expect(adapter.name).toBe("Claude Desktop");
    });

    it("paradigm is mcp-only", () => {
      expect(adapter.paradigm).toBe("mcp-only");
    });
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
  });

  // ── Parse methods (all throw) ─────────────────────────

  describe("parse methods", () => {
    it("parsePreToolUseInput throws", () => {
      expect(() => adapter.parsePreToolUseInput({})).toThrow(
        /Claude Desktop does not support hooks/,
      );
    });

    it("parsePostToolUseInput throws", () => {
      expect(() => adapter.parsePostToolUseInput({})).toThrow(
        /Claude Desktop does not support hooks/,
      );
    });

    it("parsePreCompactInput throws", () => {
      expect(() => adapter.parsePreCompactInput({})).toThrow(
        /Claude Desktop does not support hooks/,
      );
    });

    it("parseSessionStartInput throws", () => {
      expect(() => adapter.parseSessionStartInput({})).toThrow(
        /Claude Desktop does not support hooks/,
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
    it("settings path matches the host OS convention", () => {
      const expected = (() => {
        if (osPlatform() === "win32") {
          const appData =
            process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming");
          return resolve(appData, "Claude", "claude_desktop_config.json");
        }
        if (osPlatform() === "darwin") {
          return resolve(
            homedir(),
            "Library",
            "Application Support",
            "Claude",
            "claude_desktop_config.json",
          );
        }
        return resolve(
          homedir(),
          ".config",
          "Claude",
          "claude_desktop_config.json",
        );
      })();
      expect(adapter.getSettingsPath()).toBe(expected);
    });

    it("session dir is under ~/.claude-desktop/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".claude-desktop", "context-mode", "sessions"),
      );
    });

    it("session DB path contains project hash", () => {
      const dbPath = adapter.getSessionDBPath("/test/project");
      expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
      expect(dbPath).toContain(".claude-desktop");
    });

    it("session events path contains project hash with -events.md suffix", () => {
      const eventsPath = adapter.getSessionEventsPath("/test/project");
      expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
      expect(eventsPath).toContain(".claude-desktop");
    });

    it("session dir is separate from Claude Code's ~/.claude/", () => {
      const sessionDir = adapter.getSessionDir();
      const claudeCodePrefix = join(homedir(), ".claude") + "/";
      expect(sessionDir.startsWith(claudeCodePrefix)).toBe(false);
      expect(sessionDir).toContain(".claude-desktop");
    });
  });

  // ── Routing instructions ─────────────────────────────

  describe("routing instructions", () => {
    it("getRoutingInstructions returns CLAUDE.md content with MANDATORY routing rules", () => {
      const instructions = adapter.getRoutingInstructions();
      expect(instructions).toMatch(/MANDATORY routing rules/);
      expect(instructions).toMatch(/Think in Code/);
    });

    it("getInstructionFiles returns CLAUDE.md", () => {
      expect(adapter.getInstructionFiles()).toEqual(["CLAUDE.md"]);
    });
  });
});

describe("detectPlatform — Claude Desktop", () => {
  const originalOverride = process.env.CONTEXT_MODE_PLATFORM;

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.CONTEXT_MODE_PLATFORM;
    } else {
      process.env.CONTEXT_MODE_PLATFORM = originalOverride;
    }
  });

  it("detects via clientInfo.name=claude-ai (verified Claude Desktop handshake)", () => {
    delete process.env.CONTEXT_MODE_PLATFORM;
    const r = detectPlatform({ name: "claude-ai", version: "0.1.0" });
    expect(r.platform).toBe("claude-desktop");
    expect(r.confidence).toBe("high");
    expect(r.reason).toContain("claude-ai");
  });

  it("CONTEXT_MODE_PLATFORM=claude-desktop env override is accepted", () => {
    process.env.CONTEXT_MODE_PLATFORM = "claude-desktop";
    const r = detectPlatform();
    expect(r.platform).toBe("claude-desktop");
    expect(r.confidence).toBe("high");
    expect(r.reason).toContain("override");
  });
});

describe("getSessionDirSegments — claude-desktop", () => {
  it("returns [.claude-desktop] (separate from .claude)", () => {
    expect(getSessionDirSegments("claude-desktop")).toEqual([".claude-desktop"]);
  });
});
