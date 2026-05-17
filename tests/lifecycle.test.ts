/**
 * lifecycle.test.ts — Process lifecycle guard tests.
 *
 * Tests that the lifecycle guard correctly detects parent death
 * and triggers shutdown. Uses injectable check function for testability.
 */

import { describe, test, assert } from "vitest";
import { spawn, execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { startLifecycleGuard, makeDefaultIsParentAlive, idleTimeoutForEnv } from "../src/lifecycle.js";

const TSX_PATH = execSync("which tsx", { encoding: "utf-8" }).trim();

function spawnGuardChild(exitCode: number): { child: ReturnType<typeof spawn>; ready: Promise<void> } {
  const script = join(process.cwd(), `_lifecycle_test_${exitCode}.ts`);
  writeFileSync(script, `
import { startLifecycleGuard } from "./src/lifecycle.ts";
startLifecycleGuard({
  checkIntervalMs: 60000,
  onShutdown: () => process.exit(${exitCode}),
});
process.stdout.write("READY");
setInterval(() => {}, 1000);
`);
  const child = spawn(TSX_PATH, [script], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.on("close", () => { try { unlinkSync(script); } catch {} });
  const ready = new Promise<void>((resolve) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("READY")) resolve();
    });
    setTimeout(resolve, 3000); // fallback
  });
  return { child, ready };
}

