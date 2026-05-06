import "./setup-home";
/**
 * Tests for the OpenCode TypeScript plugin entry point.
 *
 * Tests the ContextModePlugin factory and its three hooks:
 *   - tool.execute.before (routing enforcement)
 *   - tool.execute.after (session event capture)
 *   - experimental.session.compacting (snapshot generation)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
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
  return ContextModePlugin({
    directory: tempDir,
    client: {
      app: {
        log: async () => {},
      },
    },
  });
}

// ── Tests ─────────────────────────────────────────────────

// MCP readiness sentinel — routing.mjs checks process.ppid in-process
const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

beforeEach(() => { writeFileSync(mcpSentinel, String(process.pid)); });
afterEach(() => { try { unlinkSync(mcpSentinel); } catch {} });

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
    it("returns object with 5 hook handlers", async () => {
      const plugin = await createTestPlugin(join(tempDir, "factory-test"));

      expect(plugin).toHaveProperty("tool.execute.before");
      expect(plugin).toHaveProperty("tool.execute.after");
      expect(plugin).toHaveProperty("experimental.session.compacting");
      // SessionStart-equivalent (PR #376 / Mickey #1) — must be on
      // chat.system.transform, NOT chat.messages.transform (whose input
      // shape `{}` carries no sessionID and whose output {info,parts}[]
      // does not accept the {role,content} shape we used to push).
      expect(plugin).toHaveProperty("experimental.chat.system.transform");
      expect(plugin).not.toHaveProperty("experimental.chat.messages.transform");
      // OC-2 (Z2) — chat.message wired to capture user prompts.
      expect(plugin).toHaveProperty("chat.message");

      expect(typeof plugin["tool.execute.before"]).toBe("function");
      expect(typeof plugin["tool.execute.after"]).toBe("function");
      expect(typeof plugin["experimental.session.compacting"]).toBe("function");
      expect(typeof plugin["experimental.chat.system.transform"]).toBe("function");
      expect(typeof plugin["chat.message"]).toBe("function");
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

    it("injects guidance for allowed grep commands", async () => {
      const plugin = await createTestPlugin(join(tempDir, "before-guidance"));

      const input = { tool: "grep", sessionID: "test-session", callID: "call-4" };
      const output = { args: { command: "grep hello", additionalContext: undefined } };

      await plugin["tool.execute.before"](input, output);

      // Guidance should be injected as additionalContext in args
      expect(output.args).toHaveProperty("additionalContext");
      expect(output.args.additionalContext).toContain("<context_guidance>");
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
      expect(snapshot).toContain("<files");
      expect(snapshot).toContain("index.ts");
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

  // ── experimental.chat.system.transform ────────────────
  // SessionStart-equivalent (PR #376 / Mickey 3-issue fix). Verifies:
  //  • Snapshot is prepended to output.system (NOT output.messages)
  //  • Per-session at-most-once gate (multi-session reuse — Mickey #2)
  //  • Cross-session lookup via DB.claimLatestUnconsumedResume
  //  • Race-safe atomic claim — two parallel transforms get distinct rows

  describe("experimental.chat.system.transform", () => {
    it("is a no-op when sessionID is missing", async () => {
      const plugin = await createTestPlugin(join(tempDir, "sysxform-no-sid"));
      const out = { system: ["existing"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: undefined, model: {} } as any,
        out,
      );
      expect(out.system).toEqual(["existing"]);
    });

    it("injects routing block but no resume snapshot when no prior row exists", async () => {
      // v1.0.107 — routing-block injection (OC-1) is INDEPENDENT of resume
      // snapshot. With no prior row, only the routing block lands.
      const plugin = await createTestPlugin(join(tempDir, "sysxform-no-resume"));
      const out = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "fresh-session", model: {} } as any,
        out,
      );
      expect(out.system[0]).toBe("HEADER"); // header preserved
      expect(out.system.length).toBe(2); // header + routing block (no resume)
      expect(out.system[1]).toContain("<context_window_protection>");
      expect(out.system.join("\n")).not.toContain("session_resume");
    });

    it("prepends a previously-recorded snapshot to output.system on first call", async () => {
      const projectDir = join(tempDir, "sysxform-inject");
      const plugin = await createTestPlugin(projectDir);

      // Build a snapshot in a *prior* session
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "prior-session", callID: "c1", args: { file_path: "/a.ts" } },
        { title: "Read", output: "content", metadata: {} },
      );
      const compactOut = { context: [] as string[], prompt: undefined };
      await plugin["experimental.session.compacting"](
        { sessionID: "prior-session" } as any,
        compactOut,
      );

      // New session enters via system.transform — must inherit the snapshot
      // PLUS the OC-1 routing block (no header in this fixture, so both go
      // in via splice(1, 0, ...) — array becomes [routing, snapshot]).
      const out = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "new-session", model: {} } as any,
        out,
      );
      expect(out.system[0]).toBe("HEADER");
      expect(out.system.length).toBe(3); // HEADER + routing + snapshot
      expect(out.system.some((s) => s.includes("session_resume"))).toBe(true);
      expect(out.system.some((s) => s.includes("<context_window_protection>"))).toBe(true);
    });

    it("preserves system[0] header so OpenCode's prompt-cache fold survives", async () => {
      // OpenCode (packages/opencode/src/session/llm.ts:117-128) preserves a
      // 2-part `[header, body]` system structure for provider prompt caching.
      // It saves `header = system[0]` BEFORE invoking this hook, then folds
      // the rest into `[header, body]` only when `system[0] === header` after
      // the hook returns. If we `unshift(snapshot)` we replace system[0] →
      // cache-fold is skipped → each system block ships as a separate
      // `role: "system"` message → provider prompt cache invalidates on every
      // resume injection (token cost regression). We insert at index 1 instead.
      // v1.0.107 — both routing block and resume snapshot now live between
      // HEADER and BODY (4 elements total).
      const projectDir = join(tempDir, "sysxform-cache-fold");
      const plugin = await createTestPlugin(projectDir);
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "seed", callID: "c1", args: { file_path: "/y.ts" } },
        { title: "Read", output: "y", metadata: {} },
      );
      await plugin["experimental.session.compacting"](
        { sessionID: "seed" } as any,
        { context: [] as string[], prompt: undefined },
      );

      const HEADER = "you are claude";
      const BODY = "user system prompt here";
      const out = { system: [HEADER, BODY] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "turn-cache", model: {} } as any,
        out,
      );
      // The snapshot was inserted, but header at index 0 is preserved
      // exactly as OpenCode saw it before the hook.
      expect(out.system[0]).toBe(HEADER);
      expect(out.system[out.system.length - 1]).toBe(BODY);
      expect(out.system.length).toBe(4); // HEADER + routing + snapshot + BODY
      const middle = out.system.slice(1, -1).join("\n");
      expect(middle).toContain("session_resume");
      expect(middle).toContain("<context_window_protection>");
    });

    it("does NOT re-inject resume snapshot on second call with the same sessionID (multi-turn)", async () => {
      const projectDir = join(tempDir, "sysxform-once-per-session");
      const plugin = await createTestPlugin(projectDir);

      // Seed snapshot
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "seed", callID: "c1", args: { file_path: "/x.ts" } },
        { title: "Read", output: "x", metadata: {} },
      );
      await plugin["experimental.session.compacting"](
        { sessionID: "seed" } as any,
        { context: [] as string[], prompt: undefined },
      );

      const out1 = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "turn-X", model: {} } as any,
        out1,
      );
      // First turn: HEADER + routing + snapshot
      expect(out1.system.length).toBe(3);

      const out2 = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "turn-X", model: {} } as any,
        out2,
      );
      // Same session — resume snapshot consumed from DB. Routing block re-injects (no dedup).
      expect(out2.system.length).toBe(2); // HEADER + routing block
      expect(out2.system[1]).toContain("<context_window_protection>");
      expect(out2.system.join("\n")).not.toContain("session_resume");
    });

    // v1.0.106 — Mickey #376 follow-up: self-injection guard
    it("does NOT inject snapshot back into the session that produced it (self-injection guard)", async () => {
      const projectDir = join(tempDir, "sysxform-self-inject");
      const plugin = await createTestPlugin(projectDir);

      // Session B does work and compacts — produces ITS OWN snapshot row.
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "B", callID: "c1", args: { file_path: "/p.ts" } },
        { title: "Read", output: "p", metadata: {} },
      );
      await plugin["experimental.session.compacting"](
        { sessionID: "B" } as any,
        { context: [] as string[], prompt: undefined },
      );

      // B's NEXT chat turn fires system.transform — must NOT splice B's
      // own snapshot back into B's prompt (wasteful + would consume the
      // row meant for the next fresh session). v1.0.107 — routing block
      // STILL injects (it's session-agnostic, OC-1 contract).
      const out = { system: ["HEADER", "BODY"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "B", model: {} } as any,
        out,
      );
      // No resume snapshot for B (self-inject guard) but routing block lands.
      expect(out.system.length).toBe(3);
      expect(out.system[0]).toBe("HEADER");
      expect(out.system[2]).toBe("BODY");
      expect(out.system.join("\n")).not.toContain("session_resume");
      expect(out.system[1]).toContain("<context_window_protection>");
    });

    // v1.0.106 — when no row exists, do NOT mark sessionId as injected,
    // so a later call within the same session can still pick up a snapshot
    // that arrived after the first attempt.
    it("retries on next turn when no row exists (no premature gate)", async () => {
      const projectDir = join(tempDir, "sysxform-retry");
      const plugin = await createTestPlugin(projectDir);

      // First call — no snapshot in DB yet. Routing block still fires.
      const out1 = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "C", model: {} } as any,
        out1,
      );
      expect(out1.system.length).toBe(2); // HEADER + routing block
      expect(out1.system.join("\n")).not.toContain("session_resume");

      // Now a different session compacts and produces a snapshot
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "donor", callID: "c1", args: { file_path: "/q.ts" } },
        { title: "Read", output: "q", metadata: {} },
      );
      await plugin["experimental.session.compacting"](
        { sessionID: "donor" } as any,
        { context: [] as string[], prompt: undefined },
      );

      // C's next turn — routing block re-injects (every turn), plus resume
      // snapshot from donor (no premature gate — DB claim still available).
      const out2 = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "C", model: {} } as any,
        out2,
      );
      expect(out2.system.length).toBe(3); // HEADER + snapshot + routing
      expect(out2.system[1]).toContain("session_resume");
      expect(out2.system[2]).toContain("<context_window_protection>");
    });

    // v1.0.106 — prefer next session over self-injection
    it("snapshot from B is consumed by C, not by B itself", async () => {
      const projectDir = join(tempDir, "sysxform-b-to-c");
      const plugin = await createTestPlugin(projectDir);

      // Session B compacts → produces row
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "B", callID: "c1", args: { file_path: "/r.ts" } },
        { title: "Read", output: "r", metadata: {} },
      );
      await plugin["experimental.session.compacting"](
        { sessionID: "B" } as any,
        { context: [] as string[], prompt: undefined },
      );

      // B asks for inject — gets routing block but no snapshot (own row excluded)
      const outB = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "B", model: {} } as any,
        outB,
      );
      expect(outB.system.length).toBe(2);
      expect(outB.system.join("\n")).not.toContain("session_resume");
      expect(outB.system[1]).toContain("<context_window_protection>");

      // C asks — gets B's snapshot AND routing block (both first-fire for C)
      const outC = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "C", model: {} } as any,
        outC,
      );
      expect(outC.system.length).toBe(3); // HEADER + routing + snapshot
      expect(outC.system.some((s) => s.includes("session_resume"))).toBe(true);
    });

    // v1.0.106 — visible signal so users can confirm the feature actually
    // fired (without it Mickey reported "I can't find use case for it" —
    // the inject was silent and invisible in OPENCODE_DEBUG logs).
    it("emits a visible context-mode marker comment alongside the snapshot", async () => {
      const projectDir = join(tempDir, "sysxform-marker");
      const plugin = await createTestPlugin(projectDir);

      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "donor", callID: "c1", args: { file_path: "/m.ts" } },
        { title: "Read", output: "m", metadata: {} },
      );
      await plugin["experimental.session.compacting"](
        { sessionID: "donor" } as any,
        { context: [] as string[], prompt: undefined },
      );

      const out = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "consumer", model: {} } as any,
        out,
      );
      // v1.0.107 — out.system is [HEADER, routing-block, snapshot-with-marker]
      expect(out.system.length).toBe(3);
      const snapshotEntry = out.system.find((s) => s.includes("session_resume"));
      expect(snapshotEntry).toBeDefined();
      expect(snapshotEntry!).toMatch(/^<!-- context-mode v[\d.]+: resumed prior session [\w-]{1,8}/);
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
      expect(snapshot).toContain("<files");
      expect(snapshot).toContain("main.ts");
    });

    // ── OC-1: ROUTING_BLOCK injection in chat.system.transform ────
    // Mickey ana şikayet (CCv1). v1.0.107 — adapter must inject the
    // <context_window_protection> XML routing block on the first
    // chat.system.transform call per session, INDEPENDENT of any
    // resume snapshot row (which may or may not exist yet).
    it("OC-1: injects <context_window_protection> routing block on first turn per session", async () => {
      const plugin = await createTestPlugin(join(tempDir, "oc1-routing"));
      const out = { system: ["HEADER", "BODY"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "oc1-fresh", model: {} } as any,
        out,
      );
      // header preserved at index 0 (cache-fold invariant)
      expect(out.system[0]).toBe("HEADER");
      // routing block spliced at index 1
      const joined = out.system.join("\n");
      expect(joined).toContain("<context_window_protection>");
      expect(joined).toContain("<priority_instructions>");
      // platform-specific tool name proves createToolNamer wired correctly
      expect(joined).toContain("context-mode_ctx_search");
    });

    it("OC-1: re-injects routing block on every turn (per-turn reliability)", async () => {
      const plugin = await createTestPlugin(join(tempDir, "oc1-every-turn"));
      const out1 = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "oc1-twice", model: {} } as any,
        out1,
      );
      expect(out1.system.join("\n")).toContain("<context_window_protection>");

      const out2 = { system: ["HEADER"] };
      await plugin["experimental.chat.system.transform"](
        { sessionID: "oc1-twice", model: {} } as any,
        out2,
      );
      // Routing block injects every turn for reliability (no dedup set).
      expect(out2.system.join("\n")).toContain("<context_window_protection>");
      expect(out2.system.length).toBe(2);
    });
  });

  // ── OC-2: chat.message hook (Z2) ──────────────────────────
  // Wires `chat.message` to capture user prompts. CCv2 inline filter
  // skips synthetic system messages (<task-notification>, <system-reminder>,
  // <context_guidance>, <tool-result>) so we don't flood the DB with noise.

  describe("chat.message", () => {
    it("OC-2: captures user prompt as user_prompt event", async () => {
      const projectDir = join(tempDir, "oc2-capture");
      mkdirSync(projectDir, { recursive: true });
      const plugin = await createTestPlugin(projectDir);

      const msg = "switch to mission mode and prefer the elegant solution";
      await plugin["chat.message"](
        { sessionID: "oc2-sess", agent: "build", messageID: "m1" } as any,
        { message: { role: "user" } as any, parts: [{ type: "text", text: msg }] } as any,
      );

      // Verify SessionDB has the event
      const { SessionDB } = await import("../src/session/db.js");
      const { OpenCodeAdapter } = await import("../src/adapters/opencode/index.js");
      const adapter = new OpenCodeAdapter("opencode");
      const db = new SessionDB({ dbPath: adapter.getSessionDBPath(projectDir) });
      const events = db.getEvents("oc2-sess") as any[];
      db.close();
      const userPromptEvent = events.find((e: any) => e.type === "user_prompt");
      expect(userPromptEvent).toBeDefined();
      expect(userPromptEvent.data).toContain("mission mode");
    });

    it("OC-2: filters synthetic system tags (CCv2 inline filter)", async () => {
      const projectDir = join(tempDir, "oc2-filter");
      mkdirSync(projectDir, { recursive: true });
      const plugin = await createTestPlugin(projectDir);

      const synthetic = "<system-reminder>internal nudge</system-reminder>";
      await plugin["chat.message"](
        { sessionID: "oc2-skip", agent: "build", messageID: "m1" } as any,
        { message: { role: "user" } as any, parts: [{ type: "text", text: synthetic }] } as any,
      );

      const { SessionDB } = await import("../src/session/db.js");
      const { OpenCodeAdapter } = await import("../src/adapters/opencode/index.js");
      const adapter = new OpenCodeAdapter("opencode");
      const db = new SessionDB({ dbPath: adapter.getSessionDBPath(projectDir) });
      const events = db.getEvents("oc2-skip") as any[];
      db.close();
      const userPromptEvent = events.find((e: any) => e.type === "user_prompt");
      expect(userPromptEvent).toBeUndefined();
    });

    it("OC-2: handles missing/empty parts gracefully", async () => {
      const plugin = await createTestPlugin(join(tempDir, "oc2-empty"));
      await expect(
        plugin["chat.message"](
          { sessionID: "oc2-empty-sess" } as any,
          { message: {} as any, parts: [] } as any,
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ── OC-3: buildAutoInjection in compacting (Z3) ───────────
  // Replace raw buildResumeSnapshot push with budget-aware
  // buildAutoInjection (~500 tokens / ~2000 chars hard cap).

  describe("session.compacting buildAutoInjection (OC-3)", () => {
    it("OC-3: prepends budget-capped auto-injection block (≤2000 chars) to output.context", async () => {
      const plugin = await createTestPlugin(join(tempDir, "oc3-budget"));

      // Seed enough events to make a fat snapshot
      for (let i = 0; i < 12; i++) {
        await plugin["tool.execute.after"](
          { tool: "Read", sessionID: "oc3-sess", callID: `c${i}`, args: { file_path: `/src/file${i}.ts` } },
          { title: "Read", output: `content ${i}`.repeat(50), metadata: {} },
        );
      }
      // Inject a behavioral_directive via chat.message so auto-injection has P1 role
      await plugin["chat.message"](
        { sessionID: "oc3-sess", agent: "build", messageID: "mr" } as any,
        { message: {} as any, parts: [{ type: "text", text: "act as a senior staff engineer reviewing diffs" }] } as any,
      );

      const output = { context: [] as string[], prompt: undefined };
      await plugin["experimental.session.compacting"](
        { sessionID: "oc3-sess" } as any,
        output,
      );
      // The compacting handler still pushes the raw resume snapshot (existing
      // contract). It MUST also push a separate auto-injection block whose
      // length ≤ 2000 chars (~500 token budget per auto-injection.mjs).
      const autoBlock = output.context.find((c) => c.includes("<session_state source=\"compaction\">"));
      expect(autoBlock).toBeDefined();
      expect(autoBlock!.length).toBeLessThanOrEqual(2000);
    });
  });

  // ── OC-4: AGENTS.md / CLAUDE.md rule capture (Z4) ─────────
  // Capture the project AGENTS.md (OpenCode's CLAUDE.md equivalent) on
  // first hook fire per projectDir, as rule + rule_content events.

  describe("AGENTS.md rule capture (OC-4)", () => {
    it("OC-4: captures AGENTS.md as rule + rule_content events on first tool.execute.after", async () => {
      const projectDir = join(tempDir, "oc4-agents-md");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "AGENTS.md"), "# project rules\n- never push without approval");

      const plugin = await createTestPlugin(projectDir);
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "oc4-sess", callID: "c1", args: { file_path: "/x.ts" } },
        { title: "Read", output: "x", metadata: {} },
      );

      const { SessionDB } = await import("../src/session/db.js");
      const { OpenCodeAdapter } = await import("../src/adapters/opencode/index.js");
      const adapter = new OpenCodeAdapter("opencode");
      const db = new SessionDB({ dbPath: adapter.getSessionDBPath(projectDir) });
      const events = db.getEvents("oc4-sess") as any[];
      db.close();
      const rule = events.find((e: any) => e.type === "rule");
      const ruleContent = events.find((e: any) => e.type === "rule_content");
      expect(rule).toBeDefined();
      expect(rule.data).toContain("AGENTS.md");
      expect(ruleContent).toBeDefined();
      expect(ruleContent.data).toContain("never push without approval");
    });

    it("OC-4: skips capture when AGENTS.md missing", async () => {
      const projectDir = join(tempDir, "oc4-no-agents");
      mkdirSync(projectDir, { recursive: true });
      const plugin = await createTestPlugin(projectDir);
      await plugin["tool.execute.after"](
        { tool: "Read", sessionID: "oc4-empty-sess", callID: "c1", args: { file_path: "/y.ts" } },
        { title: "Read", output: "y", metadata: {} },
      );

      const { SessionDB } = await import("../src/session/db.js");
      const { OpenCodeAdapter } = await import("../src/adapters/opencode/index.js");
      const adapter = new OpenCodeAdapter("opencode");
      const db = new SessionDB({ dbPath: adapter.getSessionDBPath(projectDir) });
      const events = db.getEvents("oc4-empty-sess") as any[];
      db.close();
      expect(events.find((e: any) => e.type === "rule")).toBeUndefined();
    });
  });

  // ── Integration: blocked tool flow ────────────────────

  describe("end-to-end flow (blocked)", () => {
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
