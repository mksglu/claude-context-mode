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
import { startLifecycleGuard } from "../src/lifecycle.js";

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
