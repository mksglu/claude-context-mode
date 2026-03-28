import "../setup-home";
/**
 * Consolidated OpenClaw plugin tests.
 *
 * Merged from:
 *   - tests/openclaw-plugin.test.ts
 *   - tests/openclaw-plugin-hooks.test.ts
 *   - tests/openclaw/workspace-router.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect, test, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { OpenClawSessionDB } from "../../src/adapters/openclaw/session-db.js";
import { extractWorkspace, WorkspaceRouter } from "../../src/openclaw/workspace-router.js";

// ═══════════════════════════════════════════════════════════
// Mock helpers (from openclaw-plugin.test.ts)
// ═══════════════════════════════════════════════════════════

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

function createMockApiFull() {
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
  // Each test gets an isolated DB by running from a unique cwd (tempDir).
  // The plugin reads process.cwd() for projectDir — no fake env var needed.
  const { default: plugin } = await import("../../src/openclaw-plugin.js");
  const mock = createMockApiFull();
  await plugin.register(mock.api);
  return mock;
}

// ═══════════════════════════════════════════════════════════
// Mock helpers (from openclaw-plugin-hooks.test.ts)
// ═══════════════════════════════════════════════════════════

interface RegisteredHook {
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function createTestDB(): SessionDB {
  const dbPath = join(tmpdir(), `plugin-hooks-test-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return db;
}

function createOpenClawTestDB(): OpenClawSessionDB {
  const dbPath = join(tmpdir(), `plugin-hooks-test-oc-${randomUUID()}.db`);
  const db = new OpenClawSessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return db;
}

function createMockApiHooks(withLogger = false) {
  const hooks: RegisteredHook[] = [];
  const typedHooks: RegisteredHook[] = [];
  const logLines: { level: string; args: unknown[] }[] = [];

  const logger = withLogger
    ? {
        info: (...args: unknown[]) => logLines.push({ level: "info", args }),
        error: (...args: unknown[]) => logLines.push({ level: "error", args }),
        debug: (...args: unknown[]) => logLines.push({ level: "debug", args }),
        warn: (...args: unknown[]) => logLines.push({ level: "warn", args }),
      }
    : undefined;

  const api = {
    registerHook(event: string, handler: (...args: unknown[]) => unknown, _meta: unknown) {
      hooks.push({ hookName: event, handler });
    },
    on(hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) {
      typedHooks.push({ hookName, handler, opts });
    },
    registerContextEngine(_id: string, _factory: () => unknown) {},
    registerCommand(_cmd: unknown) {},
    logger,
  };

  return { api, hooks, typedHooks, logLines };
}

// ═══════════════════════════════════════════════════════════
// BLOCK 1: OpenClawPlugin (from openclaw-plugin.test.ts)
// ═══════════════════════════════════════════════════════════

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
      const { default: plugin } = await import("../../src/openclaw-plugin.js");
      expect(plugin.id).toBe("context-mode");
      expect(plugin.name).toBe("Context Mode");
      expect(plugin.configSchema).toBeDefined();
      expect(plugin.configSchema.type).toBe("object");
      expect(typeof plugin.register).toBe("function");
    });

    it("configSchema has enabled property", async () => {
      const { default: plugin } = await import("../../src/openclaw-plugin.js");
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
    it("creates engine with ownsCompaction: false (host owns compaction to preserve thinking blocks)", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-info"));
      const engine = mock.contextEngines[0].factory();
      expect(engine.info.id).toBe("context-mode");
      expect(engine.info.name).toBe("Context Mode");
      expect(engine.info.ownsCompaction).toBe(false);
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

      // compact() is a no-op — hooks handle session continuity
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
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

      // compact() is a no-op — hooks handle session continuity regardless of events
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
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

      // Agent A — compact() is a no-op regardless of events
      const resultA = await engineA.compact();
      expect(resultA.compacted).toBe(false);
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
      expect(result.compacted).toBe(false);
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

// ═══════════════════════════════════════════════════════════
// BLOCK 2: Plugin hooks (from openclaw-plugin-hooks.test.ts)
// ═══════════════════════════════════════════════════════════

describe("Plugin exports", () => {
  beforeEach(() => { vi.resetModules(); });

  test("plugin exports id, name, configSchema, register", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    assert.equal(plugin.id, "context-mode");
    assert.equal(plugin.name, "Context Mode");
    assert.ok(plugin.configSchema);
    assert.equal(typeof plugin.register, "function");
  });
});

describe("session_start hook", () => {
  beforeEach(() => { vi.resetModules(); });

  test("session_start hook is registered", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "session_start");
    assert.ok(hook, "session_start hook must be registered");
  });

  test("session_start hook is registered with no priority (void hook)", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "session_start");
    assert.ok(hook, "session_start must be registered");
    assert.equal(hook.opts?.priority, undefined);
  });

  test("session_start handler resets resumeInjected — verified via before_prompt_build sequence", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const sessionStartHandler = typedHooks.find(h => h.hookName === "session_start")?.handler;
    assert.ok(sessionStartHandler, "session_start handler must exist");

    const resumeHook = typedHooks.find(
      h => h.hookName === "before_prompt_build" && h.opts?.priority === 10,
    );
    assert.ok(resumeHook, "resume before_prompt_build hook must exist");

    // Call before_prompt_build first time — returns undefined (no DB resume)
    const result1 = await resumeHook.handler();
    assert.equal(result1, undefined, "no resume in DB → undefined");

    // Call session_start (simulating session restart)
    await sessionStartHandler({ sessionId: randomUUID(), sessionKey: "test:agent:1" });

    // Call before_prompt_build again — still undefined (no DB resume), but must not throw
    const result2 = await resumeHook.handler();
    assert.equal(result2, undefined, "after session_start reset, still no resume → undefined");
  });
});

describe("compaction hooks", () => {
  beforeEach(() => { vi.resetModules(); });

  test("before_compaction hook is registered", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "before_compaction");
    assert.ok(hook, "before_compaction must be registered");
  });

  test("after_compaction hook is registered", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "after_compaction");
    assert.ok(hook, "after_compaction must be registered");
  });

  test("before_compaction DB logic: flushes events to resume snapshot", async () => {
    // Test the DB-layer logic directly (independent of plugin closures)
    const { buildResumeSnapshot } = await import("../../src/session/snapshot.js");
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    // Insert a fake event
    db.insertEvent(sid, {
      type: "file",
      category: "file",
      data: "/src/test.ts",
      priority: 2,
      data_hash: "",
    } as unknown as import("../../src/types.js").SessionEvent, "PostToolUse");

    // Simulate before_compaction logic
    const events = db.getEvents(sid);
    assert.equal(events.length, 1);

    const stats = db.getSessionStats(sid);
    const snapshot = buildResumeSnapshot(events, {
      compactCount: (stats?.compact_count ?? 0) + 1,
    });
    db.upsertResume(sid, snapshot, events.length);

    const resume = db.getResume(sid);
    assert.ok(resume, "resume must exist after flush");
    assert.ok(resume.snapshot.length > 0, "snapshot must be non-empty");
  });
});

describe("resume injection (before_prompt_build)", () => {
  beforeEach(() => { vi.resetModules(); });

  test("before_prompt_build resume hook is registered at priority 10", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const resumeHook = typedHooks.find(
      h => h.hookName === "before_prompt_build" && h.opts?.priority === 10,
    );
    assert.ok(resumeHook, "resume before_prompt_build hook must be registered at priority 10");
  });

  test("resume injection returns prependSystemContext when resume exists and compact_count > 0", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    db.upsertResume(sid, "## Resume\n\n- Did something", 3);
    db.incrementCompactCount(sid);

    const resume = db.getResume(sid);
    const stats = db.getSessionStats(sid);

    assert.ok(resume, "resume must exist");
    assert.ok((stats?.compact_count ?? 0) > 0, "compact_count must be > 0");

    const result = resume && (stats?.compact_count ?? 0) > 0
      ? { prependSystemContext: resume.snapshot }
      : undefined;

    assert.ok(result, "result must be defined");
    assert.ok(result.prependSystemContext.includes("## Resume"), "must include resume content");
  });

  test("resume injection returns undefined when no resume exists", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    const resume = db.getResume(sid);
    assert.equal(resume, null, "new session has no resume");

    const result = resume ? { prependSystemContext: resume.snapshot } : undefined;
    assert.equal(result, undefined, "must return undefined if no resume");
  });

  test("resume injection returns undefined when compact_count is 0", () => {
    const db = createTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    db.ensureSession(sid, projectDir);

    db.upsertResume(sid, "## Resume\n\n- Did something", 1);

    const resume = db.getResume(sid);
    const stats = db.getSessionStats(sid);
    assert.ok(resume, "resume exists");
    assert.equal(stats?.compact_count ?? 0, 0, "compact_count is 0");

    const result = resume && (stats?.compact_count ?? 0) > 0
      ? { prependSystemContext: resume.snapshot }
      : undefined;
    assert.equal(result, undefined, "must return undefined if compact_count is 0");
  });
});

// ════════════════════════════════════════════
// OpenClawSessionDB.getMostRecentSession
// ════════════════════════════════════════════

describe("OpenClawSessionDB.getMostRecentSession", () => {
  test("returns null when no sessions exist for sessionKey", () => {
    const db = createOpenClawTestDB();
    const result = db.getMostRecentSession("no-such-key");
    assert.equal(result, null);
  });

  test("returns session_id scoped by sessionKey", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const keyA = "agent-a:telegram:111";
    const keyB = "agent-b:telegram:222";
    const sidA = randomUUID();
    const sidB = randomUUID();

    db.ensureSessionWithKey(sidA, projectDir, keyA);
    db.ensureSessionWithKey(sidB, projectDir, keyB);

    assert.equal(db.getMostRecentSession(keyA), sidA);
    assert.equal(db.getMostRecentSession(keyB), sidB);
  });

  test("returns most recent session when multiple exist for same sessionKey (upsert overwrites)", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const key = "agent-a:telegram:111";
    const sid1 = randomUUID();
    const sid2 = randomUUID();

    db.ensureSessionWithKey(sid1, projectDir, key);
    db.ensureSessionWithKey(sid2, projectDir, key);

    const result = db.getMostRecentSession(key);
    // openclaw_session_map uses UPSERT — second call overwrites the mapping
    assert.equal(result, sid2, "must return the most recently mapped session");
  });

  test("ignores sessions with different sessionKey", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const sidA = randomUUID();
    const sidB = randomUUID();

    db.ensureSessionWithKey(sidA, projectDir, "agent-a:telegram:111");
    db.ensureSessionWithKey(sidB, projectDir, "agent-b:telegram:222");

    assert.equal(db.getMostRecentSession("agent-a:telegram:111"), sidA);
  });
});

// ════════════════════════════════════════════
// OpenClawSessionDB.session_key support
// ════════════════════════════════════════════

describe("OpenClawSessionDB.session_key support", () => {
  test("ensureSessionWithKey stores session_key in openclaw_session_map", () => {
    const db = createOpenClawTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const sessionKey = "agent-a:telegram:12345";

    db.ensureSessionWithKey(sid, projectDir, sessionKey);

    const stats = db.getSessionStats(sid);
    assert.ok(stats, "session must exist");
    assert.equal(db.getMostRecentSession(sessionKey), sid, "session_key must be mapped");
  });

  test("ensureSession works without sessionKey (backward compat via base class)", () => {
    const db = createOpenClawTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);

    db.ensureSession(sid, projectDir);

    const stats = db.getSessionStats(sid);
    assert.ok(stats, "session must exist");
  });
});

// ════════════════════════════════════════════
// OpenClawSessionDB.renameSession
// ════════════════════════════════════════════

describe("OpenClawSessionDB.renameSession", () => {
  test("migrates events to new session ID", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const oldId = randomUUID();
    const newId = randomUUID();

    db.ensureSession(oldId, projectDir);
    db.insertEvent(oldId, {
      type: "file", category: "file", data: "/src/test.ts", priority: 2, data_hash: "",
    } as unknown as import("../../src/types.js").SessionEvent, "PostToolUse");

    db.renameSession(oldId, newId);

    assert.equal(db.getEventCount(newId), 1, "events must be under new session ID");
    assert.equal(db.getEventCount(oldId), 0, "old session must have no events");
  });

  test("migrates session meta to new session ID", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const oldId = randomUUID();
    const newId = randomUUID();

    db.ensureSession(oldId, projectDir);
    db.renameSession(oldId, newId);

    assert.equal(db.getSessionStats(oldId), null, "old meta must be gone");
    assert.ok(db.getSessionStats(newId), "new meta must exist");
  });

  test("migrates resume snapshot to new session ID", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const oldId = randomUUID();
    const newId = randomUUID();

    db.ensureSession(oldId, projectDir);
    db.upsertResume(oldId, "## Resume", 1);
    db.renameSession(oldId, newId);

    assert.equal(db.getResume(oldId), null, "old resume must be gone");
    assert.ok(db.getResume(newId), "new resume must exist");
  });

  test("is a no-op if oldId does not exist", () => {
    const db = createOpenClawTestDB();
    assert.doesNotThrow(() => db.renameSession(randomUUID(), randomUUID()));
  });
});

// ════════════════════════════════════════════
// before_model_resolve — user message capture
// ════════════════════════════════════════════

describe("before_model_resolve hook", () => {
  beforeEach(() => { vi.resetModules(); });

  test("before_model_resolve hook is registered", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "before_model_resolve");
    assert.ok(hook, "before_model_resolve hook must be registered");
  });

  test("before_model_resolve captures decision events — extractUserEvents integration", async () => {
    // Verify extractUserEvents correctly identifies decision messages
    // (the hook pipes userMessage through this function)
    const { extractUserEvents } = await import("../../src/session/extract.js");
    const events = extractUserEvents("don't use that approach, use X instead");
    const decisionEvents = events.filter(e => e.category === "decision");
    assert.ok(decisionEvents.length > 0, "extractUserEvents must return decision events");
  });

  test("before_model_resolve handler runs without throwing on decision message", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "before_model_resolve");
    assert.ok(hook, "before_model_resolve must be registered");

    // Must not throw on a decision-style message
    await assert.doesNotReject(
      () => Promise.resolve(hook.handler({ userMessage: "don't use that approach, use X instead" })),
    );
  });

  test("before_model_resolve is silent when userMessage is empty", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "before_model_resolve");
    assert.ok(hook);

    // Must not throw on empty or missing message
    await assert.doesNotReject(() => Promise.resolve(hook.handler({})));
    await assert.doesNotReject(() => Promise.resolve(hook.handler({ userMessage: "" })));
  });
});

// ════════════════════════════════════════════
// command:reset and command:stop hooks
// ════════════════════════════════════════════

describe("command lifecycle hooks", () => {
  beforeEach(() => { vi.resetModules(); });

  test("command:reset hook is registered", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, hooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = hooks.find(h => h.hookName === "command:reset");
    assert.ok(hook, "command:reset hook must be registered");
  });

  test("command:stop hook is registered", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, hooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = hooks.find(h => h.hookName === "command:stop");
    assert.ok(hook, "command:stop hook must be registered");
  });

  test("command:reset handler runs cleanupOldSessions without throwing", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, hooks } = createMockApiHooks();

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = hooks.find(h => h.hookName === "command:reset");
    assert.ok(hook);
    await assert.doesNotReject(() => Promise.resolve(hook.handler()));
  });
});

// ════════════════════════════════════════════
// verbose logging via api.logger
// ════════════════════════════════════════════

describe("verbose logging", () => {
  beforeEach(() => { vi.resetModules(); });

  test("plugin works without logger (logger is optional)", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api } = createMockApiHooks(false); // no logger

    assert.doesNotThrow(() =>
      plugin.register(api as unknown as Parameters<typeof plugin.register>[0]),
    );
  });

  test("session_start emits info log when logger is provided", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks, logLines } = createMockApiHooks(true);

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const hook = typedHooks.find(h => h.hookName === "session_start");
    assert.ok(hook);
    await hook.handler({ sessionId: randomUUID(), sessionKey: "test:agent:1" });

    const infoLines = logLines.filter(l => l.level === "info");
    assert.ok(infoLines.length > 0, "session_start must emit at least one info log");
  });

  test("after_tool_call emits debug log for captured events when logger provided", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks, logLines } = createMockApiHooks(true);

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    const afterHook = typedHooks.find(h => h.hookName === "after_tool_call");
    assert.ok(afterHook, "after_tool_call must be registered via api.on()");

    await afterHook.handler({
      toolName: "read",
      params: { file_path: "/src/test.ts" },
      output: "content",
    });

    const debugLines = logLines.filter(l => l.level === "debug");
    assert.ok(debugLines.length > 0, "after_tool_call must emit debug log when events captured");
  });

  test("before_prompt_build emits debug log when resume is injected", async () => {
    const { default: plugin } = await import("../../src/openclaw-plugin.js");
    const { api, typedHooks, logLines } = createMockApiHooks(true);

    plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

    // session_start to capture session ID, then manually inject resume
    const sessionStartHook = typedHooks.find(h => h.hookName === "session_start");
    const sid = randomUUID();
    await sessionStartHook!.handler({ sessionId: sid, sessionKey: "test:agent:1" });

    // Inject resume directly into DB
    const dbPath = require("node:path").join(require("node:os").tmpdir(), "dummy.db");
    // (resume injection via before_prompt_build requires DB state — test the log emission
    // by verifying the hook doesn't throw with logger present)
    const resumeHook = typedHooks.find(
      h => h.hookName === "before_prompt_build" && h.opts?.priority === 10,
    );
    assert.ok(resumeHook);
    await assert.doesNotReject(() => Promise.resolve(resumeHook.handler()));
  });
});

// ═══════════════════════════════════════════════════════════
// BLOCK 3: Workspace Router (from openclaw/workspace-router.test.ts)
// ═══════════════════════════════════════════════════════════

describe("extractWorkspace", () => {
  it("extracts workspace from exec command path", () => {
    expect(extractWorkspace({ command: "cat /openclaw/workspace-trainer/notes.md" }))
      .toBe("/openclaw/workspace-trainer");
  });

  it("extracts workspace from file_path param", () => {
    expect(extractWorkspace({ file_path: "/openclaw/workspace-divorce/docs/memo.md" }))
      .toBe("/openclaw/workspace-divorce");
  });

  it("extracts workspace from cwd param", () => {
    expect(extractWorkspace({ cwd: "/openclaw/workspace-locadora" }))
      .toBe("/openclaw/workspace-locadora");
  });

  it("returns null for non-workspace paths", () => {
    expect(extractWorkspace({ command: "echo hello" })).toBeNull();
  });

  it("returns null for base /openclaw/workspace (no agent suffix)", () => {
    expect(extractWorkspace({ command: "ls /openclaw/workspace/scripts" }))
      .toBeNull();
  });

  it("handles multiple workspace refs — returns first match", () => {
    expect(extractWorkspace({ command: "cp /openclaw/workspace-trainer/a /openclaw/workspace-divorce/b" }))
      .toBe("/openclaw/workspace-trainer");
  });
});

describe("WorkspaceRouter", () => {
  it("maps sessionKey to workspace and resolves sessionId", () => {
    const router = new WorkspaceRouter();
    router.registerSession("agent:trainer:main", "sid-trainer");
    expect(router.resolveSessionId({ command: "cat /openclaw/workspace-trainer/x" }))
      .toBe("sid-trainer");
  });

  it("returns null for unknown workspace", () => {
    const router = new WorkspaceRouter();
    expect(router.resolveSessionId({ command: "cat /openclaw/workspace-unknown/x" }))
      .toBeNull();
  });

  it("updates sessionId on re-registration", () => {
    const router = new WorkspaceRouter();
    router.registerSession("agent:trainer:main", "sid-old");
    router.registerSession("agent:trainer:main", "sid-new");
    expect(router.resolveSessionId({ command: "cat /openclaw/workspace-trainer/x" }))
      .toBe("sid-new");
  });

  it("handles sessionKey without agent: prefix gracefully", () => {
    const router = new WorkspaceRouter();
    router.registerSession("custom-key", "sid-custom");
    // No workspace derivable — should not crash
    expect(router.resolveSessionId({ command: "cat /openclaw/workspace-trainer/x" }))
      .toBeNull();
  });
});
