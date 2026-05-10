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
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { fakeHome } from "../setup-home";

const STATUSLINE = resolve(process.cwd(), "bin", "statusline.mjs");

type HandlerFn = (...args: unknown[]) => unknown | Promise<unknown>;

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

describe("OMP plugin → statusline integration (v1.0.118)", () => {
  let tempDir: string;
  let api: ReturnType<typeof createMockOmpApi>;
  let ompSessionDir: string;
  let pluginSessionId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "omp-statusline-int-"));
    api = createMockOmpApi();

    // Discover where the OMP adapter will write — same homedir-rooted path
    // setup-home's vi.mock on node:os redirects to fakeHome.
    const { OMPAdapter } = await import("../../src/adapters/omp/index.js");
    ompSessionDir = new OMPAdapter().getSessionDir();

    // Fresh plugin singletons per test so _sessionId is rebound.
    const plugin = await import("../../src/adapters/omp/plugin.js");
    plugin._resetOmpPluginStateForTests();
    plugin.default(
      api as unknown as Parameters<typeof plugin.default>[0],
    );

    // Drive a session: start → a few tool_results carrying real text bytes.
    await api._trigger("session_start", { type: "session_start" }, {});
    pluginSessionId = plugin._getOmpPluginSessionIdForTests();

    // Three Read tool_results with sizable text content. extractEvents
    // converts the response text into a session_event whose bytes_avoided
    // is the text length — that's what statusline aggregates.
    for (let i = 0; i < 3; i++) {
      await api._trigger("tool_result", {
        toolName: "read",
        input: { file_path: `/tmp/file-${i}.ts` },
        content: [{ type: "text", text: "x".repeat(8 * 1024) }],
      });
    }
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("writes the session DB to the OMP-rooted path", () => {
    expect(existsSync(join(ompSessionDir, "context-mode.db"))).toBe(true);
  });

  it("statusline renders the ACTIVE block in v1.0.118 byte format", () => {
    const out = runStatusline({
      HOME: fakeHome,
      CONTEXT_MODE_SESSION_DIR: ompSessionDir,
      CLAUDE_SESSION_ID: pluginSessionId,
    });
    expect(out).toMatch(/context-mode/);
    // kb() emits B / KB / MB / GB depending on magnitude. The plugin only
    // records bytes_avoided when extractEvents promotes a tool_result to
    // an event, so this small test ends up in the B range. The contract
    // we pin is unit-agnostic.
    expect(out).toMatch(/\b\d+(\.\d+)?\s*(B|KB|MB|GB)\s+this chat\b/);
    expect(out).toMatch(/kept out\b/);
    expect(out).not.toMatch(/\$/);
    expect(out).not.toMatch(/saved this session/);
  });

  it("statusline reflects positive bytes captured by the OMP plugin", () => {
    // We assert "this chat" surfaces a positive byte count rather than
    // pinning a specific magnitude — extractEvents stores a normalized
    // data payload, not the raw tool_result text, so the value drifts
    // with extractor heuristics. The thing we care about: statusline
    // and the plugin share a SessionDB and the kb() unit chain works
    // end-to-end.
    const out = runStatusline({
      HOME: fakeHome,
      CONTEXT_MODE_SESSION_DIR: ompSessionDir,
      CLAUDE_SESSION_ID: pluginSessionId,
    });
    const match = out.match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s+this chat/);
    expect(match).not.toBeNull();
    if (!match) return;
    const [, valueStr] = match;
    expect(parseFloat(valueStr)).toBeGreaterThan(0);
  });

  it("a session_id the plugin did not touch falls back to FRESH state", () => {
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
