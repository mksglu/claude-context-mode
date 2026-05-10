import "../setup-home";
/**
 * End-to-end integration: OMP plugin → SessionDB → statusline (v1.0.118).
 *
 * The unit tests in tests/adapters/omp-plugin.test.ts verify the plugin's
 * hook behavior in isolation (events landing in SessionDB, snapshot
 * captured before compact). The statusline tests in tests/statusline*.ts
 * seed SessionDB directly and pin the v1.0.118 byte-format render.
 *
 * This file wires the two halves together: drive the OMP plugin through
 * a realistic session lifecycle, then spawn bin/statusline.mjs against
 * the DB the plugin actually wrote to and assert the v1.0.118 contract
 * holds end-to-end (no '$', kb()-formatted numbers, expected copy).
 *
 * Slices:
 *   1. ACTIVE render — basic session_start + tool_results → statusline shows
 *      "{kb} this chat · {kb} lifetime · % kept out"
 *   2. Routing — tool_call(curl) is blocked AND statusline still renders the
 *      v1.0.118 format afterward (block side effects don't poison the DB)
 *   3. Compaction — session_before_compact persists a resume snapshot AND
 *      statusline continues to render the v1.0.118 format
 *   4. Tolerance — malformed events don't take statusline down and the
 *      output stays free of '$'
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { fakeHome } from "../setup-home";

const STATUSLINE = resolve(process.cwd(), "bin", "statusline.mjs");

type HandlerFn = (...args: unknown[]) => unknown | Promise<unknown>;

interface BlockResult {
  block?: boolean;
  reason?: string;
}

function createMockOmpApi() {
  const handlers: Record<string, HandlerFn[]> = {};
  return {
    on: (event: string, handler: HandlerFn) => {
      (handlers[event] ??= []).push(handler);
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

function runStatusline(env: Record<string, string>): string {
  const result = spawnSync("node", [STATUSLINE], {
    input: "{}",
    env: { ...process.env, NO_COLOR: "1", ...env },
    encoding: "utf-8",
  });
  return (result.stdout ?? "").trim();
}

/**
 * Boot a fresh OMP plugin against the mock API and drive `session_start`
 * so subsequent tool_result events have a session_id to attach to.
 * Returns the path the plugin's SessionDB lives at and the session_id
 * it picked, so tests can wire statusline to the right slot.
 */
async function bootPlugin(api: ReturnType<typeof createMockOmpApi>) {
  const { OMPAdapter } = await import("../../src/adapters/omp/index.js");
  const ompSessionDir = new OMPAdapter().getSessionDir();

  const plugin = await import("../../src/adapters/omp/plugin.js");
  plugin._resetOmpPluginStateForTests();
  plugin.default(
    api as unknown as Parameters<typeof plugin.default>[0],
  );

  await api._trigger("session_start", { type: "session_start" }, {});
  const sessionId = plugin._getOmpPluginSessionIdForTests();

  return { ompSessionDir, sessionId };
}

async function emitReadResult(
  api: ReturnType<typeof createMockOmpApi>,
  filePath: string,
  textBytes: number,
) {
  await api._trigger("tool_result", {
    toolName: "read",
    input: { file_path: filePath },
    content: [{ type: "text", text: "x".repeat(textBytes) }],
  });
}

