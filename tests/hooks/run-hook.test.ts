/**
 * run-hook.mjs — TDD tests for crash-resilient hook wrapper (#414)
 *
 * Verifies:
 *   1. handler invoked when imports succeed
 *   2. throws inside handler get logged + exit 0
 *   3. failing dynamic side-effect imports don't crash with MODULE_NOT_FOUND
 *   4. uncaughtException doesn't propagate — exit 0 always
 *
 * Subprocess pattern: spawn a fresh node per test with HOME pointed at tmp,
 * import run-hook.mjs from the repo, exercise it, then assert log contents.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const RUN_HOOK_PATH = resolve(REPO_ROOT, "hooks", "run-hook.mjs");

function runScript(script: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
    timeout: 15_000,
  });
}

describe("runHook wrapper", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "runhook-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("invokes the handler when imports succeed", () => {
    const script = `
      import { runHook } from ${JSON.stringify(RUN_HOOK_PATH)};
      let called = false;
      await runHook(async () => { called = true; });
      console.log("called=" + called);
    `;
    const r = runScript(script, { HOME: tmpHome, USERPROFILE: tmpHome });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("called=true");
  });

  it("logs to ~/.claude/context-mode/hook-errors.log when handler throws, then exits 0", () => {
    const script = `
      import { runHook } from ${JSON.stringify(RUN_HOOK_PATH)};
      await runHook(async () => { throw new Error("boom-handler"); });
      console.log("after-runHook");
    `;
    const r = runScript(script, { HOME: tmpHome, USERPROFILE: tmpHome });
    expect(r.status).toBe(0);
    // After process.exit(0) the trailing console.log should NOT print.
    expect(r.stdout).not.toContain("after-runHook");

    const logPath = join(tmpHome, ".claude", "context-mode", "hook-errors.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("boom-handler");
  });

  it("logs and exits 0 when a side-effect dynamic import throws (does NOT crash with MODULE_NOT_FOUND)", () => {
    // Stage a fake hook dir whose suppress-stderr.mjs throws on load.
    // run-hook.mjs is hard-coded to dynamic-import "./suppress-stderr.mjs"
    // and "./ensure-deps.mjs" relative to ITS OWN dir, so we must copy
    // run-hook.mjs into a tmp dir with a poisoned sibling.
    const fakeHookDir = join(tmpHome, "fake-hooks");
    mkdirSync(fakeHookDir, { recursive: true });
    // Copy the real run-hook.mjs unchanged
    const realRunHook = readFileSync(RUN_HOOK_PATH, "utf-8");
    writeFileSync(join(fakeHookDir, "run-hook.mjs"), realRunHook);
    // Poisoned side-effect modules — throw at module load
    writeFileSync(join(fakeHookDir, "suppress-stderr.mjs"), `throw new Error("poisoned-suppress");`);
    writeFileSync(join(fakeHookDir, "ensure-deps.mjs"), `throw new Error("poisoned-deps");`);

    const fakePath = join(fakeHookDir, "run-hook.mjs");
    const script = `
      import { runHook } from ${JSON.stringify(fakePath)};
      let called = false;
      await runHook(async () => { called = true; });
      console.log("called=" + called);
    `;
    const r = runScript(script, { HOME: tmpHome, USERPROFILE: tmpHome });
    expect(r.status).toBe(0);
    // Handler still invoked even though side-effect imports failed
    expect(r.stdout).toContain("called=true");
    // No MODULE_NOT_FOUND propagation
    expect(r.stderr).not.toContain("MODULE_NOT_FOUND");

    const logPath = join(tmpHome, ".claude", "context-mode", "hook-errors.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("poisoned-suppress");
    expect(log).toContain("poisoned-deps");
  });

  it("does NOT propagate uncaughtException — exits 0", () => {
    // Schedule an async throw that escapes the handler's try/catch
    // by deferring it to the next tick.
    const script = `
      import { runHook } from ${JSON.stringify(RUN_HOOK_PATH)};
      await runHook(async () => {
        // Fire-and-forget rejection (escapes handler's try/catch via microtask)
        setImmediate(() => { throw new Error("late-uncaught"); });
        // Return so handler resolves; uncaughtException fires after.
      });
      // Keep event loop alive long enough for setImmediate to fire
      await new Promise((r) => setTimeout(r, 100));
      console.log("survived");
    `;
    const r = runScript(script, { HOME: tmpHome, USERPROFILE: tmpHome });
    // The uncaughtException handler MUST exit 0
    expect(r.status).toBe(0);
    // We exit 0 from inside the uncaughtException handler — "survived" should NOT print
    expect(r.stdout).not.toContain("survived");

    const logPath = join(tmpHome, ".claude", "context-mode", "hook-errors.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("late-uncaught");
  });
});