describe("Lifecycle Guard", () => {
  test("calls onShutdown when parent is detected as dead", async () => {
    let shutdownCalled = false;

    const cleanup = startLifecycleGuard({
      checkIntervalMs: 50, // fast for testing
      onShutdown: () => { shutdownCalled = true; },
      isParentAlive: () => false, // simulate dead parent
    });

    // Wait for at least one interval tick
    await new Promise((r) => setTimeout(r, 100));

    cleanup();
    assert.equal(shutdownCalled, true, "onShutdown should be called when parent is dead");
  });

  test("does NOT call onShutdown when parent is alive", async () => {
    let shutdownCalled = false;

    const cleanup = startLifecycleGuard({
      checkIntervalMs: 50,
      onShutdown: () => { shutdownCalled = true; },
      isParentAlive: () => true, // parent alive
    });

    await new Promise((r) => setTimeout(r, 150));

    cleanup();
    assert.equal(shutdownCalled, false, "onShutdown should NOT be called when parent is alive");
  });

  test("onShutdown is called only once even with multiple triggers", async () => {
    let shutdownCount = 0;

    const cleanup = startLifecycleGuard({
      checkIntervalMs: 30,
      onShutdown: () => { shutdownCount++; },
      isParentAlive: () => false,
    });

    // Wait for multiple ticks
    await new Promise((r) => setTimeout(r, 150));

    cleanup();
    assert.equal(shutdownCount, 1, "onShutdown should be called exactly once");
  });

  test("cleanup function prevents further checks", async () => {
    let shutdownCalled = false;
    let checkCount = 0;

    const cleanup = startLifecycleGuard({
      checkIntervalMs: 30,
      onShutdown: () => { shutdownCalled = true; },
      isParentAlive: () => { checkCount++; return true; },
    });

    // Let a few checks run
    await new Promise((r) => setTimeout(r, 100));
    const checksBeforeCleanup = checkCount;
    cleanup();

    // Wait more — no new checks should run
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(checkCount, checksBeforeCleanup, "No checks after cleanup");
    assert.equal(shutdownCalled, false);
  });

  test("touches only the 'end' stdin listener and restores it on cleanup (#236, #388)", async () => {
    // The guard is permitted exactly one stdin assist — an 'end' listener
    // used as a faster trigger for the same isParentAlive check the periodic
    // timer runs (see lifecycle.ts). It must NOT touch 'close', 'data',
    // 'error', or 'readable', and it must remove its own 'end' listener on
    // cleanup. This test pins both halves of that contract.
    const sample = (event: "close" | "end" | "data" | "error" | "readable") =>
      process.stdin.listenerCount(event);

    // Snapshot non-'end' listeners — these must be invariant across the
    // guard lifecycle. Skipping 'end' on TTY since the guard skips itself.
    const before = {
      close: sample("close"),
      data: sample("data"),
      error: sample("error"),
      readable: sample("readable"),
      end: sample("end"),
    };

    const cleanup = startLifecycleGuard({
      checkIntervalMs: 50,
      onShutdown: () => {},
      isParentAlive: () => true,
    });

    const afterStart = {
      close: sample("close"),
      data: sample("data"),
      error: sample("error"),
      readable: sample("readable"),
      end: sample("end"),
    };

    cleanup();

    const afterCleanup = {
      close: sample("close"),
      data: sample("data"),
      error: sample("error"),
      readable: sample("readable"),
      end: sample("end"),
    };

    // Non-'end' listeners must be untouched at every phase (#236 contract).
    for (const ev of ["close", "data", "error", "readable"] as const) {
      assert.equal(afterStart[ev], before[ev],
        `startLifecycleGuard must not add a stdin '${ev}' listener`);
      assert.equal(afterCleanup[ev], before[ev],
        `cleanup must not touch the stdin '${ev}' listener`);
    }

    // 'end' listener: +1 only when stdin is not a TTY; restored on cleanup.
    const expectedEndDelta = process.stdin.isTTY ? 0 : 1;
    assert.equal(afterStart.end - before.end, expectedEndDelta,
      "startLifecycleGuard adds exactly one stdin 'end' listener (or none on TTY)");
    assert.equal(afterCleanup.end, before.end,
      "cleanup must remove the 'end' listener it added");
  });

  test("startLifecycleGuard does NOT call process.stdin.resume()", async () => {
    let resumeCalled = false;
    const originalResume = process.stdin.resume.bind(process.stdin);
    process.stdin.resume = (() => { resumeCalled = true; return originalResume(); }) as typeof process.stdin.resume;

    try {
      const cleanup = startLifecycleGuard({
        checkIntervalMs: 50,
        onShutdown: () => {},
        isParentAlive: () => true,
      });

      // Give one tick to ensure any async resume would have fired
      await new Promise((r) => setTimeout(r, 100));

      cleanup();
      assert.equal(resumeCalled, false, "process.stdin.resume() must not be called by lifecycle guard");
    } finally {
      // Restore original resume to avoid polluting other tests
      process.stdin.resume = originalResume;
    }
  });

  test("stdin 'end' triggers immediate isParentAlive re-check; shuts down only if dead (#388)", async () => {
    // Skip on TTY — the guard intentionally does not register the 'end'
    // listener when stdin is a TTY (e.g. OpenCode ts-plugin), so this
    // assertion would not apply to that environment.
    if (process.stdin.isTTY) return;

    let shutdownCalled = false;
    let parentAlive = true;
    let aliveCallCount = 0;

    const cleanup = startLifecycleGuard({
      // Long interval so we know the next assertion can only be driven by
      // the 'end' listener, not the periodic timer.
      checkIntervalMs: 60_000,
      onShutdown: () => { shutdownCalled = true; },
      isParentAlive: () => { aliveCallCount++; return parentAlive; },
    });

    // Phase 1: parent alive — emitting 'end' must run the check but NOT
    // shut down. This is the #236 contract: stdin close alone is not a
    // shutdown signal.
    const callsBeforeAliveEnd = aliveCallCount;
    process.stdin.emit("end");
    assert.ok(aliveCallCount > callsBeforeAliveEnd,
      "'end' must run isParentAlive() — that's the whole point of the assist");
    assert.equal(shutdownCalled, false,
      "'end' with a live parent must not shut down (regression of #236)");

    // Phase 2: parent now dead — the next 'end' must collapse the
    // detection window from 30 s to ~0 ms.
    parentAlive = false;
    process.stdin.emit("end");
    assert.equal(shutdownCalled, true,
      "'end' with a dead parent must shut down without waiting for the poll tick");

    cleanup();
  });

  test("detects ppid=0 as dead parent (Windows behavior)", async () => {
    let shutdownCalled = false;

    const cleanup = startLifecycleGuard({
      checkIntervalMs: 30,
      onShutdown: () => { shutdownCalled = true; },
      isParentAlive: () => false, // simulates ppid=0 or ppid changed
    });

    await new Promise((r) => setTimeout(r, 80));
    cleanup();
    assert.equal(shutdownCalled, true);
  });
});

