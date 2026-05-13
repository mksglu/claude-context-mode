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
