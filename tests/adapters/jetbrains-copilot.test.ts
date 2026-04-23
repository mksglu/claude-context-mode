import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { JetBrainsCopilotAdapter } from "../../src/adapters/jetbrains-copilot/index.js";

describe("JetBrainsCopilotAdapter", () => {
  let adapter: JetBrainsCopilotAdapter;

  beforeEach(() => {
    adapter = new JetBrainsCopilotAdapter();
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

    it("name is 'JetBrains Copilot'", () => {
      expect(adapter.name).toBe("JetBrains Copilot");
    });
  });

  // ── parsePreToolUseInput ──────────────────────────────

  describe("parsePreToolUseInput", () => {
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      savedEnv = { ...process.env };
      delete process.env.JETBRAINS_CLIENT_ID;
      delete process.env.IDEA_INITIAL_DIRECTORY;
      delete process.env.IDEA_HOME;
      delete process.env.CLAUDE_PROJECT_DIR;
    });

    afterEach(() => {
      process.env = savedEnv;
    });

    it("extracts sessionId from sessionId (camelCase NOT session_id)", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
        sessionId: "jb-sess-abc",
      });
      expect(event.sessionId).toBe("jb-sess-abc");
    });

    it("does not extract sessionId from session_id (snake_case)", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
        session_id: "should-not-use-this",
      });
      expect(event.sessionId).not.toBe("should-not-use-this");
    });

    it("prefixes JETBRAINS_CLIENT_ID with 'jetbrains-' for sessionId fallback", () => {
      process.env.JETBRAINS_CLIENT_ID = "42";
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.sessionId).toBe("jetbrains-42");
    });

    it("uses 'idea-<pid>' when only IDEA_HOME is set", () => {
      process.env.IDEA_HOME = "/Applications/IntelliJ IDEA.app";
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.sessionId).toBe(`idea-${process.pid}`);
    });

    it("falls back to 'pid-<ppid>' when no env vars are set", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.sessionId).toBe(`pid-${process.ppid}`);
    });

    it("uses IDEA_INITIAL_DIRECTORY for projectDir (primary)", () => {
      process.env.IDEA_INITIAL_DIRECTORY = "/idea/project";
      process.env.CLAUDE_PROJECT_DIR = "/claude/project";
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.projectDir).toBe("/idea/project");
    });

    it("falls back to CLAUDE_PROJECT_DIR when IDEA_INITIAL_DIRECTORY is unset", () => {
      process.env.CLAUDE_PROJECT_DIR = "/claude/project";
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.projectDir).toBe("/claude/project");
    });

    it("falls back to process.cwd() when no env vars are set", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
      });
      expect(event.projectDir).toBe(process.cwd());
    });

    it("extracts toolName from tool_name", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "jb_readFile",
        tool_input: { filePath: "/some/file" },
      });
      expect(event.toolName).toBe("jb_readFile");
    });

    it("preserves tool_input as toolInput", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "readFile",
        tool_input: { filePath: "/x.ts", lines: 100 },
      });
      expect(event.toolInput).toEqual({ filePath: "/x.ts", lines: 100 });
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

    it("formats deny with default reason when none provided", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "deny",
      });
      expect(result).toEqual({
        permissionDecision: "deny",
        reason: "Blocked by context-mode hook",
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

    it("formats context decision with hookSpecificOutput wrapper", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "context",
        additionalContext: "Be careful with /etc",
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "Be careful with /etc",
        },
      });
    });

    it("maps 'ask' to deny with explanatory reason (no interactive UI in JetBrains hooks)", () => {
      const result = adapter.formatPreToolUseResponse({
        decision: "ask",
      });
      expect(result).toEqual({
        permissionDecision: "deny",
        reason: "Action requires user confirmation (security policy)",
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
    it("settings path is .idea/mcp.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(".idea", "mcp.json"),
      );
    });

    it("session dir lives under ~/.config/JetBrains/context-mode/sessions/", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".config", "JetBrains", "context-mode", "sessions"),
      );
    });

    it("session DB path is deterministic per-project", () => {
      const projectDir = "/repo/my-project";
      const p1 = adapter.getSessionDBPath(projectDir);
      const p2 = adapter.getSessionDBPath(projectDir);
      expect(p1).toBe(p2);
      expect(p1.endsWith(".db")).toBe(true);
      expect(p1).toContain("JetBrains");
    });

    it("session events file path is deterministic and ends in -events.md", () => {
      const projectDir = "/repo/my-project";
      const p = adapter.getSessionEventsPath(projectDir);
      expect(p.endsWith("-events.md")).toBe(true);
      expect(p).toContain("JetBrains");
    });
  });

  // ── parseSessionStartInput ────────────────────────────

  describe("parseSessionStartInput", () => {
    it("parses source 'clear' correctly", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "jb-sess",
        source: "clear",
      });
      expect(event.source).toBe("clear");
    });

    it("parses source 'compact' correctly", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "jb-sess",
        source: "compact",
      });
      expect(event.source).toBe("compact");
    });

    it("parses source 'resume' correctly", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "jb-sess",
        source: "resume",
      });
      expect(event.source).toBe("resume");
    });

    it("defaults to 'startup' when source field is missing", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "jb-sess",
      });
      expect(event.source).toBe("startup");
    });

    it("defaults to 'startup' for unknown source values", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "jb-sess",
        source: "unexpected-value",
      });
      expect(event.source).toBe("startup");
    });

    it("extracts sessionId from camelCase field", () => {
      const event = adapter.parseSessionStartInput({
        sessionId: "jb-sess-123",
      });
      expect(event.sessionId).toBe("jb-sess-123");
    });
  });

  // ── generateHookConfig ────────────────────────────────

  describe("generateHookConfig", () => {
    it("registers all four hook types", () => {
      const config = adapter.generateHookConfig("/plugin/root") as Record<string, unknown>;
      expect(config).toHaveProperty("PreToolUse");
      expect(config).toHaveProperty("PostToolUse");
      expect(config).toHaveProperty("PreCompact");
      expect(config).toHaveProperty("SessionStart");
    });

    it("hook command points at hooks/jetbrains-copilot/<script>.mjs", () => {
      const config = adapter.generateHookConfig("/plugin/root") as Record<string, Array<{
        hooks: Array<{ command: string }>;
      }>>;
      const preCmd = config.PreToolUse[0].hooks[0].command;
      expect(preCmd).toContain("hooks/jetbrains-copilot/pretooluse.mjs");
      expect(preCmd).toContain("/plugin/root");
    });
  });

  // ── getInstalledVersion ───────────────────────────────

  describe("getInstalledVersion", () => {
    it("returns 'unknown' when no .idea/mcp.json exists", () => {
      expect(adapter.getInstalledVersion()).toBe("unknown");
    });
  });
});