// Regression coverage for #311 — zombie context-mode servers persist because
// the Claude Code process tree is
//   Claude Code → start.mjs → npm exec → server
// and when Claude Code dies, `start.mjs` reparents to init (PID 1) but
// `npm exec` (our direct parent) keeps running, so a ppid-only check stays
// green forever. The grandparent-orphan check closes this gap.
describe("makeDefaultIsParentAlive — grandparent orphan detection (#311)", () => {
  test("returns false when grandparent is reparented to init after startup", () => {
    // Startup chain: server (ppid=100) → npm exec (ppid=50) → start.mjs (ppid=7, alive)
    let currentGrandparent = 7;
    const isAlive = makeDefaultIsParentAlive({
      getPpid: () => 100,
      readGrandparentPpid: () => currentGrandparent,
    });

    assert.equal(isAlive(), true, "alive at startup when grandparent is a normal process");

    // Claude Code dies → start.mjs reparents to init.
    currentGrandparent = 1;
    assert.equal(isAlive(), false, "must detect grandparent reparenting (#311)");
  });

  test("does not false-positive when grandparent was already init at startup", () => {
    // Daemon-style launch — grandparent is init from the start (e.g. launchd,
    // systemd, or a detached nohup process). The check must skip in this case,
    // otherwise the guard would shut down immediately on every poll.
    const isAlive = makeDefaultIsParentAlive({
      getPpid: () => 100,
      readGrandparentPpid: () => 1,
    });

    // Multiple polls — never flip to false while ppid is stable.
    assert.equal(isAlive(), true);
    assert.equal(isAlive(), true);
    assert.equal(isAlive(), true);
  });

  test("tolerates NaN grandparent (Windows / ps failure)", () => {
    // On Windows readGrandparentPpidImpl returns NaN; the check must fall
    // back to the original ppid-only path and stay green while ppid is stable.
    const isAlive = makeDefaultIsParentAlive({
      getPpid: () => 100,
      readGrandparentPpid: () => NaN,
    });

    assert.equal(isAlive(), true);
  });

  test("direct ppid death still takes precedence over grandparent check", () => {
    // If our own parent dies (ppid flips to init), shut down immediately —
    // don't wait for a grandparent poll to confirm.
    let ppid = 50;
    const isAlive = makeDefaultIsParentAlive({
      getPpid: () => ppid,
      readGrandparentPpid: () => 7, // grandparent alive the whole time
    });

    assert.equal(isAlive(), true);
    ppid = 1; // direct parent dies
    assert.equal(isAlive(), false);
  });

  test("grandparent check kicks in through startLifecycleGuard end-to-end", async () => {
    // Integration-shaped check: plug the orphan-aware factory into the
    // real guard and prove it triggers onShutdown without touching stdin.
    let currentGrandparent = 7;
    const aliveCheck = makeDefaultIsParentAlive({
      getPpid: () => 100,
      readGrandparentPpid: () => currentGrandparent,
    });

    let shutdownCalled = false;
    const cleanup = startLifecycleGuard({
      checkIntervalMs: 30,
      onShutdown: () => { shutdownCalled = true; },
      isParentAlive: aliveCheck,
    });

    // Flip the grandparent to init — guard should notice within one interval.
    currentGrandparent = 1;
    await new Promise((r) => setTimeout(r, 100));
    cleanup();
    assert.equal(shutdownCalled, true);
  });
});

// Integration tests spawn real child processes with stdin pipes and SIGTERM.
// Windows lacks POSIX signal semantics — SIGTERM kills without handler invocation,
// and stdin pipe close detection behaves differently. Skip on Windows.
const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("Lifecycle Guard — Integration (real process)", () => {
  test("child does NOT exit when stdin is closed (#236)", async () => {
    const { child, ready } = spawnGuardChild(42);

    await ready;
    child.stdin!.end();

    let exited = false;
    let exitCode: number | null = null;
    child.on("close", (code) => { exited = true; exitCode = code; });

    // Give the guard 500ms — if stdin-close still triggered shutdown, it
    // would have fired by now (previous implementation exited within ~1ms).
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(exited, false, `Child must stay alive after stdin.end(); exited with code ${exitCode}`);
    assert.equal(child.killed, false, "Child.killed should still be false");

    // Clean up: SIGTERM the still-alive child so the test runner doesn't leak.
    const closed = new Promise<number | null>((resolve) => {
      if (exited) return resolve(exitCode);
      child.on("close", resolve);
      setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 3000);
    });
    child.kill("SIGTERM");
    await closed;
  }, 10_000);

  test("child exits on SIGTERM", async () => {
    const { child, ready } = spawnGuardChild(43);

    await ready;
    child.kill("SIGTERM");

    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 5000);
    });

    assert.equal(code, 43, "Child should exit with code 43 on SIGTERM");
  }, 10_000);
});

