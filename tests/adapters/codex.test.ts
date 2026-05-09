import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { SessionDB } from "../../src/session/db.js";

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

    it("preCompact is true", () => {
      expect(adapter.capabilities.preCompact).toBe(true);
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

    it("honors CODEX_HOME for settings, hooks, and session paths", () => {
      const savedCodexHome = process.env.CODEX_HOME;
      const codexHome = join(homedir(), "custom-codex-home");
      process.env.CODEX_HOME = codexHome;

      try {
        const customAdapter = new CodexAdapter();
        expect(customAdapter.getSettingsPath()).toBe(join(codexHome, "config.toml"));
        expect(customAdapter.getHooksPath()).toBe(join(codexHome, "hooks.json"));
        expect(customAdapter.getSessionDir()).toBe(join(codexHome, "context-mode", "sessions"));
      } finally {
        if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = savedCodexHome;
        rmSync(codexHome, { recursive: true, force: true });
      }
    });
  });

  // ── generateHookConfig ────────────────────────────────

  describe("generateHookConfig", () => {
    it("generates hooks.json with Codex-supported continuity entries", () => {
      const config = adapter.generateHookConfig("/path/to/plugin");
      expect(config).toHaveProperty("PreToolUse");
      expect(config).toHaveProperty("PostToolUse");
      expect(config).toHaveProperty("PreCompact");
      expect(config).toHaveProperty("SessionStart");
      expect(config).toHaveProperty("UserPromptSubmit");
      expect(config).toHaveProperty("Stop");
      expect(config.PreToolUse[0]?.matcher).toContain("apply_patch");
      expect(config.PreToolUse[0]?.matcher).toContain("Edit");
      expect(config.PreToolUse[0]?.matcher).toContain("Write");
      expect(config.PreToolUse[0]?.matcher).toContain("mcp__.*__ctx_execute");
      expect(config.PreToolUse[0]?.matcher).toContain("mcp__.*__ctx_batch_execute");
      expect(config.PreToolUse[0]?.matcher).not.toMatch(/(^|\|)Read(\||$)/);
      expect(config.PreToolUse[0]?.matcher).not.toContain("mcp__plugin_context-mode_context-mode__");
      expect(config.PreCompact[0]?.hooks[0]?.command).toBe("context-mode hook codex precompact");
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
      expect(changes.some((change) => change.includes("Enabled Codex hooks feature flag"))).toBe(true);
      expect(written.hooks.PreToolUse[0]?.matcher).toContain("mcp__.*__ctx_execute");
      expect(written.hooks.PreToolUse[0]?.matcher).not.toMatch(/(^|\|)Read(\||$)/);
      expect(written.hooks.PreToolUse[0]?.matcher).not.toContain("mcp__plugin_context-mode_context-mode__");
      expect(written.hooks.PreCompact[0]?.hooks[0]?.command).toBe("context-mode hook codex precompact");
      expect(written.hooks.Stop[0]?.hooks[0]?.command).toBe("context-mode hook codex stop");
      expect(readFileSync(join(codexDir, "config.toml"), "utf-8")).toContain("hooks = true");
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
        "PreCompact",
        "PreToolUse",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
      ]);
    });

    it("backs up malformed hooks.json before replacing it", () => {
      const malformed = "{ invalid json";
      writeFileSync(hooksPath, malformed, "utf-8");

      const changes = adapter.configureAllHooks("/ignored/plugin/root");
      const backupName = readdirSync(codexDir).find((name) =>
        name.startsWith("hooks.json.broken-") && name.endsWith(".bak"),
      );

      expect(backupName).toBeDefined();
      expect(readFileSync(join(codexDir, backupName!), "utf-8")).toBe(malformed);
      expect(changes.some((change) => change.includes("Backed up malformed Codex hooks"))).toBe(true);
      expect(JSON.parse(readFileSync(hooksPath, "utf-8")).hooks.PreCompact).toBeDefined();
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

    it("backs up both hooks.json and config.toml when both exist", () => {
      writeFileSync(hooksPath, JSON.stringify({ hooks: {} }), "utf-8");
      const settingsPath = join(codexDir, "config.toml");
      writeFileSync(settingsPath, "[features]\nhooks = false\n", "utf-8");

      expect(adapter.backupSettings()).toBe(`${hooksPath}.bak`);
      expect(readFileSync(`${hooksPath}.bak`, "utf-8")).toContain('"hooks"');
      expect(readFileSync(`${settingsPath}.bak`, "utf-8")).toContain("hooks = false");
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
      expect(results.some((result) => result.status === "fail" && result.check === "Hooks config")).toBe(true);
      expect(results.some((result) => result.check === "Codex hooks feature flag")).toBe(true);
    });

    it("passes when all required Codex hooks are configured", () => {
      adapter.configureAllHooks("/ignored/plugin/root");
      const results = adapter.validateHooks("/ignored/plugin/root");
      expect(results.every((result) => result.status === "pass")).toBe(true);
      expect(results.map((result) => result.check)).toContain("PreCompact hook");
      expect(results.map((result) => result.check)).toContain("UserPromptSubmit hook");
      expect(results.map((result) => result.check)).toContain("Stop hook");
    });

    it("warns instead of failing when only PreCompact is missing", () => {
      const hooks = adapter.generateHookConfig("/ignored/plugin/root");
      delete (hooks as Partial<typeof hooks>).PreCompact;
      writeFileSync(hooksPath, JSON.stringify({ hooks }, null, 2), "utf-8");
      writeFileSync(join(codexDir, "config.toml"), "[features]\nhooks = true\n", "utf-8");

      const results = adapter.validateHooks("/ignored/plugin/root");
      const precompact = results.find((result) => result.check === "PreCompact hook");
      expect(precompact?.status).toBe("warn");
      expect(results.filter((result) => result.status === "fail")).toHaveLength(0);
    });

    it("fails when hooks.json is malformed JSON", () => {
      writeFileSync(hooksPath, "{ invalid json", "utf-8");

      const results = adapter.validateHooks("/ignored/plugin/root");

      expect(results.some((result) => result.status === "fail" && result.message.includes("not valid JSON"))).toBe(true);
    });

    it("fails with a read error message when hooks.json cannot be read", () => {
      mkdirSync(hooksPath, { recursive: true });

      const results = adapter.validateHooks("/ignored/plugin/root");

      expect(results.some((result) => result.status === "fail" && result.message.includes("Could not read"))).toBe(true);
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
      expect(results.some((result) => result.check === "PreToolUse hook")).toBe(true);
    });

    it("fails when top-level hooks uses an invalid schema", () => {
      writeFileSync(hooksPath, JSON.stringify({
        hooks: [],
      }, null, 2), "utf-8");

      const results = adapter.validateHooks("/ignored/plugin/root");

      expect(results.some((result) => result.status === "fail")).toBe(true);
      expect(results.some((result) => result.check === "PreToolUse hook")).toBe(true);
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

describe("Codex precompact hook script", () => {
  it("persists a resume snapshot, compact count, and compaction summary", () => {
    const hookScript = resolve(__dirname, "../../hooks/codex/precompact.mjs");
    const codexHome = mkdtempSync(join(tmpdir(), "context-mode-codex-home-"));
    const projectDir = join(codexHome, "project");
    const sessionId = "test-precompact";
    const savedCodexHome = process.env.CODEX_HOME;

    mkdirSync(projectDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    try {
      const dbPath = new CodexAdapter().getSessionDBPath(projectDir);
      const db = new SessionDB({ dbPath });
      db.ensureSession(sessionId, projectDir);
      db.insertEvent(sessionId, {
        type: "file_edit",
        category: "file",
        data: "Edited src/app.ts",
        priority: 2,
      }, "PostToolUse");
      db.close();

      const stdout = execFileSync(process.execPath, [hookScript], {
        input: JSON.stringify({
          session_id: sessionId,
          cwd: projectDir,
          hook_event_name: "PreCompact",
          source: "compact",
        }),
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env, CODEX_HOME: codexHome },
      });

      expect(JSON.parse(stdout.trim())).toEqual({});

      const verifyDb = new SessionDB({ dbPath });
      const resume = verifyDb.getResume(sessionId);
      const compactCount = verifyDb.getSessionStats(sessionId)?.compact_count;
      const hasCompactionSummary = verifyDb
        .getEvents(sessionId)
        .some((event) => event.category === "compaction");
      verifyDb.close();

      expect(resume?.snapshot).toContain("<session_resume");
      expect(resume?.snapshot).toContain("app.ts");
      expect(resume?.event_count).toBe(1);
      expect(compactCount).toBe(1);
      expect(hasCompactionSummary).toBe(true);
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles late */ }
    }
  });
});

describe("Codex sessionstart hook script", () => {
  it("injects a compact resume snapshot before marking it consumed", () => {
    const hookScript = resolve(__dirname, "../../hooks/codex/sessionstart.mjs");
    const codexHome = mkdtempSync(join(tmpdir(), "context-mode-codex-home-"));
    const projectDir = join(codexHome, "project");
    const sessionId = "test-sessionstart-compact";
    const snapshot = "<session_resume><task_state>restore me</task_state></session_resume>";
    const savedCodexHome = process.env.CODEX_HOME;

    mkdirSync(projectDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    try {
      const dbPath = new CodexAdapter().getSessionDBPath(projectDir);
      const db = new SessionDB({ dbPath });
      db.ensureSession(sessionId, projectDir);
      db.upsertResume(sessionId, snapshot, 1);
      db.close();

      const stdout = execFileSync(process.execPath, [hookScript], {
        input: JSON.stringify({
          session_id: sessionId,
          cwd: projectDir,
          hook_event_name: "SessionStart",
          source: "compact",
        }),
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env, CODEX_HOME: codexHome },
      });

      const parsed = JSON.parse(stdout.trim());
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("restore me");

      const verifyDb = new SessionDB({ dbPath });
      const consumed = verifyDb.getResume(sessionId)?.consumed;
      verifyDb.close();
      expect(consumed).toBe(1);
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles late */ }
    }
  });
});
