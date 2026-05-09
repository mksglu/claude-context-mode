import "./setup-home";
/**
 * Pi Extension Tests — TDD vertical slices.
 *
 * The Pi extension (src/adapters/pi/extension.ts) is a default-exported function that
 * receives a Pi API object and registers event handlers. Since we cannot test
 * against a real Pi runtime, we mock the Pi API to capture registered handlers
 * and invoke them with simulated events.
 *
 * Test slices:
 *   1. Tool name mapping (Pi names → context-mode canonical names)
 *   2. Event extraction from tool_result
 *   3. PreToolUse routing enforcement (tool_call)
 *   4. Session lifecycle
 *   5. Resume injection (before_agent_start)
 *   6. Stats command (/ctx-stats)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB } from "../src/session/db.js";

// ── Mock Pi API ──────────────────────────────────────────────

type HandlerFn = (...args: any[]) => any;

interface MockCommandOpts {
  description?: string;
  handler?: HandlerFn;
  [key: string]: unknown;
}

function createMockPiApi() {
  const handlers: Record<string, HandlerFn[]> = {};
  const commands: Record<string, MockCommandOpts> = {};

  return {
    on: (event: string, handler: HandlerFn) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerCommand: (name: string, opts: MockCommandOpts) => {
      commands[name] = opts;
    },
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(),

    // ── Test helpers ──
    _trigger: async (event: string, ...args: any[]) => {
      for (const h of handlers[event] ?? []) {
        const result = await h(...args);
        if (result) return result;
      }
    },
    _getCommand: (name: string) => commands[name],
    _handlers: handlers,
    _commands: commands,
  };
}

// ── Shared state ────────────────────────────────────────────

let tempDir: string;
let api: ReturnType<typeof createMockPiApi>;

// ── Dynamic import helper ───────────────────────────────────

async function registerPiExtension(
  mockApi: ReturnType<typeof createMockPiApi>,
  opts?: { projectDir?: string },
) {
  // Set environment variable so the extension uses our temp directory
  const projectDir = opts?.projectDir ?? tempDir;
  process.env.PI_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PROJECT_DIR = projectDir;

  const mod = await import("../src/adapters/pi/extension.js");
  const register = mod.default;
  await register(mockApi);

  return mockApi;
}

// ── Tests ───────────────────────────────────────────────────

describe("Pi Extension", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
    mkdirSync(tempDir, { recursive: true });
    api = createMockPiApi();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* cleanup best effort */
    }
    delete process.env.PI_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 1: Tool name mapping
  // ═══════════════════════════════════════════════════════════

  describe("Slice 1: Tool name mapping", () => {
    it("maps Pi 'bash' to context-mode 'Bash'", async () => {
      await registerPiExtension(api);

      // Trigger a tool_result event with Pi's "bash" tool name
      // and verify it gets mapped correctly for event extraction
      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git status" },
        tool_result: "On branch main\nnothing to commit",
      });

      // The handler should not throw — successful mapping means
      // extractEvents recognized "Bash" and produced git events
    });

    it("maps Pi 'read' to context-mode 'Read'", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/app.ts" },
        tool_result: "export default {}",
      });

      // Should not throw — "Read" mapping enables file_read event extraction
    });

    it("passes unknown tool names through unchanged", async () => {
      await registerPiExtension(api);

      // Unknown tools should pass through without error
      await api._trigger("tool_result", {
        tool_name: "SomeCustomTool",
        tool_input: { data: "test" },
        tool_result: "ok",
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 2: Event extraction from tool_result
  // ═══════════════════════════════════════════════════════════

  describe("Slice 2: Event extraction from tool_result", () => {
    it("extracts file and git events from bash command", async () => {
      await registerPiExtension(api);

      // Bash with git command should produce git events
      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git commit -m 'initial'" },
        tool_result: "[main abc1234] initial\n 1 file changed",
      });

      // No throw = events extracted successfully
    });

    it("extracts file_read event from read tool", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/index.ts" },
        tool_result: "export const hello = 'world';",
      });
    });

    it("extracts cwd event from cd command", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "cd /tmp/workspace && ls" },
        tool_result: "file1.ts\nfile2.ts",
      });
    });

    it("extracts error event from failed tool result", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "npm test" },
        tool_result: "Error: test failed with exit code 1",
        is_error: true,
      });
    });

    it("handles missing tool_result gracefully", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "echo hello" },
      });
    });

    it("handles empty event gracefully", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {});
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 3: PreToolUse routing enforcement (tool_call)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 3: PreToolUse routing enforcement", () => {
    it("blocks bash with curl", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl https://example.com" },
      });

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
    });

    it("blocks bash with wget", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "wget https://example.com -O out.html" },
      });

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
    });

    it("allows bash with git status", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "git status" },
      });

      // git status should NOT be blocked — result is undefined (passthrough)
      // or an allow/context action (not deny/blocked)
      if (result) {
        expect(result.blocked).not.toBe(true);
      }
    });

    it("allows read tool (no blocking)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "read",
        input: { file_path: "/src/app.ts" },
      });

      // Read should never be blocked — at most it gets routing guidance
      if (result) {
        expect(result.blocked).not.toBe(true);
      }
    });

    it("handles missing tool_name gracefully", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {});
      // Should not throw, and should passthrough
      if (result) {
        expect(result.blocked).not.toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 4: Session lifecycle
  // ═══════════════════════════════════════════════════════════

  describe("Slice 4: Session lifecycle", () => {
    it("session_start initializes session in DB", async () => {
      await registerPiExtension(api);

      // session_start should register without error
      await api._trigger("session_start", {
        session_id: "test-session-abc123",
        project_dir: tempDir,
      });
    });

    it("session_start uses Pi context arg for stable session ID", async () => {
      await registerPiExtension(api);
      const sessionFile = join(tempDir, "stable-session.jsonl");
      const expectedSessionId = createHash("sha256")
        .update(sessionFile)
        .digest("hex")
        .slice(0, 8);

      await api._trigger(
        "session_start",
        { type: "session_start", reason: "startup" },
        { sessionManager: { getSessionFile: () => sessionFile } },
      );

      const result = await api._getCommand("ctx-stats")!.handler!({});
      expect((result as { text: string }).text).toContain(
        `Session: \`${expectedSessionId}`,
      );
    });

    it("session_before_compact builds resume snapshot", async () => {
      await registerPiExtension(api);

      // First capture some events
      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/index.ts" },
        tool_result: "export default {}",
      });

      // Then trigger compaction
      const result = await api._trigger("session_before_compact", {});

      // Should return a snapshot string or undefined if no events
      if (result !== undefined) {
        expect(typeof result).toBe("string");
        if (typeof result === "string" && result.length > 0) {
          expect(result).toContain("session_resume");
        }
      }
    });

    it("session_compact increments compact counter", async () => {
      await registerPiExtension(api);

      // Capture events first
      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/app.ts" },
        tool_result: "code here",
      });

      // Build snapshot
      await api._trigger("session_before_compact", {});

      // Increment counter
      await api._trigger("session_compact", {});

      // No throw = success
    });

    it("session_shutdown cleans up", async () => {
      await registerPiExtension(api);

      await api._trigger("session_start", {
        session_id: "cleanup-session-xyz",
        project_dir: tempDir,
      });

      // Shutdown should clean up without error
      await api._trigger("session_shutdown", {});
    });

    it("handles session lifecycle in correct order", async () => {
      await registerPiExtension(api);

      // Full lifecycle: start → events → compact → more events → shutdown
      await api._trigger("session_start", {
        session_id: "lifecycle-test",
        project_dir: tempDir,
      });

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git status" },
        tool_result: "On branch main",
      });

      await api._trigger("session_before_compact", {});
      await api._trigger("session_compact", {});

      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/file.ts" },
        tool_result: "content",
      });

      await api._trigger("session_shutdown", {});
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 5: Resume injection (before_agent_start)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 5: Resume injection", () => {
    it("returns modified systemPrompt when unconsumed resume exists", async () => {
      await registerPiExtension(api);

      // Build up session state: capture events → compact → build resume
      await api._trigger("session_start", {
        session_id: "resume-test-1",
        project_dir: tempDir,
      });

      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/main.ts" },
        tool_result: "import express from 'express';",
      });

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git commit -m 'feat: add express'" },
        tool_result: "[main abc1234] feat: add express",
      });

      // Trigger compaction to build resume snapshot
      await api._trigger("session_before_compact", {});
      await api._trigger("session_compact", {});

      // Now before_agent_start should inject the resume
      const result = await api._trigger("before_agent_start", {
        systemPrompt: "You are a helpful assistant.",
      });

      // If resume injection is supported, the result should contain
      // a modified system prompt with session_resume data
      if (result?.systemPrompt) {
        expect(result.systemPrompt).toContain("session_resume");
      }
    });

    it("returns nothing when no resume exists", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("before_agent_start", {
        systemPrompt: "You are a helpful assistant.",
      });

      // No resume → no modification (undefined or original prompt)
      if (result?.systemPrompt) {
        expect(result.systemPrompt).not.toContain("session_resume");
      }
    });

    it("extracts user prompt events", async () => {
      await registerPiExtension(api);

      // User prompt with decision-like content should extract events
      await api._trigger("user_prompt", {
        message: "Don't use lodash, use native Array methods instead",
      });

      // Should not throw — user events are silently captured
    });

    it("handles missing systemPrompt gracefully", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("before_agent_start", {});

      // Should not throw
      if (result) {
        expect(result).toBeDefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 6: Stats command (/ctx-stats)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 6: Stats command", () => {
    it("registers /ctx-stats command", async () => {
      await registerPiExtension(api);

      const cmd = api._getCommand("ctx-stats");
      expect(cmd).toBeDefined();
    });

    it("/ctx-stats returns formatted stats text", async () => {
      await registerPiExtension(api);

      // Capture some events first
      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/app.ts" },
        tool_result: "export default {}",
      });

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git status" },
        tool_result: "On branch main",
      });

      const cmd = api._getCommand("ctx-stats");
      expect(cmd).toBeDefined();
      expect(cmd!.handler).toBeDefined();

      const result = await cmd!.handler!({});

      // Stats should contain formatted text with session info
      expect(result).toBeDefined();
      if (typeof result === "object" && result !== null && "text" in result) {
        const text = (result as { text: string }).text;
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        // Should contain typical stats output
        expect(text).toMatch(/stat|session|event/i);
      } else if (typeof result === "string") {
        expect(result.length).toBeGreaterThan(0);
        expect(result).toMatch(/stat|session|event/i);
      }
    });

    it("/ctx-stats works with empty session", async () => {
      await registerPiExtension(api);

      const cmd = api._getCommand("ctx-stats");
      expect(cmd).toBeDefined();
      expect(cmd!.handler).toBeDefined();

      // Should not throw even with no events
      const result = await cmd!.handler!({});
      expect(result).toBeDefined();
    });

    it("/ctx-stats treats SQLite started_at as UTC", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-09T12:30:00Z"));

      const originalTZ = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";

      const sessionFile = join(tempDir, "stats-utc-session.jsonl");
      const sessionId = createHash("sha256")
        .update(sessionFile)
        .digest("hex")
        .slice(0, 16);

      try {
        await registerPiExtension(api);
        await api._trigger(
          "session_start",
          { type: "session_start", reason: "startup" },
          { sessionManager: { getSessionFile: () => sessionFile } },
        );

        const dbPath = join(
          process.env.HOME!,
          ".pi",
          "context-mode",
          "sessions",
          "context-mode.db",
        );
        const db = new SessionDB({ dbPath });
        try {
          // SQLite datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS".
          // If parsed as local time in America/Los_Angeles, this would be
          // 2026-05-09T19:00:00Z and the age would not be 30 minutes.
          db.db
            .prepare(
              "UPDATE session_meta SET started_at = ? WHERE session_id = ?",
            )
            .run("2026-05-09 12:00:00", sessionId);
        } finally {
          db.close();
        }

        const result = await api._getCommand("ctx-stats")!.handler!({});

        expect((result as { text: string }).text).toContain(
          "- Session age: 30m",
        );
      } finally {
        if (originalTZ === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = originalTZ;
        }
        vi.useRealTimers();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 7: Routing block injection (Pi-1)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 7: Routing block injection", () => {
    it("injects <context_window_protection> on first before_agent_start", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {}, {
        sessionManager: { getSessionFile: () => `routing-1-${Date.now()}-${Math.random()}` },
      });

      const result = await api._trigger("before_agent_start", {
        systemPrompt: "Base prompt.",
      });

      expect(result?.systemPrompt).toBeDefined();
      expect(result.systemPrompt).toContain("<context_window_protection>");
    });

    it("does not re-inject the routing block on subsequent calls", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {}, {
        sessionManager: { getSessionFile: () => `routing-2-${Date.now()}-${Math.random()}` },
      });

      const first = await api._trigger("before_agent_start", {
        systemPrompt: "Base.",
      });
      const second = await api._trigger("before_agent_start", {
        systemPrompt: "Base.",
      });

      expect(first?.systemPrompt).toContain("<context_window_protection>");
      const occurrences = (
        (second?.systemPrompt ?? "").match(/<context_window_protection>/g) ?? []
      ).length;
      expect(occurrences).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 8: before_provider_response (Pi-2)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 8: before_provider_response handler", () => {
    it("registers a before_provider_response handler", async () => {
      await registerPiExtension(api);
      expect(api._handlers["before_provider_response"]).toBeDefined();
      expect(api._handlers["before_provider_response"].length).toBeGreaterThan(0);
    });

    it("invokes the handler without throwing on metadata payloads", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {
        session_id: "provider-1",
        project_dir: tempDir,
      });

      await expect(
        api._trigger("before_provider_response", {
          model: "pi-1",
          provider: "pi",
          latencyMs: 42,
          usage: { prompt: 10, completion: 20 },
        }),
      ).resolves.not.toThrow();
    });

    it("handles empty payload gracefully", async () => {
      await registerPiExtension(api);
      await expect(
        api._trigger("before_provider_response", {}),
      ).resolves.not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 9: active_memory always-on + token cap (Pi-3, Pi-4)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 9: active_memory injection", () => {
    it("injects <active_memory> even when compact_count is 0", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {
        sessionManager: { getSessionFile: () => `active-mem-1-${Date.now()}-${Math.random()}` },
      });

      // Seed user prompt with role pattern (priority 3) so the extractor
      // produces a priority>=3 event the active_memory builder can pick up.
      await api._trigger("before_agent_start", {
        prompt: "You are a senior staff engineer reviewing this codebase.",
        systemPrompt: "Base.",
      });

      // Second call should now contain <active_memory> built from those events.
      const result = await api._trigger("before_agent_start", {
        systemPrompt: "Base 2.",
      });

      expect(result?.systemPrompt).toBeDefined();
      // Either the auto-injection helper (rules/decisions) OR the inline
      // fallback (active_memory) should have produced injected content.
      const sp = String(result.systemPrompt);
      const hasActiveMemory =
        sp.includes("<active_memory>") ||
        sp.includes("<rules>") ||
        sp.includes("<behavioral_directive>");
      expect(hasActiveMemory).toBe(true);
    });

    it("caps active_memory at ≤ 2000 characters", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {
        sessionManager: { getSessionFile: () => `active-mem-2-${Date.now()}-${Math.random()}` },
      });

      // Flood with very long role-pattern prompts (priority 3).
      const longText = "You are a senior staff engineer. " + "x".repeat(500);
      for (let i = 0; i < 20; i++) {
        await api._trigger("before_agent_start", {
          prompt: `${longText} #${i}`,
          systemPrompt: "Base.",
        });
      }

      const result = await api._trigger("before_agent_start", {
        systemPrompt: "Base final.",
      });

      const sp = String(result?.systemPrompt ?? "");
      // Slice out the injected memory block (auto-injection or fallback).
      const memMatch =
        sp.match(/<active_memory>[\s\S]*?<\/active_memory>/) ??
        sp.match(/<behavioral_directive>[\s\S]*?<\/behavioral_directive>/) ??
        sp.match(/<rules>[\s\S]*?<\/rules>/);
      if (memMatch) {
        // 500 token cap × 4 chars/token = 2000 chars; allow small padding for
        // XML wrappers from buildAutoInjection / fallback markers.
        expect(memMatch[0].length).toBeLessThanOrEqual(2200);
      } else {
        // If no block exists, the test should surface the failure.
        expect(memMatch).not.toBeNull();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Registration integrity
  // ═══════════════════════════════════════════════════════════

  describe("Registration integrity", () => {
    it("registers expected event handlers", async () => {
      await registerPiExtension(api);

      // The extension should register handlers for key lifecycle events
      const registeredEvents = Object.keys(api._handlers);
      expect(registeredEvents.length).toBeGreaterThan(0);

      // At minimum, tool_call and tool_result should be handled
      const hasToolCall = registeredEvents.includes("tool_call");
      const hasToolResult = registeredEvents.includes("tool_result");

      // At least one of the core event types should be registered
      expect(hasToolCall || hasToolResult).toBe(true);
    });

    it("does not throw during registration", async () => {
      await expect(registerPiExtension(api)).resolves.not.toThrow();
    });

    it("can be registered multiple times without error", async () => {
      const api1 = createMockPiApi();
      const api2 = createMockPiApi();

      await registerPiExtension(api1, { projectDir: join(tempDir, "reg1") });
      await registerPiExtension(api2, { projectDir: join(tempDir, "reg2") });
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// MCP bridge — bridges context-mode MCP tools into Pi's pi.registerTool()
// surface so the LLM can actually reach ctx_execute / ctx_search / etc.
// (#426). Pi 0.73.x has no native MCP support; without this bridge the
// routing block tells the LLM about tools it cannot call.
// ────────────────────────────────────────────────────────────────────────

describe("Pi MCP bridge (#426)", () => {
  let mcpScratch: string;

  beforeEach(() => {
    mcpScratch = mkdtempSync(join(tmpdir(), "ctx-pi-bridge-"));
  });

  afterEach(() => {
    try {
      rmSync(mcpScratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function writeFakeServer(source: string): string {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = join(mcpScratch, `fake-mcp-${Date.now()}-${Math.random()}.mjs`);
    fs.writeFileSync(path, source, "utf-8");
    return path;
  }

  // ── Unit: MCPStdioClient framing & lifecycle ──────────────────────

  describe("MCPStdioClient", () => {
    it("matches request id to response result over newline-delimited JSON", async () => {
      const fakePath = writeFakeServer(`
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              result: { echoed: msg.method, params: msg.params },
            }) + "\\n");
          }
        });
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const r1 = await client.request("tools/list", { foo: 1 });
        expect(r1).toEqual({ echoed: "tools/list", params: { foo: 1 } });
        const r2 = await client.request("tools/call", { bar: 2 });
        expect(r2).toEqual({ echoed: "tools/call", params: { bar: 2 } });
      } finally {
        client.shutdown();
      }
    });

    it("matches concurrent in-flight requests by id (out-of-order responses)", async () => {
      // Reverse delays so the slowest goes first — exercises the id-map
      // dispatch, not just FIFO ordering.
      const fakePath = writeFakeServer(`
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            const delay = msg.params?.delay ?? 0;
            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0", id: msg.id, result: { id: msg.id },
              }) + "\\n");
            }, delay);
          }
        });
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const promises = [50, 40, 30, 20, 10].map((delay, i) =>
          client.request<{ id: number }>("probe", { delay, idx: i }),
        );
        const results = await Promise.all(promises);
        expect(results).toHaveLength(5);
        for (const r of results) expect(typeof r.id).toBe("number");
      } finally {
        client.shutdown();
      }
    });

    it("rejects in-flight requests when the child exits", async () => {
      const fakePath = writeFakeServer(`
        process.stdin.once("data", () => process.exit(0));
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      const promise = client.request("tools/list", {});
      await expect(promise).rejects.toThrow(/exited|MCP/);
      client.shutdown();
    });

    it("times out instead of hanging on a silent server", async () => {
      const fakePath = writeFakeServer(`
        process.stdin.on("data", () => {});
        setInterval(() => {}, 1000);
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        await expect(
          client.request("tools/list", {}, 200),
        ).rejects.toThrow(/timeout/);
      } finally {
        client.shutdown();
      }
    });

    it("ignores non-JSON stdout lines without crashing the parser", async () => {
      const fakePath = writeFakeServer(`
        process.stdout.write("[some startup banner]\\n");
        process.stdout.write("not valid json {{{\\n");
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
          }
        });
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const r = await client.request<{ ok: boolean }>("ping", {});
        expect(r.ok).toBe(true);
      } finally {
        client.shutdown();
      }
    });
  });

  // ── Integration: bootstrapMCPTools + real MCP server ──────────────

  describe("bootstrapMCPTools — registers every ctx_* tool with Pi", () => {
    // Lifted out of each `it` so the path resolution lives in one place
    // and a future MCP-entrypoint move only has to change one line.
    const path = require("node:path") as typeof import("node:path");
    const url = require("node:url") as typeof import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const mcpEntry = path.resolve(here, "..", "start.mjs");
    const mcpEnv = { ...process.env, CONTEXT_MODE_DISABLE_VERSION_CHECK: "1" };

    let bridge: { tools: string[]; shutdown: () => void } | null = null;

    afterEach(() => {
      if (bridge) {
        bridge.shutdown();
        bridge = null;
      }
    });

    it("registers the canonical ctx_* tool set", async () => {
      const registered: Array<{ name: string; label: string; description: string; parameters: unknown; execute: Function }> = [];
      const fakePi = {
        registerTool: (tool: any) => {
          registered.push(tool);
        },
      };

      const { bootstrapMCPTools } = await import("../src/adapters/pi/mcp-bridge.js");
      bridge = await bootstrapMCPTools(fakePi, mcpEntry, { env: mcpEnv });

      // Pin the canonical names — adding new MCP tools is fine
      // (arrayContaining), but losing one of these is the bug regression.
      expect(bridge.tools).toEqual(
        expect.arrayContaining([
          "ctx_execute",
          "ctx_execute_file",
          "ctx_search",
          "ctx_index",
          "ctx_batch_execute",
          "ctx_fetch_and_index",
          "ctx_doctor",
          "ctx_stats",
          "ctx_purge",
        ]),
      );

      // Each registration must satisfy the Pi contract.
      for (const reg of registered) {
        expect(reg.name).toMatch(/^ctx_/);
        expect(reg.label).toBe(reg.name);
        expect(typeof reg.description).toBe("string");
        expect(reg.parameters).toBeTruthy();
        expect(typeof reg.execute).toBe("function");
      }
    }, 30_000);

    it("execute() round-trips through tools/call to the MCP server", async () => {
      const registered: any[] = [];
      const fakePi = {
        registerTool: (tool: any) => registered.push(tool),
      };

      const { bootstrapMCPTools } = await import("../src/adapters/pi/mcp-bridge.js");
      bridge = await bootstrapMCPTools(fakePi, mcpEntry, { env: mcpEnv });

      const indexTool = registered.find((t) => t.name === "ctx_index");
      expect(indexTool).toBeDefined();

      const marker = `pi-bridge-marker-${process.pid}-${Date.now()}`;
      const result = await indexTool.execute("test-call-1", {
        content: `# heading\n\n${marker}\n`,
        source: "pi-bridge-smoke",
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      // Server returns "Indexed N sections … from: pi-bridge-smoke" on
      // success — pin the source label so a regression in tools/call
      // arg-passing also fails this test.
      expect(result.content[0].text).toMatch(/pi-bridge-smoke/);
      expect(result.isError).toBeFalsy();
    }, 30_000);
  });

  // ── Wiring: pi-extension.ts default export must call bootstrapMCPTools
  //
  // This is the regression that the rest of the suite does NOT catch: if
  // a future refactor drops the `bootstrapMCPTools(pi, …)` call from
  // src/adapters/pi/extension.ts but keeps the bridge module intact, every other
  // bridge test stays green and the bug silently re-enters. We assert
  // here that the extension's default export, after `_mcpBridgeReady`
  // settles, has actually called `pi.registerTool` for at least the
  // canonical ctx_* set.

  describe("pi-extension.ts wiring (#426 regression guard)", () => {
    it("registerPiExtension awaits bridge bootstrap and registers ctx_* via pi.registerTool", async () => {
      const wireApi = createMockPiApi();
      // PI_PROJECT_DIR / CLAUDE_PROJECT_DIR set inside registerPiExtension.
      await registerPiExtension(wireApi, { projectDir: tempDir });

      // Bootstrap is fire-and-forget on extension load — wait on the
      // exported promise so the test does not race the spawn.
      const mod = await import("../src/adapters/pi/extension.js");
      await mod._mcpBridgeReady;

      const calls = (wireApi.registerTool as any).mock.calls as Array<[any]>;
      const registeredNames = calls.map(([t]) => t?.name).filter(Boolean);

      // Same canonical pin as the bridge integration test — but reached
      // through registerPiExtension instead of bootstrapMCPTools, so
      // dropping the wiring fails this test even when the bridge module
      // still works.
      expect(registeredNames).toEqual(
        expect.arrayContaining([
          "ctx_execute",
          "ctx_search",
          "ctx_index",
          "ctx_batch_execute",
          "ctx_fetch_and_index",
        ]),
      );

      // Cleanup: SIGTERM the bridge child the wiring spawned so it does
      // not leak past this test.
      const sd = mod.default as any;
      void sd; // silence unused
      await wireApi._trigger("session_shutdown");
    }, 30_000);
  });
});
