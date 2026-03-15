/**
 * Tests for the OpenClaw TypeScript plugin entry point.
 *
 * Tests the plugin definition object and its register() method:
 *   - Object export form: { id, name, configSchema, register(api) }
 *   - tool_call:before (routing enforcement)
 *   - tool_call:after (session event capture)
 *   - command:new (session initialization)
 *   - before_prompt_build (routing instruction injection)
 *   - context-mode context engine (compaction management)
 *   - ctx slash commands (ctx-stats, ctx-doctor, ctx-upgrade)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Mock OpenClaw API ────────────────────────────────────

interface MockHookEntry {
  event: string;
  handler: (...args: unknown[]) => unknown;
  meta: { name: string; description: string };
}

interface MockLifecycleEntry {
  event: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

interface MockContextEngine {
  id: string;
  factory: () => {
    info: { id: string; name: string; ownsCompaction: boolean };
    ingest: (data: unknown) => Promise<{ ingested: boolean }>;
    assemble: (ctx: { messages: unknown[] }) => Promise<{ messages: unknown[]; estimatedTokens: number }>;
    compact: () => Promise<{ ok: boolean; compacted: boolean }>;
  };
}

interface MockCommandEntry {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: Record<string, unknown>) => { text: string } | Promise<{ text: string }>;
}

function createMockApi() {
  const hooks: MockHookEntry[] = [];
  const lifecycle: MockLifecycleEntry[] = [];
  const contextEngines: MockContextEngine[] = [];
  const commands: MockCommandEntry[] = [];

  return {
    hooks,
    lifecycle,
    contextEngines,
    commands,
    api: {
      registerHook(
        event: string,
        handler: (...args: unknown[]) => unknown,
        meta: { name: string; description: string },
      ) {
        hooks.push({ event, handler, meta });
      },
      on(
        event: string,
        handler: (...args: unknown[]) => unknown,
        opts?: { priority?: number },
      ) {
        lifecycle.push({ event, handler, opts });
      },
      registerContextEngine(
        id: string,
        factory: () => MockContextEngine["factory"] extends () => infer R ? R : never,
      ) {
        contextEngines.push({ id, factory: factory as MockContextEngine["factory"] });
      },
      registerCommand(cmd: MockCommandEntry) {
        commands.push(cmd);
      },
    },
  };
}

/**
 * Create a plugin instance with a mock API.
 * Returns the mock API state and helper functions.
 */
async function createTestPlugin(tempDir: string) {
  // Set OPENCLAW_PROJECT_DIR so each test gets an isolated DB (unique per tempDir)
  process.env.OPENCLAW_PROJECT_DIR = tempDir;
  const { default: plugin } = await import("../src/openclaw-plugin.js");
  const mock = createMockApi();
  await plugin.register(mock.api);
  return mock;
}

// ── Tests ─────────────────────────────────────────────────

