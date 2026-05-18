import "./setup-home";
/**
 * server / lifecycle — stdin EOF triggers parent-death recheck (#534).
 *
 * Background: `lifecycle.ts` already wires `process.stdin.on("end", …)` to
 * re-run the parent-alive probe (added in #388, commit 259077c). #534 verifies
 * the listener is registered as documented AND that an EOF on a half-closed
 * stdin DOES collapse the detection window to ~0 when the parent is gone.
 *
 * Spec from the issue:
 *   "server.ts wires process.stdin.on('end', …) so EOF on parent pipe
 *   terminates cleanly"
 *
 * The exact mechanism is in lifecycle.ts:134 — we deliberately do NOT call
 * `process.exit(0)` unconditionally on 'end' because #236 proved that causes
 * spurious -32000 errors on transient pipe events. Instead, on 'end' we run
 * the same parent-alive probe and shut down only if the parent is gone.
 *
 * These tests pin the contract:
 *   1. `startLifecycleGuard` registers a listener on `process.stdin` 'end'
 *      when stdin is NOT a TTY (the MCP-child case).
 *   2. Emitting 'end' with a dead parent triggers shutdown immediately.
 *   3. Emitting 'end' with a live parent is a no-op (#236 regression guard).
 *   4. The listener is removed on cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

let stdinBackup: typeof process.stdin;

function makeFakeStdin(): NodeJS.ReadStream {
  const ee = new EventEmitter() as unknown as NodeJS.ReadStream;
  // Force non-TTY: lifecycle.ts gates the 'end' listener on !isTTY.
  Object.defineProperty(ee, "isTTY", { value: false, configurable: true });
  return ee;
}

beforeEach(() => {
  stdinBackup = process.stdin;
});

afterEach(() => {
  Object.defineProperty(process, "stdin", {
    value: stdinBackup,
    configurable: true,
  });
});

describe("startLifecycleGuard — stdin EOF triggers immediate parent-alive recheck (#534)", () => {
  it("registers an 'end' listener on stdin when stdin is not a TTY", async () => {
    const fakeStdin = makeFakeStdin();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });

    const { startLifecycleGuard } = await import("../src/lifecycle.js");
    const cleanup = startLifecycleGuard({
      checkIntervalMs: 60_000,
      isParentAlive: () => true,
      onShutdown: () => {},
    });

    expect((fakeStdin as unknown as EventEmitter).listenerCount("end")).toBe(1);
    cleanup();
    expect((fakeStdin as unknown as EventEmitter).listenerCount("end")).toBe(0);
  });

  it("does NOT register an 'end' listener when stdin IS a TTY", async () => {
    const fakeStdin = makeFakeStdin();
    Object.defineProperty(fakeStdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });

    const { startLifecycleGuard } = await import("../src/lifecycle.js");
    const cleanup = startLifecycleGuard({
      checkIntervalMs: 60_000,
      isParentAlive: () => true,
      onShutdown: () => {},
    });

    expect((fakeStdin as unknown as EventEmitter).listenerCount("end")).toBe(0);
    cleanup();
  });

  it("triggers shutdown immediately when 'end' fires AND parent is dead", async () => {
    const fakeStdin = makeFakeStdin();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });

    const { startLifecycleGuard } = await import("../src/lifecycle.js");
    let alive = false;
    let shutdownCalls = 0;
    const cleanup = startLifecycleGuard({
      checkIntervalMs: 60_000, // long poll, so only the EOF path can fire
      isParentAlive: () => alive,
      onShutdown: () => {
        shutdownCalls++;
      },
    });

    (fakeStdin as unknown as EventEmitter).emit("end");
    expect(shutdownCalls).toBe(1);
    cleanup();
  });

  it("does NOT trigger shutdown on 'end' when parent is still alive (#236 regression)", async () => {
    const fakeStdin = makeFakeStdin();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });

    const { startLifecycleGuard } = await import("../src/lifecycle.js");
    let shutdownCalls = 0;
    const cleanup = startLifecycleGuard({
      checkIntervalMs: 60_000,
      isParentAlive: () => true,
      onShutdown: () => {
        shutdownCalls++;
      },
    });

    (fakeStdin as unknown as EventEmitter).emit("end");
    expect(shutdownCalls).toBe(0);
    cleanup();
  });
});

/**
 * Bundle-level pin for the stderr listener regression. server.ts USED to
 * register `process.stderr.on("error", shutdownOnBrokenStdio)` which made
 * any downstream consumer that closed stderr (e.g. host wrappers that only
 * mirror stdout) kill the JSON-RPC channel mid-response. The fix removes
 * the stderr listener while keeping the stdout one — see PR-A in
 * `/Users/sborisov/.claude/plans/toasty-whistling-reddy.md`.
 *
 * We assert this at the bundle text level (server.bundle.mjs) because
 * exercising the listener wiring in main() requires booting the entire
 * server (env handshake, sentinels, DB) which has its own startup-cost
 * test scaffolding elsewhere.
 */
describe("server bundle — stderr 'error' listener removed (PR-A)", () => {
  it("server.bundle.mjs registers stdout 'error' but not stderr 'error'", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const path = "server.bundle.mjs";
    if (!existsSync(path)) {
      // Bundle not built in this environment — skip rather than fail.
      // `npm run build` rebuilds the bundle before publish.
      return;
    }
    const text = readFileSync(path, "utf-8");
    expect(text).toContain('process.stdout.on("error"');
    expect(text).not.toContain('process.stderr.on("error"');
  });
});
