import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    it("preToolUse is true", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
    });

    it("postToolUse is true", () => {
      expect(adapter.capabilities.postToolUse).toBe(true);
    });

    it("sessionStart is true", () => {
      expect(adapter.capabilities.sessionStart).toBe(true);
    });

    it("canModifyArgs is false (Codex does not support updatedInput)", () => {
      expect(adapter.capabilities.canModifyArgs).toBe(false);
    });

    it("canModifyOutput is false (Codex does not support updatedMCPToolOutput)", () => {
      expect(adapter.capabilities.canModifyOutput).toBe(false);
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
    it("extracts tool_name from input", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "s1",
        cwd: "/tmp",
        hook_event_name: "PreToolUse",
        model: "o3",
        permission_mode: "default",
        tool_use_id: "tu1",
        transcript_path: null,
        turn_id: "t1",
      });
      expect(event.toolName).toBe("Bash");
    });

    it("extracts session_id", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "codex-123",
        cwd: "/proj",
        hook_event_name: "PreToolUse",
        model: "o3",
        permission_mode: "default",
        tool_use_id: "tu1",
        transcript_path: null,
        turn_id: "t1",
      });
      expect(event.sessionId).toBe("codex-123");
    });

    it("extracts projectDir from cwd", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "s1",
        cwd: "/my/project",
        hook_event_name: "PreToolUse",
        model: "o3",
        permission_mode: "default",
        tool_use_id: "tu1",
        transcript_path: null,
        turn_id: "t1",
      });
      expect(event.projectDir).toBe("/my/project");
    });

    it("falls back to CODEX_PROJECT_DIR when cwd missing", () => {
      const savedCwd = process.env.CODEX_PROJECT_DIR;
      process.env.CODEX_PROJECT_DIR = "/env/project";
      try {
        const event = adapter.parsePreToolUseInput({
          tool_name: "Bash",
          tool_input: { command: "ls" },
          session_id: "s1",
          hook_event_name: "PreToolUse",
        });
        expect(event.projectDir).toBe("/env/project");
      } finally {
        if (savedCwd === undefined) delete process.env.CODEX_PROJECT_DIR;
        else process.env.CODEX_PROJECT_DIR = savedCwd;
      }
    });

    it("falls back to process.cwd() when cwd and env both missing", () => {
      const savedCwd = process.env.CODEX_PROJECT_DIR;
      delete process.env.CODEX_PROJECT_DIR;
      try {
        const event = adapter.parsePreToolUseInput({
          tool_name: "Bash",
          tool_input: { command: "ls" },
          session_id: "s1",
          hook_event_name: "PreToolUse",
        });
        expect(event.projectDir).toBe(process.cwd());
      } finally {
        if (savedCwd !== undefined) process.env.CODEX_PROJECT_DIR = savedCwd;
      }
    });

    it("post/precompact/sessionstart parsers also fall back to process.cwd()", () => {
      const savedCwd = process.env.CODEX_PROJECT_DIR;
      delete process.env.CODEX_PROJECT_DIR;
      try {
        const post = adapter.parsePostToolUseInput({ tool_name: "Bash" });
        expect(post.projectDir).toBe(process.cwd());

        const compact = adapter.parsePreCompactInput({ session_id: "s1" });
        expect(compact.projectDir).toBe(process.cwd());

        const start = adapter.parseSessionStartInput({ session_id: "s1" });
        expect(start.projectDir).toBe(process.cwd());
      } finally {
        if (savedCwd !== undefined) process.env.CODEX_PROJECT_DIR = savedCwd;
      }
    });
  });

  // ── formatPreToolUseResponse ──────────────────────────

  describe("formatPreToolUseResponse", () => {
    it("deny returns hookSpecificOutput with hookEventName and permissionDecision deny", () => {
      const resp = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "blocked",
      });
      const hso = (resp as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
      expect(hso.hookEventName).toBe("PreToolUse");
      expect(hso.permissionDecision).toBe("deny");
      expect(hso.permissionDecisionReason).toBe("blocked");
    });

    it("allow returns empty object (passthrough)", () => {
      const resp = adapter.formatPreToolUseResponse({ decision: "allow" });
      expect(resp).toEqual({});
    });
  });

  // ── parsePostToolUseInput ─────────────────────────────

  describe("parsePostToolUseInput", () => {
    it("extracts tool_response", () => {
      const event = adapter.parsePostToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_response: "hi\n",
        session_id: "s1",
        cwd: "/tmp",
        hook_event_name: "PostToolUse",
        model: "o3",
        permission_mode: "default",
        tool_use_id: "tu1",
        transcript_path: null,
        turn_id: "t1",
      });
      expect(event.toolOutput).toBe("hi\n");
    });
  });

  // ── formatPostToolUseResponse ─────────────────────────

  describe("formatPostToolUseResponse", () => {
    it("context injection returns hookEventName and additionalContext in hookSpecificOutput", () => {
      const resp = adapter.formatPostToolUseResponse({
        additionalContext: "extra info",
      });
      const hso = (resp as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
      expect(hso.hookEventName).toBe("PostToolUse");
      expect(hso.additionalContext).toBe("extra info");
    });
  });

  // ── parseSessionStartInput ────────────────────────────

  describe("parseSessionStartInput", () => {
    it("extracts source field", () => {
      const event = adapter.parseSessionStartInput({
        session_id: "s1",
        cwd: "/proj",
        hook_event_name: "SessionStart",
        model: "o3",
        permission_mode: "default",
        source: "startup",
        transcript_path: null,
      });
      expect(event.source).toBe("startup");
    });

    it("extracts session_id", () => {
      const event = adapter.parseSessionStartInput({
        session_id: "codex-456",
        cwd: "/proj",
        hook_event_name: "SessionStart",
        model: "o3",
        permission_mode: "default",
        source: "resume",
        transcript_path: null,
      });
      expect(event.sessionId).toBe("codex-456");
    });
  });

  // ── formatSessionStartResponse ──────────────────────

  describe("formatSessionStartResponse", () => {
    it("context returns hookEventName and additionalContext in hookSpecificOutput", () => {
      const resp = adapter.formatSessionStartResponse({
        context: "routing block",
      });
      const hso = (resp as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
      expect(hso.hookEventName).toBe("SessionStart");
      expect(hso.additionalContext).toBe("routing block");
    });

    it("empty context returns empty object", () => {
      const resp = adapter.formatSessionStartResponse({});
      expect(resp).toEqual({});
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    it("settings path ends with config.toml", () => {
      expect(adapter.getSettingsPath()).toContain("config.toml");
    });

    it("session dir is under ~/.codex/context-mode/sessions/", () => {
      expect(adapter.getSessionDir()).toContain(".codex");
      expect(adapter.getSessionDir()).toContain("sessions");
    });
  });

  // ── generateHookConfig ────────────────────────────────

  describe("generateHookConfig", () => {
    it("generates hooks.json with Codex-supported continuity entries", () => {
      const config = adapter.generateHookConfig("/path/to/plugin");
      expect(config).toHaveProperty("PreToolUse");
      expect(config).toHaveProperty("PostToolUse");
      expect(config).toHaveProperty("SessionStart");
      expect(config).toHaveProperty("UserPromptSubmit");
      expect(config).toHaveProperty("Stop");
      expect(config.PreToolUse[0]?.matcher).toContain("mcp__plugin_context-mode_context-mode__ctx_batch_execute");
      expect(config.UserPromptSubmit[0]?.hooks[0]?.command).toBe("context-mode hook codex userpromptsubmit");
    });
  });

  describe("configureAllHooks", () => {
    const hooksPath = join(homedir(), ".codex", "hooks.json");
    const codexDir = join(homedir(), ".codex");

    beforeEach(() => {
      rmSync(codexDir, { recursive: true, force: true });
      mkdirSync(codexDir, { recursive: true });
    });

    it("writes the native Codex hooks file with the scoped PreToolUse matcher", () => {
      const changes = adapter.configureAllHooks("/ignored/plugin/root");
      const written = JSON.parse(readFileSync(hooksPath, "utf-8")) as {
        hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
      };

      expect(changes.some((change) => change.includes("Added PreToolUse hook"))).toBe(true);
      expect(changes.some((change) => change.includes("Wrote native Codex hooks"))).toBe(true);
      expect(written.hooks.PreToolUse[0]?.matcher).toContain("mcp__plugin_context-mode_context-mode__ctx_execute");
      expect(written.hooks.Stop[0]?.hooks[0]?.command).toBe("context-mode hook codex stop");
    });

    it("preserves unrelated hook entries while updating context-mode hooks", () => {
      writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "", hooks: [{ type: "command", command: "node /tmp/context-mode/hooks/pretooluse.mjs" }] },
          ],
          SessionStart: [
            { hooks: [{ type: "command", command: "context-mode hook codex sessionstart" }] },
            { matcher: "startup|resume", hooks: [{ type: "command", command: "node C:/tools/extra-hook.js" }] },
          ],
        },
      }, null, 2));

      adapter.configureAllHooks("/ignored/plugin/root");

      const written = JSON.parse(readFileSync(hooksPath, "utf-8")) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
      };
      expect(written.hooks.PreToolUse[0]?.matcher).toContain("local_shell|shell|shell_command");
      expect(written.hooks.SessionStart).toHaveLength(2);
      expect(written.hooks.SessionStart[1]?.hooks[0]?.command).toBe("node C:/tools/extra-hook.js");
    });

    it("creates ~/.codex/hooks.json when the parent directory is missing", () => {
      rmSync(codexDir, { recursive: true, force: true });

      adapter.configureAllHooks("/ignored/plugin/root");

      expect(existsSync(hooksPath)).toBe(true);
      const written = JSON.parse(readFileSync(hooksPath, "utf-8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };

      expect(Object.keys(written.hooks).sort()).toEqual([
        "PostToolUse",
        "PreToolUse",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
      ]);
    });

    it("does not overwrite malformed hooks.json", () => {
      const malformed = "{ invalid json";
      writeFileSync(hooksPath, malformed, "utf-8");

      expect(() => adapter.configureAllHooks("/ignored/plugin/root")).toThrow(
        "Failed to update ~/.codex/hooks.json",
      );
      expect(readFileSync(hooksPath, "utf-8")).toBe(malformed);
    });

    it("does not crash on schema-invalid entries with non-array hooks", () => {
      writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "", hooks: "not-an-array" },
            null,
          ],
        },
      }, null, 2), "utf-8");

      expect(() => adapter.configureAllHooks("/ignored/plugin/root")).not.toThrow();
      const written = JSON.parse(readFileSync(hooksPath, "utf-8")) as {
        hooks: Record<string, Array<{ hooks: unknown }>>;
      };
      expect(Array.isArray(written.hooks.PreToolUse)).toBe(true);
    });

    it("does not crash when top-level hooks is not an object", () => {
      writeFileSync(hooksPath, JSON.stringify({
        hooks: [],
      }, null, 2), "utf-8");

      expect(() => adapter.configureAllHooks("/ignored/plugin/root")).not.toThrow();
      const written = JSON.parse(readFileSync(hooksPath, "utf-8")) as {
        hooks: Record<string, unknown>;
      };
      expect(typeof written.hooks).toBe("object");
      expect(Array.isArray(written.hooks.PreToolUse)).toBe(true);
    });
  });

  describe("validateHooks", () => {
    const hooksPath = join(homedir(), ".codex", "hooks.json");
    const codexDir = join(homedir(), ".codex");

    beforeEach(() => {
      rmSync(codexDir, { recursive: true, force: true });
      mkdirSync(codexDir, { recursive: true });
    });

    it("fails when hooks.json is missing", () => {
      const results = adapter.validateHooks("/ignored/plugin/root");
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("fail");
      expect(results[0]?.check).toBe("Hooks config");
    });

    it("passes when all required Codex hooks are configured", () => {
      adapter.configureAllHooks("/ignored/plugin/root");
      const results = adapter.validateHooks("/ignored/plugin/root");
      expect(results.every((result) => result.status === "pass")).toBe(true);
      expect(results.map((result) => result.check)).toContain("UserPromptSubmit hook");
      expect(results.map((result) => result.check)).toContain("Stop hook");
    });

    it("fails when hooks.json is malformed JSON", () => {
      writeFileSync(hooksPath, "{ invalid json", "utf-8");

      const results = adapter.validateHooks("/ignored/plugin/root");

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("fail");
      expect(results[0]?.message).toContain("not valid JSON");
    });

    it("fails with a read error message when hooks.json cannot be read", () => {
      mkdirSync(hooksPath, { recursive: true });

      const results = adapter.validateHooks("/ignored/plugin/root");

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("fail");
      expect(results[0]?.message).toContain("Could not read ~/.codex/hooks.json");
    });

    it("fails when hooks.json entries use an invalid schema", () => {
      writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "", hooks: "not-an-array" },
            null,
          ],
        },
      }, null, 2), "utf-8");

      const results = adapter.validateHooks("/ignored/plugin/root");

      expect(results.some((result) => result.status === "fail")).toBe(true);
      expect(results[0]?.check).toBe("PreToolUse hook");
    });

    it("fails when top-level hooks uses an invalid schema", () => {
      writeFileSync(hooksPath, JSON.stringify({
        hooks: [],
      }, null, 2), "utf-8");

      const results = adapter.validateHooks("/ignored/plugin/root");

      expect(results.some((result) => result.status === "fail")).toBe(true);
      expect(results[0]?.check).toBe("PreToolUse hook");
    });
  });
});

