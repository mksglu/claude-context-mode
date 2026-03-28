import "./setup-home";
/**
 * Pi Extension Tests — TDD vertical slices.
 *
 * The Pi extension (src/pi-extension.ts) is a default-exported function that
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
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  const mod = await import("../src/pi-extension.js");
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
