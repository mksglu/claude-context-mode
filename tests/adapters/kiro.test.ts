import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { KiroAdapter } from "../../src/adapters/kiro/index.js";
import { hashProjectDirCanonical, resolveSessionDbPath } from "../../src/session/db.js";
import {
  PRE_TOOL_USE_MATCHER_PATTERN,
  PRE_TOOL_USE_MATCHERS,
  HOOK_TYPES,
  HOOK_SCRIPTS,
} from "../../src/adapters/kiro/hooks.js";

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

    it("does not support preCompact (no PreCompact hook in Kiro)", () => {
      expect(adapter.capabilities.preCompact).toBe(false);
    });

    it("supports sessionStart via agentSpawn", () => {
      // Kiro maps SessionStart -> agentSpawn (fires once when agent loads).
      expect(adapter.capabilities.sessionStart).toBe(true);
      expect(adapter.capabilities.canInjectSessionContext).toBe(true);
    });

    it("cannot modify args or output (exit-code paradigm)", () => {
      expect(adapter.capabilities.canModifyArgs).toBe(false);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
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

    it("parseSessionStartInput parses agentSpawn input with default source=startup", () => {
      const result = adapter.parseSessionStartInput({
        hook_event_name: "agentSpawn",
        cwd: "/test/project",
      });
      expect(result.source).toBe("startup");
      expect(result.projectDir).toBe("/test/project");
    });

    it("parseSessionStartInput honors explicit source field", () => {
      const result = adapter.parseSessionStartInput({
        hook_event_name: "agentSpawn",
        cwd: "/test/project",
        source: "resume",
      });
      expect(result.source).toBe("resume");
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

    it("formatSessionStartResponse returns hookSpecificOutput with agentSpawn name", () => {
      const result = adapter.formatSessionStartResponse({
        context: "ROUTING_BLOCK",
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: "agentSpawn",
          additionalContext: "ROUTING_BLOCK",
        },
      });
    });

    it("formatSessionStartResponse returns undefined when no context", () => {
      const result = adapter.formatSessionStartResponse({});
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

    it("preToolUse matcher is specific, not wildcard", () => {
      const config = adapter.generateHookConfig("/some/plugin/root");
      const preEntries = config["preToolUse"] as Array<{ matcher: string }>;
      expect(preEntries[0].matcher).not.toBe("*");
      expect(preEntries[0].matcher).toBe(PRE_TOOL_USE_MATCHER_PATTERN);
      expect(preEntries[0].matcher).toContain("execute_bash");
      expect(preEntries[0].matcher).toContain("fs_read");
      expect(preEntries[0].matcher).toContain("@context-mode/ctx_execute");
    });

    it("postToolUse matcher stays wildcard for event capture", () => {
      const config = adapter.generateHookConfig("/some/plugin/root");
      const postEntries = config["postToolUse"] as Array<{ matcher: string }>;
      expect(postEntries[0].matcher).toBe("*");
    });

    it("PRE_TOOL_USE_MATCHER_PATTERN is pipe-separated string", () => {
      expect(PRE_TOOL_USE_MATCHER_PATTERN).toBe(PRE_TOOL_USE_MATCHERS.join("|"));
    });

    it("setHookPermissions returns empty array", () => {
      const set = adapter.setHookPermissions("/some/plugin/root");
      expect(set).toEqual([]);
    });

    // ── Slice Kiro-1 (Z7): userPromptSubmit wired ────────
    it("HOOK_SCRIPTS maps userPromptSubmit -> userpromptsubmit.mjs", () => {
      expect(HOOK_SCRIPTS[HOOK_TYPES.USER_PROMPT_SUBMIT]).toBe("userpromptsubmit.mjs");
    });

    it("generateHookConfig wires userPromptSubmit hook", () => {
      const config = adapter.generateHookConfig("/some/plugin/root");
      expect(config).toHaveProperty(HOOK_TYPES.USER_PROMPT_SUBMIT);
      const ups = config[HOOK_TYPES.USER_PROMPT_SUBMIT] as Array<{ hooks: Array<{ command: string }> }>;
      expect(ups[0].hooks[0].command).toContain("userpromptsubmit.mjs");
    });

    // ── Slice Kiro-2 (Z8): agentSpawn wired ──────────────
    it("HOOK_SCRIPTS maps agentSpawn -> agentspawn.mjs", () => {
      expect(HOOK_SCRIPTS[HOOK_TYPES.AGENT_SPAWN]).toBe("agentspawn.mjs");
    });

    it("generateHookConfig wires agentSpawn hook", () => {
      const config = adapter.generateHookConfig("/some/plugin/root");
      expect(config).toHaveProperty(HOOK_TYPES.AGENT_SPAWN);
      const as = config[HOOK_TYPES.AGENT_SPAWN] as Array<{ hooks: Array<{ command: string }> }>;
      expect(as[0].hooks[0].command).toContain("agentspawn.mjs");
    });
  });

  // ── Slice Kiro-3 (Z9) reverted: NO scaffold deploy ────────
  // Initial v1.0.107 SE pass deployed a 10-file generic SDD scaffold (mirror of
  // cc-sdd's project-template content). Per Mert review: those are end-user
  // project templates (api-standards, auth, database, deployment, etc.), NOT
  // adapter wiring. We ship a single context-mode-specific routing file
  // (`configs/kiro/KIRO.md`) and let users opt in by copying it manually.
  describe("steering scaffold deploy — reverted (v1.0.107)", () => {
    it("does NOT expose deploySteeringScaffold (generic SDD scaffold removed)", () => {
      expect((adapter as unknown as Record<string, unknown>).deploySteeringScaffold).toBeUndefined();
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

    // C2 narrowing: per-project DB path is computed by callers via
    // resolveSessionDbPath + adapter.getSessionDir(). Test pins that the
    // composition lands the file inside Kiro's sessionDir (~/.kiro/...).
    it("session DB path contains project hash", () => {
      const dbPath = resolveSessionDbPath({
        projectDir: "/test/project",
        sessionsDir: adapter.getSessionDir(),
      });
      expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
      expect(dbPath).toContain(".kiro");
    });

    it("session events path contains project hash with -events.md suffix", () => {
      // events.md sidecar shape mirrors server.ts/hooks: <sessionDir>/<hash>-events.md
      const eventsPath = join(
        adapter.getSessionDir(),
        `${hashProjectDirCanonical("/test/project")}-events.md`,
      );
      expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
      expect(eventsPath).toContain(".kiro");
    });
  });

});
