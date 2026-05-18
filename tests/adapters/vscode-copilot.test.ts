import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { VSCodeCopilotAdapter } from "../../src/adapters/vscode-copilot/index.js";
import { HOOK_TYPES, HOOK_SCRIPTS, buildHookCommand } from "../../src/adapters/vscode-copilot/hooks.js";

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

  // ── buildHookCommand portability — Tier C lock (Issue #613) ────
  //
  // VS Code Copilot hook config lives at `.github/hooks/context-mode.json`
  // — a WORKSPACE-COMMITTED file (upstream:
  // refs/platforms/vscode-copilot/assets/prompts/skills/agent-customization/references/hooks.md
  // line 7: "Workspace (team-shared)"). Embedding absolute Windows
  // `fnm_multishells/<PID>_<TS>/node.exe` paths into a file that lands in
  // every teammate's `git status` is a categorically-unacceptable PII leak
  // AND a non-portable cross-machine config.
  //
  // The pre-`f5c9d02` shape was correct: emit the CLI dispatcher form
  // `context-mode hook vscode-copilot <event>` regardless of pluginRoot.
  // Commit `f5c9d02` (2026-03-06) added an absolute-path branch when
  // `pluginRoot` is passed; the CLI always passes pluginRoot, so the
  // dispatcher form became unreachable in production.
  //
  // Fix: drop the pluginRoot branch entirely. The CLI dispatcher form
  // works for every install pattern that has a `bin` entry on PATH
  // (npm-global, brew, asdf, nvm, volta, fnm — all wire `npm install -g`
  // through the `bin` field). For users without global install, the
  // workaround is `npm install -g context-mode` — same as every other
  // adapter that emits CLI-dispatcher commands (cursor, codex).

  describe("buildHookCommand portability (Issue #613 Tier C lock)", () => {
    it("emits CLI dispatcher form when no pluginRoot is passed", () => {
      const cmd = buildHookCommand(HOOK_TYPES.PRE_TOOL_USE);
      expect(cmd).toBe("context-mode hook vscode-copilot pretooluse");
    });

    it("emits CLI dispatcher form EVEN WHEN pluginRoot is passed (Tier C — workspace-committed)", () => {
      // The reporter's bug: configureAllHooks passes pluginRoot which used to
      // trigger the absolute-path branch and bake fnm_multishells paths into
      // .github/hooks/context-mode.json. The fix: pluginRoot is ignored for
      // emit purposes. Every commit'd hook command MUST be portable.
      const fakeAbsRoot = "/Users/test/AppData/Local/fnm_multishells/12345_67890/node_modules/context-mode";
      const cmd = buildHookCommand(HOOK_TYPES.PRE_TOOL_USE, fakeAbsRoot);
      expect(cmd).toBe("context-mode hook vscode-copilot pretooluse");
      // Belt-and-braces — explicit anti-patterns the Tier C lock forbids.
      expect(cmd).not.toContain("/Users/");
      expect(cmd).not.toContain("fnm_multishells");
      expect(cmd).not.toContain("node.exe");
      expect(cmd).not.toContain(process.execPath);
      expect(cmd).not.toContain(fakeAbsRoot);
    });

    it("emits portable form for every hook type", () => {
      for (const hookType of Object.values(HOOK_TYPES)) {
        const cmd = buildHookCommand(hookType, "/any/abs/path");
        expect(cmd.startsWith("context-mode hook vscode-copilot ")).toBe(true);
        expect(cmd).not.toContain("/any/abs/path");
      }
    });

    it("configureAllHooks writes only portable commands into .github/hooks/context-mode.json", () => {
      // End-to-end check: walk the generated hook registration and assert
      // every command is the CLI dispatcher form. Prevents the regression
      // that the configureAllHooks path's wiring of buildHookCommand was
      // the actual #613 surface.
      const reg = adapter.generateHookConfig("/any/abs/plugin/root");
      for (const entries of Object.values(reg)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(hook.command).toMatch(/^context-mode hook vscode-copilot /);
            expect(hook.command).not.toContain("/any/abs/plugin/root");
            expect(hook.command).not.toContain(process.execPath);
          }
        }
      }
    });
  });

  // ── HOOK_TYPES / HOOK_SCRIPTS parity ──────────────────

  describe("HOOK_TYPES / HOOK_SCRIPTS parity", () => {
    it("every HOOK_TYPES entry has a matching HOOK_SCRIPTS file (no orphans)", () => {
      const types = Object.values(HOOK_TYPES);
      const scriptKeys = Object.keys(HOOK_SCRIPTS);
      const missing = types.filter((t) => !scriptKeys.includes(t));
      expect(missing).toEqual([]);
      expect(types.length).toBe(scriptKeys.length);
    });

    it("does NOT declare Stop / SubagentStart / SubagentStop (orphan removal)", () => {
      const types = Object.values(HOOK_TYPES);
      expect(types).not.toContain("Stop");
      expect(types).not.toContain("SubagentStart");
      expect(types).not.toContain("SubagentStop");
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