describe("OMP plugin → statusline integration (v1.0.118)", () => {
  let tempDir: string;
  let api: ReturnType<typeof createMockOmpApi>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omp-statusline-int-"));
    api = createMockOmpApi();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 1: ACTIVE render — plugin + statusline share the DB
  // ═══════════════════════════════════════════════════════════

  describe("Slice 1: ACTIVE render", () => {
    it("writes the SessionDB at OMPAdapter.getSessionDir()", async () => {
      const { ompSessionDir } = await bootPlugin(api);
      await emitReadResult(api, "/tmp/a.ts", 8 * 1024);
      expect(existsSync(join(ompSessionDir, "context-mode.db"))).toBe(true);
    });

    it("statusline renders the ACTIVE block in v1.0.118 byte format", async () => {
      const { ompSessionDir, sessionId } = await bootPlugin(api);
      for (let i = 0; i < 3; i++) {
        await emitReadResult(api, `/tmp/file-${i}.ts`, 8 * 1024);
      }
      const out = runStatusline({
        HOME: fakeHome,
        CONTEXT_MODE_SESSION_DIR: ompSessionDir,
        CLAUDE_SESSION_ID: sessionId,
      });
      expect(out).toMatch(/context-mode/);
      // kb() can emit B / KB / MB / GB depending on magnitude — the contract
      // we pin is the phrase shape, not the magnitude.
      expect(out).toMatch(/\b\d+(\.\d+)?\s*(B|KB|MB|GB)\s+this chat\b/);
      expect(out).toMatch(/\b\d+(\.\d+)?\s*(B|KB|MB|GB)\s+lifetime\b/);
      expect(out).toMatch(/\b\d+%\s+kept out\b/);
      expect(out).not.toMatch(/\$/);
      expect(out).not.toMatch(/saved this session/);
      expect(out).not.toMatch(/efficient/);
    });

    it("rendered bytes go up monotonically with more events", async () => {
      const { ompSessionDir, sessionId } = await bootPlugin(api);

      await emitReadResult(api, "/tmp/one.ts", 8 * 1024);
      const after1 = parseRenderedThisChatBytes(
        runStatusline({
          HOME: fakeHome,
          CONTEXT_MODE_SESSION_DIR: ompSessionDir,
          CLAUDE_SESSION_ID: sessionId,
        }),
      );
      expect(after1).toBeGreaterThan(0);

      for (let i = 0; i < 5; i++) {
        await emitReadResult(api, `/tmp/extra-${i}.ts`, 16 * 1024);
      }
      const after6 = parseRenderedThisChatBytes(
        runStatusline({
          HOME: fakeHome,
          CONTEXT_MODE_SESSION_DIR: ompSessionDir,
          CLAUDE_SESSION_ID: sessionId,
        }),
      );
      expect(after6).toBeGreaterThanOrEqual(after1);
    });

    it("non-matching CLAUDE_SESSION_ID falls back to FRESH state", async () => {
      const { ompSessionDir } = await bootPlugin(api);
      await emitReadResult(api, "/tmp/x.ts", 8 * 1024);

      const out = runStatusline({
        HOME: fakeHome,
        CONTEXT_MODE_SESSION_DIR: ompSessionDir,
        CLAUDE_SESSION_ID: "pid-this-id-was-never-seen-by-the-plugin",
      });
      expect(out).toMatch(/context-mode/);
      expect(out).toMatch(/kept out\b/);
      expect(out).toMatch(/preserved across compact/);
      expect(out).not.toMatch(/\bthis chat\b/);
      expect(out).not.toMatch(/\$/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 2: Routing block flows back to OMP runtime
  // ═══════════════════════════════════════════════════════════

  describe("Slice 2: tool_call routing", () => {
    it("returns a block decision for bash curl", async () => {
      await bootPlugin(api);
      const result = (await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl https://example.com" },
      })) as BlockResult | undefined;

      expect(result?.block).toBe(true);
      expect(result?.reason).toMatch(/context-mode/);
    });

    it("blocked tool_call does NOT poison the SessionDB used by statusline", async () => {
      const { ompSessionDir, sessionId } = await bootPlugin(api);

      // Capture one legit event so the session has known bytes.
      await emitReadResult(api, "/tmp/before.ts", 8 * 1024);
      const baselineBytes = parseRenderedThisChatBytes(
        runStatusline({
          HOME: fakeHome,
          CONTEXT_MODE_SESSION_DIR: ompSessionDir,
          CLAUDE_SESSION_ID: sessionId,
        }),
      );

      // Now attempt a blocked curl. The plugin should return {block:true}
      // and the bash result should never reach tool_result, so statusline
      // bytes should stay the same.
      await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl https://api.example.com/big" },
      });

      const afterBlockBytes = parseRenderedThisChatBytes(
        runStatusline({
          HOME: fakeHome,
          CONTEXT_MODE_SESSION_DIR: ompSessionDir,
          CLAUDE_SESSION_ID: sessionId,
        }),
      );
      expect(afterBlockBytes).toBe(baselineBytes);
    });

    it("non-bash tool_call returns undefined (no block, no DB write)", async () => {
      await bootPlugin(api);
      const result = await api._trigger("tool_call", {
        toolName: "read",
        input: { file_path: "/tmp/whatever" },
      });
      expect(result).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 3: session_before_compact + statusline
  // ═══════════════════════════════════════════════════════════

  describe("Slice 3: compaction lifecycle", () => {
    it("session_before_compact persists a resume snapshot", async () => {
      const { ompSessionDir, sessionId } = await bootPlugin(api);
      await emitReadResult(api, "/tmp/big.ts", 32 * 1024);

      await api._trigger("session_before_compact", { type: "session_before_compact" }, {});

      const { SessionDB } = await import("../../src/session/db.js");
      const db = new SessionDB({ dbPath: join(ompSessionDir, "context-mode.db") });
      const resume = db.getResume(sessionId);
      expect(resume).not.toBeNull();
      expect(resume?.snapshot.length).toBeGreaterThan(0);

      const stats = db.getSessionStats(sessionId);
      expect(stats?.compact_count).toBe(1);
    });

    it("statusline keeps rendering v1.0.118 format after compaction", async () => {
      const { ompSessionDir, sessionId } = await bootPlugin(api);
      await emitReadResult(api, "/tmp/c1.ts", 16 * 1024);
      await api._trigger("session_before_compact", { type: "session_before_compact" }, {});
      await emitReadResult(api, "/tmp/c2.ts", 16 * 1024);

      const out = runStatusline({
        HOME: fakeHome,
        CONTEXT_MODE_SESSION_DIR: ompSessionDir,
        CLAUDE_SESSION_ID: sessionId,
      });
      expect(out).toMatch(/context-mode/);
      expect(out).toMatch(/\b\d+(\.\d+)?\s*(B|KB|MB|GB)\s+this chat\b/);
      expect(out).not.toMatch(/\$/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 4: tolerance — malformed events don't take the line down
  // ═══════════════════════════════════════════════════════════

  describe("Slice 4: malformed-event tolerance", () => {
    it("malformed tool_result is swallowed; statusline still renders", async () => {
      const { ompSessionDir, sessionId } = await bootPlugin(api);
      // No toolName, no content — extractEvents must skip without throwing.
      await expect(
        api._trigger("tool_result", { input: {} }),
      ).resolves.toBeUndefined();
      // And a follow-up legit event still flows.
      await emitReadResult(api, "/tmp/legit.ts", 8 * 1024);

      const out = runStatusline({
        HOME: fakeHome,
        CONTEXT_MODE_SESSION_DIR: ompSessionDir,
        CLAUDE_SESSION_ID: sessionId,
      });
      expect(out).toMatch(/context-mode/);
      expect(out).toMatch(/\b\d+(\.\d+)?\s*(B|KB|MB|GB)\s+this chat\b/);
      expect(out).not.toMatch(/\$/);
    });
  });
});

// ── helpers ──────────────────────────────────────────────────

/** Extract the byte count from the "X this chat" segment, in bytes. */
function parseRenderedThisChatBytes(out: string): number {
  const match = out.match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s+this chat/);
  if (!match) return 0;
  const [, valueStr, unit] = match;
  const value = parseFloat(valueStr);
  switch (unit) {
    case "GB": return value * 1024 ** 3;
    case "MB": return value * 1024 ** 2;
    case "KB": return value * 1024;
    default:   return value;
  }
}