describe("OpenClawPlugin", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-test-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* cleanup best effort */ }
  });

  // ── Object export form ────────────────────────────────

  describe("object export", () => {
    it("exports object with id, name, configSchema, register", async () => {
      const { default: plugin } = await import("../src/openclaw-plugin.js");
      expect(plugin.id).toBe("context-mode");
      expect(plugin.name).toBe("Context Mode");
      expect(plugin.configSchema).toBeDefined();
      expect(plugin.configSchema.type).toBe("object");
      expect(typeof plugin.register).toBe("function");
    });

    it("configSchema has enabled property", async () => {
      const { default: plugin } = await import("../src/openclaw-plugin.js");
      expect(plugin.configSchema.properties.enabled).toBeDefined();
      expect(plugin.configSchema.properties.enabled.type).toBe("boolean");
      expect(plugin.configSchema.properties.enabled.default).toBe(true);
    });
  });

  // ── Registration ──────────────────────────────────────

  describe("registration", () => {
    it("registers before_tool_call hook via api.on()", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-before"));
      const lifecycleNames = mock.lifecycle.map((h) => h.event);
      expect(lifecycleNames).toContain("before_tool_call");
    });

    it("registers after_tool_call hook via api.on()", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-after"));
      const lifecycleNames = mock.lifecycle.map((h) => h.event);
      expect(lifecycleNames).toContain("after_tool_call");
    });

    it("registers command:new hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-new"));
      const hookNames = mock.hooks.map((h) => h.event);
      expect(hookNames).toContain("command:new");
    });

    it("registers before_prompt_build lifecycle hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-prompt"));
      const lifecycleEvents = mock.lifecycle.map((l) => l.event);
      expect(lifecycleEvents).toContain("before_prompt_build");
    });

    it("registers context-mode context engine", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-engine"));
      expect(mock.contextEngines).toHaveLength(1);
      expect(mock.contextEngines[0].id).toBe("context-mode");
    });

    it("hooks have proper metadata names", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-meta"));
      for (const hook of mock.hooks) {
        expect(hook.meta.name).toMatch(/^context-mode\./);
        expect(hook.meta.description.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Auto-reply commands ───────────────────────────────

  describe("auto-reply commands", () => {
    it("registers ctx-stats command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-stats"));
      const statsCmd = mock.commands.find((c) => c.name === "ctx-stats");
      expect(statsCmd).toBeDefined();
      expect(statsCmd!.description).toContain("statistics");
    });

    it("registers ctx-doctor command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-doctor"));
      const doctorCmd = mock.commands.find((c) => c.name === "ctx-doctor");
      expect(doctorCmd).toBeDefined();
      expect(doctorCmd!.description).toContain("diagnostics");
    });

    it("registers ctx-upgrade command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-upgrade"));
      const upgradeCmd = mock.commands.find((c) => c.name === "ctx-upgrade");
      expect(upgradeCmd).toBeDefined();
      expect(upgradeCmd!.description).toContain("Upgrade");
    });

    it("ctx-stats handler returns session stats text", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-stats-run"));
      const statsCmd = mock.commands.find((c) => c.name === "ctx-stats");
      const result = await statsCmd!.handler({});
      expect(result.text).toContain("context-mode stats");
      expect(result.text).toContain("Events captured:");
    });

    it("ctx-doctor handler returns diagnostics command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-doctor-run"));
      const doctorCmd = mock.commands.find((c) => c.name === "ctx-doctor");
      const result = await doctorCmd!.handler({});
      expect(result.text).toContain("ctx-doctor");
      expect(result.text).toContain("doctor");
    });

    it("ctx-upgrade handler returns upgrade command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-upgrade-run"));
      const upgradeCmd = mock.commands.find((c) => c.name === "ctx-upgrade");
      const result = await upgradeCmd!.handler({});
      expect(result.text).toContain("ctx-upgrade");
      expect(result.text).toContain("upgrade");
      expect(result.text).toContain("Restart");
    });
  });

  // ── before_tool_call ──────────────────────────────────

  describe("before_tool_call", () => {
    it("modifies curl commands to block them", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-curl"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");
      expect(beforeHook).toBeDefined();

      const params = { command: "curl https://example.com/data" };
      const event = { toolName: "Bash", params };

      await beforeHook!.handler(event);

      // Routing replaces the curl command with an informative echo
      expect(params.command).toMatch(/^echo /);
      expect(params.command).toContain("context-mode");
    });

    it("modifies wget commands to block them", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-wget"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");

      const params = { command: "wget https://example.com/file" };
      const event = { toolName: "Bash", params };

      await beforeHook!.handler(event);

      expect(params.command).toMatch(/^echo /);
      expect(params.command).toContain("context-mode");
    });

    it("passes through normal tool calls", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-pass"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");

      const result = await beforeHook!.handler({
        toolName: "TaskCreate",
        params: { subject: "test task" },
      });

      expect(result).toBeUndefined();
    });

    it("handles empty input gracefully", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-empty"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");

      const result = await beforeHook!.handler({});
      expect(result).toBeUndefined();
    });
  });

  // ── after_tool_call ───────────────────────────────────

  describe("after_tool_call", () => {
    it("captures file read events without throwing", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-read"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");

      await expect(
        afterHook!.handler({
          toolName: "Read",
          params: { file_path: "/test/file.ts" },
          output: "file contents here",
        }),
      ).resolves.toBeUndefined();
    });

    it("captures file write events", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-write"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");

      await expect(
        afterHook!.handler({
          toolName: "Write",
          params: { file_path: "/test/new-file.ts", content: "code" },
        }),
      ).resolves.toBeUndefined();
    });

    it("captures git events from Bash", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-git"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");

      await expect(
        afterHook!.handler({
          toolName: "Bash",
          params: { command: "git commit -m 'test'" },
          output: "[main abc1234] test",
        }),
      ).resolves.toBeUndefined();
    });

    it("handles empty input gracefully", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-empty"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");

      await expect(afterHook!.handler({})).resolves.toBeUndefined();
    });
  });

  // ── command:new ───────────────────────────────────────

  describe("command:new", () => {
    it("runs without throwing", async () => {
      const mock = await createTestPlugin(join(tempDir, "new-run"));
      const newHook = mock.hooks.find((h) => h.event === "command:new");
      expect(newHook).toBeDefined();

      await expect(newHook!.handler()).resolves.toBeUndefined();
    });
  });

  // ── before_prompt_build ───────────────────────────────

  describe("before_prompt_build", () => {
    it("returns appendSystemContext with routing instructions", async () => {
      const mock = await createTestPlugin(join(tempDir, "prompt-build"));
      const promptHook = mock.lifecycle.find(
        (l) => l.event === "before_prompt_build" && l.opts?.priority === 5,
      );
      expect(promptHook).toBeDefined();

      const result = promptHook!.handler() as { appendSystemContext: string };
      expect(result).toHaveProperty("appendSystemContext");
      expect(result.appendSystemContext).toContain("context-mode");
    });

    it("has priority 5", async () => {
      const mock = await createTestPlugin(join(tempDir, "prompt-priority"));
      const promptHook = mock.lifecycle.find(
        (l) => l.event === "before_prompt_build" && l.opts?.priority === 5,
      );
      expect(promptHook?.opts?.priority).toBe(5);
    });
  });

  // ── Context engine ────────────────────────────────────

  describe("context engine", () => {
    it("creates engine with ownsCompaction: true", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-info"));
      const engine = mock.contextEngines[0].factory();
      expect(engine.info.id).toBe("context-mode");
      expect(engine.info.name).toBe("Context Mode");
      expect(engine.info.ownsCompaction).toBe(true);
    });

    it("ingest returns { ingested: true }", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-ingest"));
      const engine = mock.contextEngines[0].factory();
      const result = await engine.ingest({});
      expect(result).toEqual({ ingested: true });
    });

    it("assemble passes through messages", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-assemble"));
      const engine = mock.contextEngines[0].factory();
      const messages = [{ role: "user", content: "hello" }];
      const result = await engine.assemble({ messages });
      expect(result.messages).toBe(messages);
      expect(result.estimatedTokens).toBe(0);
    });

    it("compact returns { ok: true, compacted: false } when no events", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-compact-empty"));
      const engine = mock.contextEngines[0].factory();
      const result = await engine.compact();
      expect(result).toEqual({ ok: true, compacted: false });
    });
  });

  // ── Integration: before + after + compact ─────────────

  describe("end-to-end flow", () => {
    it("captures events and generates compaction snapshot", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-flow"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");
      const engine = mock.contextEngines[0].factory();

      // Normal tool call passes through before hook
      await beforeHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
      });

      // After hook captures the event
      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
        output: "console.log('hello')",
      });

      // Edit event
      await afterHook!.handler({
        toolName: "Edit",
        params: { file_path: "/app/main.ts", old_string: "{}", new_string: "{ foo: 1 }" },
      });

      // Git event
      await afterHook!.handler({
        toolName: "Bash",
        params: { command: "git status" },
        output: "On branch main",
      });

      // Compacting generates snapshot
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
    });

    it("events survive session_start re-key (renameSession) with sessionKey", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-rekey"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");
      const sessionStartHook = mock.lifecycle.find((h) => h.event === "session_start");
      const engine = mock.contextEngines[0].factory();

      // First session_start establishes sessionKey
      const firstSid = randomUUID();
      await sessionStartHook!.handler({ sessionId: firstSid, sessionKey: "bot:telegram:123" });

      // Insert an event under initial session
      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
        output: "console.log('hello')",
      });

      // Simulate OpenClaw re-keying to a new session ID on gateway restart
      const newSessionId = randomUUID();
      await sessionStartHook!.handler({ sessionId: newSessionId, sessionKey: "bot:telegram:123" });

      // Events must survive: compact should find them and return compacted: true
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
    });

    it("session_start with sessionKey isolates sessions per agent", async () => {
      const sharedDir = join(tempDir, "iso-shared");

      // Agent A
      const mockA = await createTestPlugin(sharedDir);
      const sessionStartA = mockA.lifecycle.find((h) => h.event === "session_start");
      const afterHookA = mockA.lifecycle.find((h) => h.event === "after_tool_call");
      const engineA = mockA.contextEngines[0].factory();

      const sidA = randomUUID();
      await sessionStartA!.handler({ sessionId: sidA, sessionKey: "agent-a:telegram:111" });

      await afterHookA!.handler({
        toolName: "Read",
        params: { file_path: "/a.ts" },
        output: "agent A content",
      });

      // Agent B (same project dir)
      const mockB = await createTestPlugin(sharedDir);
      const sessionStartB = mockB.lifecycle.find((h) => h.event === "session_start");
      const engineB = mockB.contextEngines[0].factory();

      const sidB = randomUUID();
      await sessionStartB!.handler({ sessionId: sidB, sessionKey: "agent-b:telegram:222" });

      // Agent B has no events — isolated from Agent A
      const resultB = await engineB.compact();
      expect(resultB.compacted).toBe(false);

      // Agent A still has its events
      const resultA = await engineA.compact();
      expect(resultA.compacted).toBe(true);
    });

    it("session_start without sessionKey falls back to fresh session", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-fallback"));
      const sessionStartHook = mock.lifecycle.find((h) => h.event === "session_start");
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");
      const engine = mock.contextEngines[0].factory();

      // session_start without sessionKey — no re-key, just fresh session
      const sid = randomUUID();
      await sessionStartHook!.handler({ sessionId: sid });

      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/fallback.ts" },
        output: "fallback content",
      });

      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
    });

    it("blocked tool command is replaced before execution", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-block"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");

      const params = { command: "curl https://evil.com" };
      const event = { toolName: "Bash", params };

      // Before hook replaces the command
      await beforeHook!.handler(event);
      expect(params.command).toContain("context-mode");
    });
  });
});