describe("Lifecycle Guard — idle timeout (#565)", () => {
  test("idleTimeoutForEnv: default is disabled (0) unless host config opts in", () => {
    assert.equal(idleTimeoutForEnv({}), 0);
  });

  test("idleTimeoutForEnv: env override respected", () => {
    assert.equal(idleTimeoutForEnv({ CONTEXT_MODE_IDLE_TIMEOUT_MS: "60000" }), 60_000);
  });

  test("idleTimeoutForEnv: env=0 disables", () => {
    assert.equal(idleTimeoutForEnv({ CONTEXT_MODE_IDLE_TIMEOUT_MS: "0" }), 0);
  });

  test("idleTimeoutForEnv: malformed env falls back to disabled (safe default)", () => {
    assert.equal(idleTimeoutForEnv({ CONTEXT_MODE_IDLE_TIMEOUT_MS: "garbage" }), 0);
    assert.equal(idleTimeoutForEnv({ CONTEXT_MODE_IDLE_TIMEOUT_MS: "-1" }), 0);
  });

  test("shuts down when no activity for idleTimeoutMs", async () => {
    // Skip on TTY — guard intentionally skips idle check there.
    if (process.stdin.isTTY) return;

    let shutdownCalled = false;
    let fakeNow = 1_000_000;

    const handle = startLifecycleGuard({
      checkIntervalMs: 20,
      idleTimeoutMs: 100,
      isParentAlive: () => true,
      onShutdown: () => { shutdownCalled = true; },
      now: () => fakeNow,
    });

    // Advance simulated clock past the idle threshold.
    fakeNow += 200;
    await new Promise((r) => setTimeout(r, 80));

    handle();
    assert.equal(shutdownCalled, true, "idle timeout should trigger shutdown");
  });

  test("idle tick is INDEPENDENT of the 30s parent-liveness interval (regression for live-e2e bug)", async () => {
    // Bug observed in /tmp/ctx-mode-e2e e2e harness pre-fix: with
    // idleTimeoutMs=3000ms but checkIntervalMs left at default 30_000ms,
    // the idle check piggy-backed on the parent-liveness tick and never
    // fired within the test window. Fix: idle gets its OWN setInterval
    // with tick = min(idleTimeoutMs/6, 30_000ms, lower-bound 50ms).
    //
    // This test pins the contract by leaving checkIntervalMs at default
    // 30_000ms but giving idleTimeoutMs=300ms — if the idle path is
    // tied to checkIntervalMs again, it would not fire within the
    // 250ms wait below and the test fails.
    if (process.stdin.isTTY) return;

    let shutdownCalled = false;
    let fakeNow = 1_000_000;

    const handle = startLifecycleGuard({
      // checkIntervalMs intentionally NOT set → uses production default (30_000ms)
      idleTimeoutMs: 300,
      isParentAlive: () => true,
      onShutdown: () => { shutdownCalled = true; },
      now: () => fakeNow,
    });

    // Advance past the idle threshold, then wait less than checkIntervalMs.
    // If idle uses its own tick (≈50ms here), shutdown fires; if it doesn't,
    // we'd need to wait 30s for the parent-liveness tick.
    fakeNow += 500;
    await new Promise((r) => setTimeout(r, 250));

    handle();
    assert.equal(
      shutdownCalled,
      true,
      "idle timer must fire on its own tick, not piggy-back on checkIntervalMs",
    );
  });

  test("recordActivity() prevents idle shutdown", async () => {
    if (process.stdin.isTTY) return;

    let shutdownCalled = false;
    let fakeNow = 1_000_000;

    const handle = startLifecycleGuard({
      checkIntervalMs: 20,
      idleTimeoutMs: 100,
      isParentAlive: () => true,
      onShutdown: () => { shutdownCalled = true; },
      now: () => fakeNow,
    });

    // Bump activity timestamp every "tick" so the gap stays < idleTimeoutMs.
    for (let i = 0; i < 5; i++) {
      fakeNow += 50;
      handle.recordActivity();
      await new Promise((r) => setTimeout(r, 30));
    }

    handle();
    assert.equal(shutdownCalled, false, "active server must not shut down");
  });

  test("idleTimeoutMs=0 disables the idle check", async () => {
    if (process.stdin.isTTY) return;

    let shutdownCalled = false;
    let fakeNow = 1_000_000;

    const handle = startLifecycleGuard({
      checkIntervalMs: 20,
      idleTimeoutMs: 0,
      isParentAlive: () => true,
      onShutdown: () => { shutdownCalled = true; },
      now: () => fakeNow,
    });

    fakeNow += 10_000_000; // huge gap
    await new Promise((r) => setTimeout(r, 80));

    handle();
    assert.equal(shutdownCalled, false, "idleTimeoutMs=0 must disable idle shutdown");
  });

  test("returned handle is callable AND exposes recordActivity/stop", async () => {
    const handle = startLifecycleGuard({
      checkIntervalMs: 50,
      onShutdown: () => {},
      isParentAlive: () => true,
    });

    assert.equal(typeof handle, "function", "handle itself should be callable (legacy cleanup contract)");
    assert.equal(typeof handle.recordActivity, "function", "handle.recordActivity exposed");
    assert.equal(typeof handle.stop, "function", "handle.stop exposed");

    // Stop both ways — must be idempotent.
    handle.recordActivity();
    handle.stop();
    handle(); // calling the handle again must not throw
  });
});
