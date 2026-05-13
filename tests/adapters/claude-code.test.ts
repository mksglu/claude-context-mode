import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { hashProjectDirCanonical, resolveSessionDbPath } from "../../src/session/db.js";
import { fakeHome, realHome } from "../setup-home";
import {
  PRE_TOOL_USE_MATCHERS,
  POST_TOOL_USE_MATCHERS,
  POST_TOOL_USE_MATCHER_PATTERN,
  EXTERNAL_MCP_MATCHER_PATTERN,
} from "../../src/adapters/claude-code/hooks.js";

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("has all capabilities enabled", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
      expect(adapter.capabilities.preCompact).toBe(true);
      expect(adapter.capabilities.sessionStart).toBe(true);
      expect(adapter.capabilities.canModifyArgs).toBe(true);
      expect(adapter.capabilities.canModifyOutput).toBe(true);
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

    it("extracts toolName from tool_name", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      expect(event.toolName).toBe("Bash");
    });

    it("extracts toolInput from tool_input", () => {
      const input = { command: "ls", timeout: 5000 };
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: input,
      });
      expect(event.toolInput).toEqual(input);
    });

    it("extracts sessionId from transcript_path UUID", () => {
      const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        transcript_path: `/home/user/.claude/projects/foo/${uuid}.jsonl`,
      });
      expect(event.sessionId).toBe(uuid);
    });

    it("falls back to session_id field", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        session_id: "sess-from-field",
      });
      expect(event.sessionId).toBe("sess-from-field");
    });

    it("falls back to CLAUDE_SESSION_ID env", () => {
      process.env.CLAUDE_SESSION_ID = "env-session-id";
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
      });
      expect(event.sessionId).toBe("env-session-id");
    });

    it("falls back to pid", () => {
      delete process.env.CLAUDE_SESSION_ID;
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
      });
      expect(event.sessionId).toBe(`pid-${process.ppid}`);
    });

    it("uses CLAUDE_PROJECT_DIR for projectDir", () => {
      process.env.CLAUDE_PROJECT_DIR = "/my/project";
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
      });
      expect(event.projectDir).toBe("/my/project");
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

    it("formats modify with updatedInput", () => {
      const updatedInput = { command: "ls -la" };
      const result = adapter.formatPreToolUseResponse({
        decision: "modify",
        updatedInput,
      });
      expect(result).toEqual({ updatedInput });
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
    it("formats additionalContext", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "Some extra info",
      });
      expect(result).toEqual({ additionalContext: "Some extra info" });
    });

    it("formats updatedMCPToolOutput for updatedOutput", () => {
      const result = adapter.formatPostToolUseResponse({
        updatedOutput: "New output",
      });
      expect(result).toEqual({ updatedMCPToolOutput: "New output" });
    });

    it("returns undefined for empty response", () => {
      const result = adapter.formatPostToolUseResponse({});
      expect(result).toBeUndefined();
    });

    it("includes both additionalContext and updatedMCPToolOutput when both provided", () => {
      const result = adapter.formatPostToolUseResponse({
        additionalContext: "context",
        updatedOutput: "output",
      });
      expect(result).toEqual({
        additionalContext: "context",
        updatedMCPToolOutput: "output",
      });
    });
  });

  // ── Config paths ──────────────────────────────────────

  describe("config paths", () => {
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    beforeEach(() => {
      delete process.env.CLAUDE_CONFIG_DIR;
    });
    afterEach(() => {
      if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    });

    it("settings path is ~/.claude/settings.json by default", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".claude", "settings.json"),
      );
    });

    it("settings path honors CLAUDE_CONFIG_DIR (issue #453)", () => {
      process.env.CLAUDE_CONFIG_DIR = join(fakeHome, ".config", "claude-code");
      expect(adapter.getSettingsPath()).toBe(
        join(fakeHome, ".config", "claude-code", "settings.json"),
      );
    });

    it("session dir is under ~/.claude/context-mode/sessions/ by default", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(homedir(), ".claude", "context-mode", "sessions"),
      );
    });

    it("session dir honors CLAUDE_CONFIG_DIR (issue #453)", () => {
      const customRoot = join(fakeHome, ".config", "claude-code");
      process.env.CLAUDE_CONFIG_DIR = customRoot;
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir).toBe(
        join(customRoot, "context-mode", "sessions"),
      );
    });

    it("creates session dirs under fake HOME instead of the contributor real HOME", () => {
      const sessionDir = adapter.getSessionDir();
      expect(sessionDir.startsWith(fakeHome)).toBe(true);
      expect(sessionDir.startsWith(join(realHome, ".claude", "context-mode"))).toBe(false);
    });

    // C2 narrowing: per-project DB path is composed by callers via
    // resolveSessionDbPath + adapter.getSessionDir().
    it("DB path uses canonical hash of projectDir", () => {
      const projectDir = "/my/project";
      const hash = hashProjectDirCanonical(projectDir);
      const dbPath = resolveSessionDbPath({
        projectDir,
        sessionsDir: adapter.getSessionDir(),
      });
      expect(dbPath).toBe(
        join(homedir(), ".claude", "context-mode", "sessions", `${hash}.db`),
      );
    });
  });

  // ── CLAUDE_CONFIG_DIR — additional coverage (issue #453 follow-up) ──
  //
  // PR #460 added override smoke tests for getSettingsPath / getSessionDir.
  // These cover the two remaining surfaces that also resolve under the
  // config root: the per-project session DB path and the validateHooks
  // diagnostic message. Both would silently regress to ~/.claude if a
  // future refactor inlined the path instead of routing through
  // getConfigDir() / getSettingsPath().
  describe("CLAUDE_CONFIG_DIR — DB path & diagnostic regression pins", () => {
    let savedEnv: string | undefined;
    let customDir: string;

    beforeEach(() => {
      savedEnv = process.env.CLAUDE_CONFIG_DIR;
      customDir = mkdtempSync(join(tmpdir(), "claude-config-dir-test-"));
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedEnv;
      rmSync(customDir, { recursive: true, force: true });
    });

    // C2 narrowing (2026-05): the test now composes the DB path through
    // resolveSessionDbPath + adapter.getSessionDir() — this is the SAME
    // composition production callers (server.ts, opencode plugin, hooks)
    // perform. The regression pin still holds: $CLAUDE_CONFIG_DIR must
    // route the file out of ~/.claude.
    it("DB path lands under $CLAUDE_CONFIG_DIR (not ~/.claude)", () => {
      process.env.CLAUDE_CONFIG_DIR = customDir;
      const projectDir = "/test/project";
      const hash = hashProjectDirCanonical(projectDir);
      const dbPath = resolveSessionDbPath({
        projectDir,
        sessionsDir: adapter.getSessionDir(),
      });
      expect(dbPath).toBe(
        join(customDir, "context-mode", "sessions", `${hash}.db`),
      );
      // Regression pin: session DB must NOT land under ~/.claude when
      // CLAUDE_CONFIG_DIR is set.
      expect(dbPath.startsWith(join(homedir(), ".claude") + sep)).toBe(false);
    });

    it("validateHooks failure message references the resolved settings path", () => {
      process.env.CLAUDE_CONFIG_DIR = customDir;
      // No settings.json exists under customDir → readSettings() returns null
      // → validateHooks emits the failure entry. Pin: the message must surface
      // the resolved settings path so users see where context-mode is
      // actually looking, not a stale "~/.claude/settings.json" string.
      const pluginRoot = mkdtempSync(join(tmpdir(), "plugin-root-validate-"));
      try {
        const results = adapter.validateHooks(pluginRoot);
        const failed = results.find((r) => r.status === "fail");
        expect(failed?.message).toContain(customDir);
        expect(failed?.message).not.toMatch(/^Could not read .*\/\.claude\/settings\.json$/);
      } finally {
        rmSync(pluginRoot, { recursive: true, force: true });
      }
    });
  });

  // ── validateHooks (Issue #94) ─────────────────────────

  describe("validateHooks", () => {
    let tempDir: string;
    let pluginRoot: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "claude-doctor-test-"));
      pluginRoot = mkdtempSync(join(tmpdir(), "plugin-root-test-"));
      Object.defineProperty(adapter, "getSettingsPath", {
        value: () => join(tempDir, "settings.json"),
        configurable: true,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    });

    it("returns PASS when hooks exist in plugin hooks.json but not settings.json", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
      writeFileSync(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }],
            }],
          },
        }),
      );

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("pass");
      expect(sessionStart?.status).toBe("pass");
    });

    it("returns PASS when hooks exist in .claude-plugin/hooks/hooks.json", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      mkdirSync(join(pluginRoot, ".claude-plugin", "hooks"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }],
            }],
          },
        }),
      );

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("pass");
      expect(sessionStart?.status).toBe("pass");
    });

    it("returns FAIL when hooks are in neither settings.json nor plugin hooks.json", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("fail");
      expect(sessionStart?.status).toBe("fail");
    });

    it("returns PASS when hooks exist in settings.json (existing behavior)", () => {
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "context-mode hook claude-code pretooluse" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "context-mode hook claude-code sessionstart" }],
            }],
          },
        }),
      );

      const results = adapter.validateHooks(pluginRoot);
      const preToolUse = results.find((r) => r.check === "PreToolUse hook");
      const sessionStart = results.find((r) => r.check === "SessionStart hook");
      expect(preToolUse?.status).toBe("pass");
      expect(sessionStart?.status).toBe("pass");
    });
  });

  // ── configureAllHooks — stale hook cleanup (Issue #187) ──

  describe("configureAllHooks", () => {
    let tempDir: string;
    let pluginRoot: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "claude-hooks-test-"));
      pluginRoot = mkdtempSync(join(tmpdir(), "plugin-root-hooks-"));
      // Create hook scripts in the pluginRoot so they're "valid"
      mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
      writeFileSync(join(pluginRoot, "hooks", "pretooluse.mjs"), "");
      writeFileSync(join(pluginRoot, "hooks", "sessionstart.mjs"), "");
      Object.defineProperty(adapter, "getSettingsPath", {
        value: () => join(tempDir, "settings.json"),
        configurable: true,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    });

    it("removes stale hook entries pointing to non-existent paths", () => {
      const staleRoot = "/tmp/non-existent-old-version-dir";
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${staleRoot}/hooks/sessionstart.mjs"` }],
            }],
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: `node "${staleRoot}/hooks/pretooluse.mjs"` }],
            }],
          },
        }),
      );

      const changes = adapter.configureAllHooks(pluginRoot);
      expect(changes).toContain("Removed 1 stale SessionStart hook(s)");
      expect(changes).toContain("Removed 1 stale PreToolUse hook(s)");
    });

    it("preserves non-context-mode hooks from other plugins", () => {
      const staleRoot = "/tmp/non-existent-old-version-dir";
      const otherPluginHook = {
        matcher: "Bash",
        hooks: [{ type: "command", command: "node /some/other-plugin/hooks/check.mjs" }],
      };
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              otherPluginHook,
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: `node "${staleRoot}/hooks/pretooluse.mjs"` }],
              },
            ],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const preToolUseEntries = settings.hooks.PreToolUse;
      // Should have the other plugin's hook + the fresh context-mode hook
      expect(preToolUseEntries.length).toBe(2);
      expect(preToolUseEntries[0]).toEqual(otherPluginHook);
    });

    it("handles multiple stale versions from upgrade chains", () => {
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: "",
                hooks: [{ type: "command", command: 'node "/old/path/0.9.17/hooks/sessionstart.mjs"' }],
              },
              {
                matcher: "",
                hooks: [{ type: "command", command: 'node "/old/path/1.0.50/hooks/sessionstart.mjs"' }],
              },
            ],
          },
        }),
      );

      const changes = adapter.configureAllHooks(pluginRoot);
      expect(changes).toContain("Removed 2 stale SessionStart hook(s)");
    });

    it("preserves CLI dispatcher format hooks (path-independent)", () => {
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "context-mode hook claude-code sessionstart" }],
            }],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      // Should have the dispatcher entry updated (or kept) + fresh entry
      const sessionStartEntries = settings.hooks.SessionStart;
      expect(sessionStartEntries.length).toBeGreaterThanOrEqual(1);
    });

    it("works correctly on fresh install with no existing hooks", () => {
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      const changes = adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(changes.some((c: string) => c.includes("stale"))).toBe(false);
    });

    it("skips settings.json registration when plugin hooks.json already has all required hooks", () => {
      // Plugin hooks.json has both PreToolUse and SessionStart
      mkdirSync(join(pluginRoot, ".claude-plugin", "hooks"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }],
            }],
          },
        }),
      );

      // settings.json starts empty
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({}));

      const changes = adapter.configureAllHooks(pluginRoot);

      // Should NOT have written hook entries to settings.json
      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      expect(settings.hooks?.PreToolUse).toBeUndefined();
      expect(settings.hooks?.SessionStart).toBeUndefined();
      // Should report that plugin hooks are sufficient
      expect(changes.some((c: string) => c.includes("plugin hooks.json"))).toBe(true);
    });

    it("still cleans stale entries even when plugin hooks.json is present", () => {
      const staleRoot = "/tmp/non-existent-old-version-dir";

      // Plugin hooks.json has all required hooks
      mkdirSync(join(pluginRoot, "hooks", "hooks_dir"), { recursive: true });
      writeFileSync(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }],
            }],
          },
        }),
      );

      // settings.json has stale entries
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${staleRoot}/hooks/sessionstart.mjs"` }],
            }],
          },
        }),
      );

      const changes = adapter.configureAllHooks(pluginRoot);

      // Should clean stale entries
      expect(changes).toContain("Removed 1 stale SessionStart hook(s)");
      // Should NOT re-register in settings.json
      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const sessionHooks = settings.hooks?.SessionStart;
      expect(!sessionHooks || sessionHooks.length === 0).toBe(true);
    });

    it("registers fresh hooks with correct pluginRoot paths after cleanup", () => {
      const staleRoot = "/tmp/old-version";
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${staleRoot}/hooks/sessionstart.mjs"` }],
            }],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const sessionHooks = settings.hooks.SessionStart;
      expect(sessionHooks).toHaveLength(1);
      // buildNodeCommand() normalizes all paths to forward slashes (#369, #372),
      // so compare with forward-slash pluginRoot on Windows too.
      const command = sessionHooks[0].hooks[0].command;
      expect(command).toContain(pluginRoot.replace(/\\/g, "/"));
      expect(command).toContain("sessionstart.mjs");
    });

    it("preserves co-located user hooks when removing duplicate context-mode entries (#415)", () => {
      // Plugin hooks.json covers all required hooks → triggers the "allCovered" branch
      writeFileSync(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }] }],
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }] }],
          },
        }),
      );

      // settings.json: ONE SessionStart matcher entry containing 3 user hooks AND 1 ctx-mode hook
      // (co-located in same `hooks` array — the destructive bug wipes the entire entry).
      // User hooks are shell/CLI commands without `.mjs` path → they pass safe-block existsSync filter.
      const userHook1 = { type: "command", command: "echo 'session started'" };
      const userHook2 = { type: "command", command: "my-custom-cli notify" };
      const userHook3 = { type: "command", command: "/usr/local/bin/log-session" };
      const ctxModeHook = { type: "command", command: `node "${join(pluginRoot, "hooks", "sessionstart.mjs")}"` };
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [userHook1, userHook2, ctxModeHook, userHook3],
            }],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const sessionEntries = settings.hooks?.SessionStart ?? [];
      // Entry must survive — it has 3 user hooks
      expect(sessionEntries).toHaveLength(1);
      // Inner ctx-mode hook stripped, 3 user hooks preserved in same matcher entry
      expect(sessionEntries[0].hooks).toHaveLength(3);
      expect(sessionEntries[0].hooks).toContainEqual(userHook1);
      expect(sessionEntries[0].hooks).toContainEqual(userHook2);
      expect(sessionEntries[0].hooks).toContainEqual(userHook3);
      expect(sessionEntries[0].hooks).not.toContainEqual(ctxModeHook);
    });

    it("removes context-mode entries that are alone in their matcher entry (#415 regression)", () => {
      // Plugin hooks.json covers all required hooks → triggers the "allCovered" branch
      writeFileSync(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }] }],
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }] }],
          },
        }),
      );

      // settings.json: SessionStart entry contains ONLY ctx-mode hook (no user hooks).
      // After inner-strip, entry's hooks[] is empty → entry must be pruned entirely.
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${join(pluginRoot, "hooks", "sessionstart.mjs")}"` }],
            }],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      const sessionEntries = settings.hooks?.SessionStart ?? [];
      expect(sessionEntries).toHaveLength(0);
    });

    it("removes existing valid context-mode hooks from settings.json when plugin hooks.json covers all required hooks", () => {
      // Plugin hooks.json covers all required hooks (pluginRoot already has scripts from beforeEach)
      writeFileSync(
        join(pluginRoot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs" }] }],
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs" }] }],
          },
        }),
      );

      // settings.json has VALID (non-stale) context-mode hooks — paths exist, so they won't be
      // removed by the stale-path filter. But they duplicate what hooks.json already registers,
      // causing two concurrent hook processes for every tool call (the root cause of #NNN).
      writeFileSync(
        join(tempDir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{
              matcher: "Bash|WebFetch|Read|Grep|Agent",
              hooks: [{ type: "command", command: `node "${join(pluginRoot, "hooks", "pretooluse.mjs")}"` }],
            }],
            SessionStart: [{
              matcher: "",
              hooks: [{ type: "command", command: `node "${join(pluginRoot, "hooks", "sessionstart.mjs")}"` }],
            }],
          },
        }),
      );

      adapter.configureAllHooks(pluginRoot);

      // Valid duplicate hooks should be removed — hooks.json is the source of truth
      const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"));
      expect(settings.hooks?.PreToolUse ?? []).toHaveLength(0);
      expect(settings.hooks?.SessionStart ?? []).toHaveLength(0);
    });
  });

  // ── Hook matchers (#229, #241) ────────────────────────

  describe("hook matchers (#229, #241)", () => {
    it("PRE_TOOL_USE_MATCHERS does NOT contain 'Task' (#241)", () => {
      expect(PRE_TOOL_USE_MATCHERS).not.toContain("Task");
    });

    it("PRE_TOOL_USE_MATCHERS contains 'Agent' for subagent routing", () => {
      expect(PRE_TOOL_USE_MATCHERS).toContain("Agent");
    });

    // ── External MCP routing (#529) ─────────────────────
    it("PRE_TOOL_USE_MATCHERS contains EXTERNAL_MCP_MATCHER_PATTERN (#529)", () => {
      expect(PRE_TOOL_USE_MATCHERS).toContain(EXTERNAL_MCP_MATCHER_PATTERN);
    });

    it("EXTERNAL_MCP_MATCHER_PATTERN is the literal `mcp__` substring (#529, #547 hotfix)", () => {
      // v1.0.124 used `mcp__(?!plugin_context-mode_)` — the same hooks.json
      // is bundled to Codex CLI whose Rust `regex` crate rejects look-around
      // at boot. v1.0.125 drops the lookaround on both adapters; the hook
      // BODY (`isExternalMcpTool()` in hooks/core/routing.mjs) filters
      // context-mode's own MCP tools, so semantics are preserved.
      expect(EXTERNAL_MCP_MATCHER_PATTERN).toBe("mcp__");
      expect(EXTERNAL_MCP_MATCHER_PATTERN).toMatch(/^[A-Za-z0-9_|]+$/);

      // Substring semantics: every external MCP tool name starts with `mcp__`.
      expect("mcp__slack__list_channels".startsWith(EXTERNAL_MCP_MATCHER_PATTERN)).toBe(true);
      expect("mcp__plugin_telegram__list_messages".startsWith(EXTERNAL_MCP_MATCHER_PATTERN)).toBe(true);
      // Bare non-MCP tool names do not contain the prefix.
      expect("Bash".startsWith(EXTERNAL_MCP_MATCHER_PATTERN)).toBe(false);
      expect("Read".startsWith(EXTERNAL_MCP_MATCHER_PATTERN)).toBe(false);
    });

    it("generateHookConfig includes the external MCP matcher entry (#529)", () => {
      const config = adapter.generateHookConfig("/some/plugin/root") as Record<
        string,
        Array<{ matcher: string }>
      >;
      const matchers = config.PreToolUse.map((entry) => entry.matcher);
      expect(matchers).toContain(EXTERNAL_MCP_MATCHER_PATTERN);
      // Must match the canonical list 1:1 — no drift between adapter source and
      // the runtime config object.
      expect(matchers).toEqual([...PRE_TOOL_USE_MATCHERS]);
    });

    it("generateHookConfig quotes pluginRoot so paths with spaces round-trip through extractHookScriptPath", async () => {
      // Regression: on Windows the user folder commonly contains spaces
      // (e.g. "C:\\Users\\High Ground Services\\..."). Pre-D3 we hand-rolled
      // bare `node "${pluginRoot}/hooks/X.mjs"`; without quotes the doctor's
      // extractHookScriptPath regex fell to its \S+\.mjs branch and grabbed
      // only the path tail after the last space, producing a doubled-path
      // FAIL. Post-D3 the adapter emits buildNodeCommand-shape which both
      // double-quotes the script segment AND normalizes backslashes to
      // forward slashes (#369, #372). Compare against the normalized
      // pluginRoot so the assertion holds on Windows wire shapes too.
      const { extractHookScriptPath } = await import("../../src/util/hook-config.js");
      const pluginRoot = "C:\\Users\\High Ground Services\\AppData\\Roaming\\npm\\node_modules\\context-mode";
      const normalizedRoot = pluginRoot.replace(/\\/g, "/");
      const config = adapter.generateHookConfig(pluginRoot) as Record<
        string,
        Array<{ hooks: Array<{ command: string }> }>
      >;
      const allCommands = Object.values(config)
        .flatMap((entries) => entries)
        .flatMap((entry) => entry.hooks)
        .map((hook) => hook.command);

      expect(allCommands.length).toBeGreaterThan(0);
      for (const command of allCommands) {
        const extracted = extractHookScriptPath(command);
        // Extracted path must be the full absolute path (still inside
        // pluginRoot) — never a relative tail like "Services/AppData/...".
        expect(extracted, `command did not yield extractable path: ${command}`).toBeTruthy();
        expect(extracted!.startsWith(normalizedRoot)).toBe(true);
        expect(extracted!.endsWith(".mjs")).toBe(true);
      }
    });

    // ── parseNodeCommand round-trip with buildNodeCommand (Algo-D2) ──
    //
    // buildNodeCommand emits `"<execPath>" "<scriptPath>"` (see
    // src/adapters/types.ts:332). parseNodeCommand is its inverse: any
    // string produced by buildNodeCommand round-trips back to the original
    // scriptPath. Anything that could NOT have been produced by
    // buildNodeCommand returns null — closes the #548 class where the
    // free-form regex (`\S+\.mjs` fallback in src/util/hook-config.ts:24
    // and the `node\s+"?([^"]+\.mjs)"?` fallback in
    // src/adapters/claude-code/hooks.ts:178) silently grabbed the path
    // tail after the last space and produced a doubled-path FAIL.
    it("parseNodeCommand is the strict inverse of buildNodeCommand (Algo-D2)", async () => {
      const { buildNodeCommand, parseNodeCommand } = await import(
        "../../src/adapters/types.js"
      );

      const cases = [
        "/usr/local/bin/context-mode/hooks/pretooluse.mjs",
        "C:/Users/High Ground Services/AppData/Roaming/npm/node_modules/context-mode/hooks/sessionstart.mjs",
        "/path with spaces/and-symbols!@#$%/hooks/posttooluse.mjs",
      ];
      for (const scriptPath of cases) {
        const cmd = buildNodeCommand(scriptPath);
        const parsed = parseNodeCommand(cmd);
        expect(parsed, `round-trip failed for: ${scriptPath}`).not.toBeNull();
        expect(parsed!.scriptPath).toBe(scriptPath);
        expect(parsed!.nodePath.length).toBeGreaterThan(0);
      }
    });

    it("parseNodeCommand returns null for the #548 ambiguous unquoted shape (Algo-D2)", async () => {
      const { parseNodeCommand } = await import("../../src/adapters/types.js");
      // jasonwujch's #548 wire shape — bare `node` + unquoted path with
      // spaces. buildNodeCommand could NEVER produce this (it always
      // double-quotes both args), so parseNodeCommand MUST refuse it.
      const ambiguous =
        "node C:/Users/High Ground Services/AppData/Roaming/npm/node_modules/context-mode/hooks/pretooluse.mjs";
      expect(parseNodeCommand(ambiguous)).toBeNull();
    });

    it("parseNodeCommand returns null for non-node commands (Algo-D2)", async () => {
      const { parseNodeCommand } = await import("../../src/adapters/types.js");
      // CLI dispatcher entries are path-independent — parseNodeCommand
      // is for buildNodeCommand-shaped strings only. Returning null lets
      // callers fall through to dispatcher handling without false matches.
      expect(parseNodeCommand("context-mode hook claude-code pretooluse")).toBeNull();
      expect(parseNodeCommand("")).toBeNull();
      expect(parseNodeCommand('"/usr/bin/node"')).toBeNull();
    });

    it("hook-config.extractHookScriptPath delegates to parseNodeCommand (twin collapse, Algo-D2)", async () => {
      const { extractHookScriptPath } = await import(
        "../../src/util/hook-config.js"
      );
      const { buildNodeCommand } = await import("../../src/adapters/types.js");

      // Healthy buildNodeCommand-shaped input still extracts.
      const cmd = buildNodeCommand("/install/dir/hooks/pretooluse.mjs");
      expect(extractHookScriptPath(cmd)).toBe("/install/dir/hooks/pretooluse.mjs");

      // The #548 ambiguous shape now returns null instead of grabbing
      // the path tail after the last space (the silent doubled-path
      // bug). null lets the doctor fall through to direct existsSync
      // (Algo-D1) instead of trusting the regex.
      const ambiguous =
        "node C:/Users/High Ground Services/AppData/Roaming/npm/node_modules/context-mode/hooks/pretooluse.mjs";
      expect(extractHookScriptPath(ambiguous)).toBeNull();
    });

    it("hooks.ts extractHookScriptPath delegates to parseNodeCommand (twin collapse, Algo-D2)", async () => {
      const { extractHookScriptPath: extractInHooks } = await import(
        "../../src/adapters/claude-code/hooks.js"
      );
      const { buildNodeCommand } = await import("../../src/adapters/types.js");

      const cmd = buildNodeCommand("/install/dir/hooks/sessionstart.mjs");
      expect(extractInHooks(cmd)).toBe("/install/dir/hooks/sessionstart.mjs");

      // Same ambiguous shape — both twin definitions must agree post-D2
      // so doctor + cleanup callers behave identically.
      const ambiguous =
        "node C:/Users/High Ground Services/AppData/Roaming/npm/node_modules/context-mode/hooks/pretooluse.mjs";
      expect(extractInHooks(ambiguous)).toBeNull();
    });

    // ── Algo-D3: claude-code uses buildNodeCommand for every event ──
    //
    // Pre-D3 the adapter emitted 5 raw `node "${pluginRoot}/hooks/X.mjs"`
    // template literals (src/adapters/claude-code/index.ts:115,129,140,
    // 151,162). Bare `node` made it the lone outlier among 14 adapters
    // already on `buildNodeCommand` and reintroduced the #369/#372
    // Windows MSYS PATH bug class on every hook spawn. Post-D3 every
    // event flows through buildNodeCommand; combined with Algo-D2,
    // every emit round-trips through every parse.
    it("generateHookConfig uses buildNodeCommand shape for every event (Algo-D3)", async () => {
      const { parseNodeCommand } = await import("../../src/adapters/types.js");
      const pluginRoot = "/install/dir";
      const config = adapter.generateHookConfig(pluginRoot) as Record<
        string,
        Array<{ hooks: Array<{ command: string }> }>
      >;
      const expectedScripts: Record<string, string> = {
        PreToolUse: "pretooluse.mjs",
        PostToolUse: "posttooluse.mjs",
        PreCompact: "precompact.mjs",
        UserPromptSubmit: "userpromptsubmit.mjs",
        SessionStart: "sessionstart.mjs",
      };
      for (const [eventType, script] of Object.entries(expectedScripts)) {
        const entries = config[eventType];
        expect(entries, `missing entries for ${eventType}`).toBeDefined();
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            // Round-trip: buildNodeCommand emit → parseNodeCommand parse.
            // No event may use a bare-`node` template literal anymore.
            const parsed = parseNodeCommand(hook.command);
            expect(
              parsed,
              `command for ${eventType} not buildNodeCommand-shaped: ${hook.command}`,
            ).not.toBeNull();
            expect(parsed!.scriptPath.endsWith(`/hooks/${script}`)).toBe(true);
          }
        }
      }
    });

    // ── Algo-D3.5: CI invariant — no raw `node "${...}.mjs"` in adapters ──
    //
    // Locks in D3 forever. Adapter #16 introducing a raw `node "${...`
    // template literal fails CI at build time, not at runtime when a
    // Windows user with spaces in their HOME path hits the #548 bug.
    // Algorithmic equivalent of v1.0.125's `is_exact_matcher` drift-guard:
    // one canonical primitive (buildNodeCommand) becomes the only allowed
    // emit shape; future adapter authors are forced through it.
    it("no adapter source file emits a raw `node \"${...}` template literal (Algo-D3.5)", async () => {
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");
      const repoRoot = resolve(__dirname, "..", "..");
      const adaptersDir = join(repoRoot, "src", "adapters");

      function walk(dir: string): string[] {
        const out: string[] = [];
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) out.push(...walk(full));
          else if (name.endsWith(".ts")) out.push(full);
        }
        return out;
      }

      // Match raw node template literals in either ` `${ ` (template) or
      // string-interp form: `"node "` followed by `${`. Scans the actual
      // source so adapter #16 inherits the lock automatically. Comment
      // lines (// or *) are skipped so docstrings explaining the
      // invariant don't trip it.
      const violationRe = /["'`]\s*node\s+["'`]?\$\{/;
      const isCommentLine = (line: string): boolean =>
        /^\s*(?:\/\/|\*|\/\*)/.test(line);
      const violations: string[] = [];
      for (const file of walk(adaptersDir)) {
        const src = readFileSync(file, "utf-8");
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (isCommentLine(lines[i])) continue;
          if (violationRe.test(lines[i])) {
            violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
      expect(
        violations,
        `raw \`node "\${...}\` template literal found — use buildNodeCommand:\n${violations.join("\n")}`,
      ).toEqual([]);
    });

    it("hooks/hooks.json PreToolUse matchers match PRE_TOOL_USE_MATCHERS (#529 drift guard)", () => {
      const repoRoot = resolve(__dirname, "..", "..");
      const hooksJsonPath = join(repoRoot, "hooks", "hooks.json");
      const parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as {
        hooks: { PreToolUse: Array<{ matcher: string }> };
      };
      const jsonMatchers = parsed.hooks.PreToolUse.map((entry) => entry.matcher);
      // hooks.json is the runtime source of truth consumed by Claude Code;
      // PRE_TOOL_USE_MATCHERS is the build-time source of truth used by
      // ClaudeCodeAdapter.generateHookConfig. They MUST stay in sync.
      expect(jsonMatchers).toEqual([...PRE_TOOL_USE_MATCHERS]);
    });

    it("hooks/hooks.json external MCP entry wires to pretooluse.mjs (#529)", () => {
      const repoRoot = resolve(__dirname, "..", "..");
      const hooksJsonPath = join(repoRoot, "hooks", "hooks.json");
      const parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as {
        hooks: {
          PreToolUse: Array<{
            matcher: string;
            hooks: Array<{ type: string; command: string }>;
          }>;
        };
      };
      const entry = parsed.hooks.PreToolUse.find(
        (e) => e.matcher === EXTERNAL_MCP_MATCHER_PATTERN,
      );
      expect(entry, "external-MCP matcher entry missing from hooks.json").toBeDefined();
      expect(entry!.hooks).toHaveLength(1);
      expect(entry!.hooks[0].type).toBe("command");
      // The runtime hook must point at the PreToolUse handler — losing this
      // wiring would silently disable external-MCP routing even though the
      // matcher is still present.
      expect(entry!.hooks[0].command).toContain("pretooluse.mjs");
    });

    it("POST_TOOL_USE_MATCHERS contains all tools that extractEvents handles", () => {
      const required = [
        "Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
        "TodoWrite", "TaskCreate", "TaskUpdate",
        "EnterPlanMode", "ExitPlanMode",
        "Skill", "Agent", "AskUserQuestion", "EnterWorktree",
        "mcp__",
      ];
      for (const tool of required) {
        expect(POST_TOOL_USE_MATCHERS).toContain(tool);
      }
    });

    it("POST_TOOL_USE_MATCHERS does NOT contain tools that produce zero events (#229)", () => {
      const excluded = [
        "TaskGet", "TaskList", "TaskStop", "TaskOutput",
        "ExitWorktree", "WebFetch", "WebSearch",
        "RemoteTrigger", "CronCreate", "CronDelete", "CronList",
      ];
      for (const tool of excluded) {
        expect(POST_TOOL_USE_MATCHERS).not.toContain(tool);
      }
    });

    it("POST_TOOL_USE_MATCHER_PATTERN is pipe-separated string", () => {
      expect(POST_TOOL_USE_MATCHER_PATTERN).toBe(POST_TOOL_USE_MATCHERS.join("|"));
    });
  });

  // ── getHealthChecks (Algo-D1) ─────────────────────────
  //
  // The HookAdapter contract grew an OPTIONAL `getHealthChecks(pluginRoot)`
  // (src/adapters/types.ts) returning HealthCheck[] — a uniform doctor
  // surface across 15 adapters. Default behaviour: adapters that don't
  // override return nothing. claude-code overrides with hook-script
  // existence checks that use DIRECT `existsSync(join(pluginRoot,
  // "hooks", scriptName))` — NO regex round-trip through extractHookScriptPath.
  // Closes #548 root cause: doctor never parses hook commands, so
  // ambiguous wire shapes can't yield false FAILs.
  describe("getHealthChecks (Algo-D1)", () => {
    let pluginRoot: string;

    beforeEach(() => {
      pluginRoot = mkdtempSync(join(tmpdir(), "plugin-root-healthcheck-"));
      mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
    });

    afterEach(() => {
      rmSync(pluginRoot, { recursive: true, force: true });
    });

    it("returns one HealthCheck per HOOK_SCRIPTS entry (Algo-D1)", () => {
      // All five hook scripts present on disk → all five hook-script
      // checks PASS. The check iterates HOOK_SCRIPTS keys (the canonical
      // list) so adding a new event auto-extends doctor coverage — no
      // parallel hardcoded list to maintain. Filter to hook-script
      // checks only so this test is independent of Algo-D5's appended
      // "Plugin cache integrity" entry.
      const scripts = [
        "pretooluse.mjs",
        "posttooluse.mjs",
        "precompact.mjs",
        "sessionstart.mjs",
        "userpromptsubmit.mjs",
      ];
      for (const s of scripts) writeFileSync(join(pluginRoot, "hooks", s), "");

      const checks = adapter.getHealthChecks!(pluginRoot);
      const hookChecks = checks.filter((c) => /^Hook script:/.test(c.name));
      expect(hookChecks.length).toBe(scripts.length);
      for (const c of hookChecks) {
        const result = c.check();
        expect(result.status).toBe("OK");
      }
    });

    it("reports FAIL with missing path detail when a script is absent (Algo-D1)", () => {
      // Only sessionstart.mjs present → 4 hook-script FAILs + 1 OK. The
      // FAIL detail must reference the exact missing absolute path (not
      // a regex capture artifact like ".../Services/AppData/...").
      // Filter to hook-script checks so this test is independent of
      // Algo-D5's "Plugin cache integrity" entry which can be either
      // OK or FAIL depending on bundle siblings present in the temp
      // dir at test time.
      writeFileSync(join(pluginRoot, "hooks", "sessionstart.mjs"), "");

      const checks = adapter.getHealthChecks!(pluginRoot);
      const hookResults = checks
        .filter((c) => /^Hook script:/.test(c.name))
        .map((c) => ({ name: c.name, ...c.check() }));
      const failed = hookResults.filter((r) => r.status === "FAIL");
      const ok = hookResults.filter((r) => r.status === "OK");
      expect(ok.length).toBe(1);
      expect(failed.length).toBe(4);
      for (const r of failed) {
        expect(r.detail).toContain(pluginRoot);
        expect(r.detail!.endsWith(".mjs")).toBe(true);
      }
    });

    // ── Algo-D5: doctor surfaces plugin-cache integrity ──
    //
    // The same helper start.mjs uses for fail-fast on partial installs
    // (Algo-D4 → scripts/plugin-cache-integrity.mjs::assertPluginCacheIntegrity)
    // is exposed via the doctor surface so users hitting #550 get the
    // diagnostic without restarting the MCP server. Single source of
    // truth → boot and doctor agree byte-for-byte.
    it("getHealthChecks includes a Plugin cache integrity check (Algo-D5)", () => {
      const checks = adapter.getHealthChecks!(pluginRoot);
      const integrity = checks.find((c) =>
        /Plugin cache integrity/i.test(c.name),
      );
      expect(integrity, "Plugin cache integrity check missing").toBeDefined();
    });

    it("Plugin cache integrity check FAILs when boot-critical siblings are missing (Algo-D5)", () => {
      // pluginRoot is empty (only the hooks/ dir from beforeEach exists,
      // and it is empty). The integrity check must FAIL with detail
      // listing the missing files. This is the exact same answer
      // start.mjs would give at boot — same helper, two callsites.
      const checks = adapter.getHealthChecks!(pluginRoot);
      const integrity = checks.find((c) =>
        /Plugin cache integrity/i.test(c.name),
      )!;
      const result = integrity.check();
      expect(result.status).toBe("FAIL");
      // Detail must reference the missing files so users know what's
      // broken without bouncing back to start.mjs's stderr block.
      expect(result.detail).toMatch(/server\.bundle\.mjs|cli\.bundle\.mjs/);
    });

    it("Plugin cache integrity check OKs when every required sibling exists (Algo-D5)", () => {
      // Build a tree shaped like a healthy install.
      writeFileSync(join(pluginRoot, "server.bundle.mjs"), "");
      writeFileSync(join(pluginRoot, "cli.bundle.mjs"), "");
      const hooksDir = join(pluginRoot, "hooks");
      // hooksDir already exists from beforeEach
      writeFileSync(join(hooksDir, "pretooluse.mjs"), "");
      writeFileSync(join(hooksDir, "posttooluse.mjs"), "");
      writeFileSync(join(hooksDir, "precompact.mjs"), "");
      writeFileSync(join(hooksDir, "sessionstart.mjs"), "");
      writeFileSync(join(hooksDir, "userpromptsubmit.mjs"), "");

      const checks = adapter.getHealthChecks!(pluginRoot);
      const integrity = checks.find((c) =>
        /Plugin cache integrity/i.test(c.name),
      )!;
      const result = integrity.check();
      expect(result.status).toBe("OK");
    });

    // ── #548 reproduction — direct existsSync defeats regex round-trip ──
    //
    // jasonwujch's #548 settings.json had the bare-`node` unquoted wire
    // shape `node C:/Users/High Ground Services/.../hooks/pretooluse.mjs`.
    // Post-D2 strict, extractHookScriptPath returns null for that input,
    // so any doctor path that depends on parsing a hook COMMAND can no
    // longer surface a path. Algo-D1's getHealthChecks bypasses parsing
    // entirely — it asks the adapter directly which scripts must exist
    // and joins pluginRoot + scriptName itself. As long as the actual
    // .mjs files are on disk, the check is OK regardless of what shape
    // the user's settings.json happens to hold.
    it("Algo-D1 returns OK even when settings.json holds the #548 ambiguous shape", () => {
      const scripts = [
        "pretooluse.mjs",
        "posttooluse.mjs",
        "precompact.mjs",
        "sessionstart.mjs",
        "userpromptsubmit.mjs",
      ];
      for (const s of scripts) writeFileSync(join(pluginRoot, "hooks", s), "");

      // Even if jasonwujch's settings.json had the ambiguous shape, the
      // health check does not look at settings.json — it joins
      // pluginRoot + scriptName directly. So all hook-script checks OK
      // every time. Filter to hook-script checks so the assertion is
      // independent of the integrity check (Algo-D5) which probes a
      // different sibling tree.
      const checks = adapter.getHealthChecks!(pluginRoot);
      const allHookOk = checks
        .filter((c) => /^Hook script:/.test(c.name))
        .every((c) => c.check().status === "OK");
      expect(allHookOk).toBe(true);
    });
  });

  // ── parseSessionStartInput ────────────────────────────

  describe("parseSessionStartInput", () => {
    it("parses source field correctly", () => {
      const event = adapter.parseSessionStartInput({
        session_id: "sess-1",
        source: "compact",
      });
      expect(event.source).toBe("compact");
    });

    it("defaults source to startup for unknown values", () => {
      const event = adapter.parseSessionStartInput({
        session_id: "sess-1",
        source: "something-else",
      });
      expect(event.source).toBe("startup");
    });
  });
});
