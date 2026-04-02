import "./setup-home";
/**
 * Tests for the OpenCode TypeScript plugin entry point.
 *
 * Tests the ContextModePlugin factory and its three hooks:
 *   - tool.execute.before (routing enforcement)
 *   - tool.execute.after (session event capture)
 *   - experimental.session.compacting (snapshot generation)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test helpers ──────────────────────────────────────────

/**
 * Create a plugin instance with DB in a temp directory.
 * Uses dynamic import to resolve routing module from project root.
 */
async function createTestPlugin(tempDir: string) {
  // Import the plugin module
  const { ContextModePlugin } = await import("../src/opencode-plugin.js");

  // Monkey-patch the session dir to use temp directory
  // The plugin uses homedir() internally, but we can control the DB path
  // by creating the plugin with a unique directory that produces a unique hash
  return ContextModePlugin({ directory: tempDir });
}

// ── Tests ─────────────────────────────────────────────────

describe("ContextModePlugin", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-plugin-test-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* cleanup best effort */ }
  });

  // ── Factory ───────────────────────────────────────────

  describe("factory", () => {
    it("returns object with 3 hook handlers", async () => {
      const plugin = await createTestPlugin(join(tempDir, "factory-test"));

      expect(plugin).toHaveProperty("tool.execute.before");
      expect(plugin).toHaveProperty("tool.execute.after");
      expect(plugin).toHaveProperty("experimental.session.compacting");

      expect(typeof plugin["tool.execute.before"]).toBe("function");
      expect(typeof plugin["tool.execute.after"]).toBe("function");
      expect(typeof plugin["experimental.session.compacting"]).toBe("function");
    });

    it("does not write AGENTS.md routing instructions on startup", async () => {
      const projectDir = join(tempDir, "factory-startup-routing");
      mkdirSync(projectDir, { recursive: true });
      await createTestPlugin(projectDir);

      const agentsPath = join(projectDir, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(false);
    });
  });

  // ── tool.execute.before ───────────────────────────────

  describe("tool.execute.before", () => {
    it("modifies curl commands to block them", async () => {
      const plugin = await createTestPlugin(join(tempDir, "before-curl"));
      const input = { tool: "Bash", sessionID: "test-session", callID: "call-1" };
      const output = { args: { command: "curl https://example.com/data" } };

      // Routing should throw for blocked commands (deny action)
      // or modify the args to replace the command
      try {
        await plugin["tool.execute.before"](input, output);
        // If it didn't throw, the command was modified in output.args
        expect(output.args.command).toMatch(/^echo /);
        expect(output.args.command).toContain("context-mode");
      } catch (e: any) {
        // deny/ask action throws — still correct behavior
        expect(e.message).toContain("context-mode");
      }
    });

    it("modifies wget commands to block them", async () => {
      const plugin = await createTestPlugin(join(tempDir, "before-wget"));
      const input = { tool: "Bash", sessionID: "test-session", callID: "call-2" };
      const output = { args: { command: "wget https://example.com/file" } };

      try {
        await plugin["tool.execute.before"](input, output);
        expect(output.args.command).toMatch(/^echo /);
        expect(output.args.command).toContain("context-mode");
      } catch (e: any) {
        expect(e.message).toContain("context-mode");
      }
    });

    it("passes through normal tool calls", async () => {
      const plugin = await createTestPlugin(join(tempDir, "before-pass"));

      // TaskCreate is not routed — should passthrough
      const result = await plugin["tool.execute.before"](
        { tool: "TaskCreate", sessionID: "test-session", callID: "call-3" },
        { args: { subject: "test task" } },
      );

      expect(result).toBeUndefined();
    });

    it("handles empty input gracefully", async () => {
      const plugin = await createTestPlugin(join(tempDir, "before-empty"));

      const result = await plugin["tool.execute.before"](
        {} as any,
        { args: {} } as any,
      );
      expect(result).toBeUndefined();
    });
  });

  // ── tool.execute.after ────────────────────────────────

  describe("tool.execute.after", () => {
    it("captures file read events without throwing", async () => {
      const plugin = await createTestPlugin(join(tempDir, "after-read"));

      // Should not throw
      await expect(
        plugin["tool.execute.after"](
          { tool: "Read", sessionID: "test-session", callID: "call-1", args: { file_path: "/test/file.ts" } },
          { title: "Read", output: "file contents here", metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });

    it("captures file write events", async () => {
      const plugin = await createTestPlugin(join(tempDir, "after-write"));

      await expect(
        plugin["tool.execute.after"](
          { tool: "Write", sessionID: "test-session", callID: "call-2", args: { file_path: "/test/new-file.ts", content: "code" } },
          { title: "Write", output: "", metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });

    it("captures git events from Bash", async () => {
      const plugin = await createTestPlugin(join(tempDir, "after-git"));

      await expect(
        plugin["tool.execute.after"](
          { tool: "Bash", sessionID: "test-session", callID: "call-3", args: { command: "git commit -m 'test'" } },
          { title: "Bash", output: "[main abc1234] test", metadata: {} },
        ),
      ).resolves.toBeUndefined();
    });

    it("handles empty input gracefully", async () => {
      const plugin = await createTestPlugin(join(tempDir, "after-empty"));

      await expect(
        plugin["tool.execute.after"](
          {} as any,
          { title: "", output: "", metadata: {} } as any,
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ── experimental.session.compacting ───────────────────

  describe("experimental.session.compacting", () => {
    it("returns empty string when no events captured", async () => {
      const plugin = await createTestPlugin(join(tempDir, "compact-empty"));

      const output = { context: [] as string[], prompt: undefined };
      const snapshot = await plugin["experimental.session.compacting"](
        { sessionID: "test-session" },
        output,
      );
      expect(snapshot).toBe("");
    });

    it("returns snapshot XML after events are captured", async () => {
      const plugin = await createTestPlugin(join(tempDir, "compact-snap"));

      // Capture several events first
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "test-session", callID: "call-1", args: { file_path: "/src/index.ts" } },
        { title: "Read", output: "export default {}", metadata: {} },
      );
      await plugin["tool.execute.after"](
        { tool: "Edit", sessionID: "test-session", callID: "call-2", args: { file_path: "/src/index.ts", old_string: "{}", new_string: "{ foo: 1 }" } },
        { title: "Edit", output: "", metadata: {} },
      );
      await plugin["tool.execute.after"](
        { tool: "Bash", sessionID: "test-session", callID: "call-3", args: { command: "git status" } },
        { title: "Bash", output: "On branch main", metadata: {} },
      );

      const output = { context: [] as string[], prompt: undefined };
      const snapshot = await plugin["experimental.session.compacting"](
        { sessionID: "test-session" },
        output,
      );

      expect(snapshot.length).toBeGreaterThan(0);
      expect(snapshot).toContain("session_resume");
      expect(snapshot).toContain("/src/index.ts");
    });

    it("can be called multiple times (increments compact count)", async () => {
      const plugin = await createTestPlugin(join(tempDir, "compact-multi"));

      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "test-session", callID: "call-1", args: { file_path: "/test/a.ts" } },
        { title: "Read", output: "code", metadata: {} },
      );

      const output1 = { context: [] as string[], prompt: undefined };
      const snap1 = await plugin["experimental.session.compacting"](
        { sessionID: "test-session" },
        output1,
      );
      expect(snap1.length).toBeGreaterThan(0);

      // Capture more events
      await plugin["tool.execute.after"](
        { tool: "Write", sessionID: "test-session", callID: "call-2", args: { file_path: "/test/b.ts", content: "new file" } },
        { title: "Write", output: "", metadata: {} },
      );

      const output2 = { context: [] as string[], prompt: undefined };
      const snap2 = await plugin["experimental.session.compacting"](
        { sessionID: "test-session" },
        output2,
      );
      expect(snap2.length).toBeGreaterThan(0);
    });
  });

  // ── Integration: before + after + compact ─────────────

  describe("end-to-end flow", () => {
    it("captures events from allowed tools and generates snapshot", async () => {
      const plugin = await createTestPlugin(join(tempDir, "e2e-flow"));

      // Normal tool call passes through before hook
      await plugin["tool.execute.before"](
        { tool: "Read", sessionID: "test-session", callID: "call-1" },
        { args: { file_path: "/app/main.ts" } },
      );

      // After hook captures the event
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "test-session", callID: "call-1", args: { file_path: "/app/main.ts" } },
        { title: "Read", output: "console.log('hello')", metadata: {} },
      );

      // Compacting generates snapshot
      const output = { context: [] as string[], prompt: undefined };
      const snapshot = await plugin["experimental.session.compacting"](
        { sessionID: "test-session" },
        output,
      );
      expect(snapshot).toContain("session_resume");
      expect(snapshot).toContain("/app/main.ts");
    });

    it("blocked tool command is replaced before execution", async () => {
      const plugin = await createTestPlugin(join(tempDir, "e2e-block"));
      const beforeInput = { tool: "Bash", sessionID: "test-session", callID: "call-1" };
      const beforeOutput = { args: { command: "curl https://evil.com" } };

      // Before hook blocks/modifies the command
      let blocked = false;
      try {
        await plugin["tool.execute.before"](beforeInput, beforeOutput);
        // If modified (not thrown), the command was replaced
        expect(beforeOutput.args.command).toContain("context-mode");
      } catch (e: any) {
        // deny action throws
        blocked = true;
        expect(e.message).toContain("context-mode");
      }

      if (!blocked) {
        // After hook still runs (with the replaced command)
        await plugin["tool.execute.after"](
          { tool: "Bash", sessionID: "test-session", callID: "call-1", args: beforeOutput.args },
          { title: "Bash", output: beforeOutput.args.command, metadata: {} },
        );
      }

      // Snapshot should be empty (echo/blocked commands don't generate events)
      const compactOutput = { context: [] as string[], prompt: undefined };
      const snapshot = await plugin["experimental.session.compacting"](
        { sessionID: "test-session" },
        compactOutput,
      );
      expect(snapshot).toBe("");
    });
  });
});
