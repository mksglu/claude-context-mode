import "../setup-home";
/**
 * Pi MCP bridge — fast parent-death detection in the spawned child (#534).
 *
 * Background: `bootstrapMCPTools()` spawns `server.bundle.mjs` as a long-lived
 * stdio child. When the parent Pi process exits without sending SIGTERM (e.g.
 * `pi --help` printing to stdout and returning), the child gets reparented
 * to PID 1 and its stdin half-closes. The MCP SDK's StdioServerTransport
 * registers only `data` / `error` listeners — not `end` — so it CPU-spins.
 *
 * The existing lifecycle guard (`src/lifecycle.ts`) polls ppid every 30 s.
 * That's fine for normal Claude Code sessions, but #534 shows the orphan
 * accumulates >80 h of CPU before the poll catches up — because `pi --help`
 * exits in ~50 ms and no human is around to notice the 30 s gap.
 *
 * Fix: when the lifecycle guard runs *as an MCP bridge child* (signalled via
 * `CONTEXT_MODE_BRIDGE_DEPTH=1` in env — already set by mcp-bridge.ts:179),
 * tighten the poll to 1 s. This is invisible to normal Claude Code MCP
 * sessions (their depth is 0) and shrinks the orphan window for `pi --help`
 * from 30 s to ~1 s.
 *
 * These tests pin:
 *   1. `lifecycleGuardIntervalForEnv(env)` returns 1000 when
 *      `CONTEXT_MODE_BRIDGE_DEPTH` is set to a positive number.
 *   2. Returns the default (30000) otherwise.
 *   3. `startLifecycleGuard` honours the resolved interval — under the
 *      fast-poll regime, an `isParentAlive=false` flip is detected in ≤2 s.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const realEnv = { ...process.env };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // Restore env keys we mutate.
  delete process.env.CONTEXT_MODE_BRIDGE_DEPTH;
  if (realEnv.CONTEXT_MODE_BRIDGE_DEPTH !== undefined) {
    process.env.CONTEXT_MODE_BRIDGE_DEPTH = realEnv.CONTEXT_MODE_BRIDGE_DEPTH;
  }
});

describe("lifecycleGuardIntervalForEnv — bridge-child fast poll (#534)", () => {
  it("returns 1000 ms when CONTEXT_MODE_BRIDGE_DEPTH=1 (running as MCP child)", async () => {
    const { lifecycleGuardIntervalForEnv } = await import("../../src/lifecycle.js");
    expect(lifecycleGuardIntervalForEnv({ CONTEXT_MODE_BRIDGE_DEPTH: "1" })).toBe(1000);
  });

  it("returns 1000 ms for any positive depth (transitive bridges)", async () => {
    const { lifecycleGuardIntervalForEnv } = await import("../../src/lifecycle.js");
    expect(lifecycleGuardIntervalForEnv({ CONTEXT_MODE_BRIDGE_DEPTH: "2" })).toBe(1000);
    expect(lifecycleGuardIntervalForEnv({ CONTEXT_MODE_BRIDGE_DEPTH: "5" })).toBe(1000);
  });

  it("returns the default 30000 ms when env flag is absent (regression guard)", async () => {
    const { lifecycleGuardIntervalForEnv } = await import("../../src/lifecycle.js");
    expect(lifecycleGuardIntervalForEnv({})).toBe(30_000);
  });

  it("returns the default 30000 ms when depth is 0 (top-level MCP server)", async () => {
    const { lifecycleGuardIntervalForEnv } = await import("../../src/lifecycle.js");
    expect(lifecycleGuardIntervalForEnv({ CONTEXT_MODE_BRIDGE_DEPTH: "0" })).toBe(30_000);
  });

  it("returns the default when depth is malformed (defensive)", async () => {
    const { lifecycleGuardIntervalForEnv } = await import("../../src/lifecycle.js");
    expect(lifecycleGuardIntervalForEnv({ CONTEXT_MODE_BRIDGE_DEPTH: "garbage" })).toBe(
      30_000,
    );
  });
});

describe("startLifecycleGuard — fast poll fires shutdown within 2s when bridge-child env is set (#534)", () => {
  it("detects parent death in ≤2 s under bridge-child fast poll", async () => {
    const { startLifecycleGuard } = await import("../../src/lifecycle.js");
    let alive = true;
    let shutdownCalls = 0;

    const cleanup = startLifecycleGuard({
      checkIntervalMs: 1000, // matches bridge-child resolution
      isParentAlive: () => alive,
      onShutdown: () => {
        shutdownCalls++;
      },
    });

    // Simulate parent death right after start.
    alive = false;
    // Advance the fake clock past one poll tick.
    await vi.advanceTimersByTimeAsync(1500);

    expect(shutdownCalls).toBe(1);
    cleanup();
  });

  it("does NOT shut down when parent stays alive across many ticks", async () => {
    const { startLifecycleGuard } = await import("../../src/lifecycle.js");
    let shutdownCalls = 0;

    const cleanup = startLifecycleGuard({
      checkIntervalMs: 1000,
      isParentAlive: () => true,
      onShutdown: () => {
        shutdownCalls++;
      },
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(shutdownCalls).toBe(0);
    cleanup();
  });
});