// ── Hook script integration tests ──────────────────────
describe("Codex pretooluse hook script", () => {
  it("outputs valid JSON with hookEventName even for passthrough (no routing match)", () => {
    const hookScript = resolve(__dirname, "../../hooks/codex/pretooluse.mjs");
    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "test-1",
      cwd: "/tmp",
      hook_event_name: "PreToolUse",
      model: "o3",
      permission_mode: "default",
      tool_use_id: "tu1",
      transcript_path: null,
      turn_id: "t1",
    });

    const stdout = execFileSync(process.execPath, [hookScript], {
      input,
      encoding: "utf-8",
      timeout: 10000,
    });

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });
});

describe("Codex userpromptsubmit hook script", () => {
  it("outputs valid JSON with UserPromptSubmit hookEventName", () => {
    const hookScript = resolve(__dirname, "../../hooks/codex/userpromptsubmit.mjs");
    const input = JSON.stringify({
      session_id: "test-userprompt",
      cwd: "/tmp",
      hook_event_name: "UserPromptSubmit",
      model: "o3",
      permission_mode: "default",
      prompt: "remember this decision",
      transcript_path: null,
      turn_id: "t1",
    });

    const stdout = execFileSync(process.execPath, [hookScript], {
      input,
      encoding: "utf-8",
      timeout: 10000,
    });

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });
});

describe("Codex stop hook script", () => {
  it("outputs valid JSON without requesting continuation", () => {
    const hookScript = resolve(__dirname, "../../hooks/codex/stop.mjs");
    const input = JSON.stringify({
      session_id: "test-stop",
      cwd: "/tmp",
      hook_event_name: "Stop",
      model: "o3",
      permission_mode: "default",
      last_assistant_message: "done",
      stop_hook_active: false,
      transcript_path: null,
      turn_id: "t1",
    });

    const stdout = execFileSync(process.execPath, [hookScript], {
      input,
      encoding: "utf-8",
      timeout: 10000,
    });

    expect(JSON.parse(stdout.trim())).toEqual({});
  });
});
