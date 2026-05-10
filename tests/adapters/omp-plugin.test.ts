import "../setup-home";
/**
 * OMP plugin tests — TDD slices around the four hooks the plugin owns.
 *
 * The OMP plugin (src/adapters/omp/plugin.ts) is a default-exported
 * factory `(pi: HookAPI) => void`. Hook contract verified against
 * refs/platforms/oh-my-pi/packages/coding-agent/src/extensibility/
 * hooks/types.ts:695 (HookAPI) and types.ts:809 (HookFactory).
 *
 * Slices:
 *   1. tool_call — pre-tool-call routing enforcement (block curl/wget)
 *   2. tool_result — post-tool-call event extraction into SessionDB
 *   3. session_start — session row created, cleanup runs
 *   4. session_before_compact — resume snapshot persisted
 *
 * We mock the OMP HookAPI shape: `on(event, handler)` collects
 * handlers, `_trigger(event, ...args)` invokes them and returns the
 * first truthy result (matching how OMP forwards `{block, reason}` to
 * the runtime).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB } from "../../src/session/db.js";

// ── Mock OMP HookAPI ────────────────────────────────────────

type HandlerFn = (...args: unknown[]) => unknown | Promise<unknown>;

function createMockOmpApi() {
  const handlers: Record<string, HandlerFn[]> = {};

  return {
    on: (event: string, handler: HandlerFn) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    _trigger: async (event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) {
        const result = await h(...args);
        if (result) return result;
      }
      return undefined;
    },
    _handlers: handlers,
  };
}

// ── Setup / teardown ────────────────────────────────────────

let tempDir: string;
let api: ReturnType<typeof createMockOmpApi>;

async function registerOmpPlugin(
  mockApi: ReturnType<typeof createMockOmpApi>,
  opts?: { projectDir?: string },
) {
  const projectDir = opts?.projectDir ?? tempDir;
  process.env.OMP_PROJECT_DIR = projectDir;
  // Reset module-level singletons so each test sees a fresh DB
  const mod = await import("../../src/adapters/omp/plugin.js");
  mod._resetOmpPluginStateForTests();
  const register = mod.default;
  register(mockApi as unknown as Parameters<typeof register>[0]);
  return mockApi;
}

describe("OMP plugin", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omp-plugin-test-"));
    api = createMockOmpApi();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    delete process.env.OMP_PROJECT_DIR;
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 1: tool_call routing enforcement
  // ═══════════════════════════════════════════════════════════

  describe("Slice 1: tool_call routing", () => {
    it("registers a tool_call handler", async () => {
      await registerOmpPlugin(api);
      expect(api._handlers.tool_call).toBeDefined();
      expect(api._handlers.tool_call.length).toBe(1);
    });

    it("blocks bash with curl and surfaces a reason", async () => {
      await registerOmpPlugin(api);
      const result = (await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl https://example.com/api" },
      })) as { block?: boolean; reason?: string } | undefined;

      expect(result?.block).toBe(true);
      expect(result?.reason).toMatch(/context-mode/);
    });

    it("blocks bash with wget", async () => {
      await registerOmpPlugin(api);
      const result = (await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "wget https://example.com/file" },
      })) as { block?: boolean } | undefined;
      expect(result?.block).toBe(true);
    });

    it("blocks bash with inline node fetch", async () => {
      await registerOmpPlugin(api);
      const result = (await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "node -e \"fetch('https://api')\"" },
      })) as { block?: boolean } | undefined;
      expect(result?.block).toBe(true);
    });

    it("blocks bash with python requests.get", async () => {
      await registerOmpPlugin(api);
      const result = (await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "python -c \"requests.get('https://api')\"" },
      })) as { block?: boolean } | undefined;
      expect(result?.block).toBe(true);
    });

    it("blocks PowerShell Invoke-WebRequest", async () => {
      await registerOmpPlugin(api);
      const result = (await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "Invoke-WebRequest https://api" },
      })) as { block?: boolean } | undefined;
      expect(result?.block).toBe(true);
    });

    it("does NOT block safe bash (git status)", async () => {
      await registerOmpPlugin(api);
      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "git status" },
      });
      expect(result).toBeUndefined();
    });

    it("does NOT block non-bash tools", async () => {
      await registerOmpPlugin(api);
      const result = await api._trigger("tool_call", {
        toolName: "edit",
        input: { file_path: "x.ts" },
      });
      expect(result).toBeUndefined();
    });

    it("tolerates malformed event payloads (no throw)", async () => {
      await registerOmpPlugin(api);
      // Missing input, missing toolName — must not throw, must passthrough
      await expect(api._trigger("tool_call", {})).resolves.toBeUndefined();
      await expect(api._trigger("tool_call", { toolName: "bash" })).resolves.toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 2: tool_result event extraction
  // ═══════════════════════════════════════════════════════════

  describe("Slice 2: tool_result extraction", () => {
    it("registers a tool_result handler", async () => {
      await registerOmpPlugin(api);
      expect(api._handlers.tool_result).toBeDefined();
    });

    it("persists a Read event into the session DB", async () => {
      await registerOmpPlugin(api);
      // Establish a session first so _sessionId is set
      await api._trigger("session_start", { type: "session_start" }, {});

      await api._trigger("tool_result", {
        toolName: "read",
        input: { file_path: "/tmp/x.ts" },
        content: [{ type: "text", text: "export const x = 1;" }],
      });

      // Verify event landed in DB at the OMP storage path
      const { OMPAdapter } = await import("../../src/adapters/omp/index.js");
      const adapter = new OMPAdapter();
      const db = new SessionDB({
        dbPath: join(adapter.getSessionDir(), "context-mode.db"),
      });
      const latest = db.getLatestSessionId();
      expect(latest).not.toBeNull();
      const events = db.getEvents(latest as string);
      expect(events.length).toBeGreaterThan(0);
      // file_read category should appear for a Read tool
      expect(events.some((e) => e.category === "file")).toBe(true);
    });

    it("does nothing when no session has started", async () => {
      await registerOmpPlugin(api);
      // Trigger tool_result WITHOUT session_start first
      await expect(
        api._trigger("tool_result", {
          toolName: "read",
          input: { file_path: "/tmp/x.ts" },
          content: [{ type: "text", text: "x" }],
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 3: session_start lifecycle
  // ═══════════════════════════════════════════════════════════

  describe("Slice 3: session_start", () => {
    it("registers a session_start handler", async () => {
      await registerOmpPlugin(api);
      expect(api._handlers.session_start).toBeDefined();
    });

    it("creates a session row in the DB", async () => {
      await registerOmpPlugin(api);
      await api._trigger("session_start", { type: "session_start" }, {});

      const { OMPAdapter } = await import("../../src/adapters/omp/index.js");
      const adapter = new OMPAdapter();
      const db = new SessionDB({
        dbPath: join(adapter.getSessionDir(), "context-mode.db"),
      });
      const latest = db.getLatestSessionId();
      expect(latest).not.toBeNull();
    });

    it("derives a stable session ID from sessionManager.getSessionFile when present", async () => {
      await registerOmpPlugin(api);
      await api._trigger("session_start", { type: "session_start" }, {
        sessionManager: { getSessionFile: () => "/path/to/session-abc.json" },
      });

      const mod = await import("../../src/adapters/omp/plugin.js");
      const sid = mod._getOmpPluginSessionIdForTests();
      // 16-hex SHA-256 prefix per deriveSessionId contract
      expect(sid).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 4: session_before_compact resume snapshot
  // ═══════════════════════════════════════════════════════════

  describe("Slice 4: session_before_compact", () => {
    it("registers a session_before_compact handler", async () => {
      await registerOmpPlugin(api);
      expect(api._handlers.session_before_compact).toBeDefined();
    });

    it("persists a resume snapshot and increments compact_count", async () => {
      const mod = await registerOmpPlugin(api);
      await api._trigger("session_start", { type: "session_start" }, {});
      // Generate at least one event so the snapshot is non-empty
      await api._trigger("tool_result", {
        toolName: "read",
        input: { file_path: "/tmp/x.ts" },
        content: [{ type: "text", text: "x" }],
      });

      await api._trigger("session_before_compact", { type: "session_before_compact" }, {});

      // Read the session ID picked up by THIS test rather than the
      // shared-DB latest, which can collide at second-precision with
      // sibling test sessions.
      const pluginMod = await import("../../src/adapters/omp/plugin.js");
      const sid = pluginMod._getOmpPluginSessionIdForTests();
      expect(sid).not.toBe("");

      const { OMPAdapter } = await import("../../src/adapters/omp/index.js");
      const adapter = new OMPAdapter();
      const db = new SessionDB({
        dbPath: join(adapter.getSessionDir(), "context-mode.db"),
      });
      const resume = db.getResume(sid);
      expect(resume).not.toBeNull();
      expect(resume?.snapshot.length).toBeGreaterThan(0);

      const stats = db.getSessionStats(sid);
      expect(stats?.compact_count).toBe(1);
      void mod;
    });
  });
});
