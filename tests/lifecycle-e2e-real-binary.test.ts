/**
 * lifecycle-e2e-real-binary.test.ts — end-to-end validation against
 * the actual built `start.mjs` + `server.bundle.mjs` binary.
 *
 * These tests catch regressions the unit suite cannot:
 *
 *   1. Bundle drift (build step skipped → fix-in-source-only ships dead).
 *      Verified by spawning the real `start.mjs` and checking it loads
 *      the patched bundle.
 *
 *   2. Idle timer wall-clock cadence. The unit test uses an injectable
 *      `now`; the e2e test uses real Date.now and verifies the idle
 *      check actually fires within its configured window — this caught
 *      a bug where idle was piggy-backed on the 30s checkIntervalMs and
 *      never reacted for short timeouts.
 *
 *   3. Real-binary sibling sweep. Spawns 3 decoy `start.mjs` children,
 *      then spawns a 4th — verifies the 4th's startup sweep reaps the
 *      other 3 via real pgrep + SIGTERM signal delivery, and emits
 *      the `Reaped N stale sibling` stderr line.
 *
 *   4. JSON-RPC request path is intact post-_onrequest wrap. We send
 *      `initialize` + `tools/list` and require a `"tools"` substring
 *      in stdout before the idle window closes — i.e. wrapping the
 *      SDK's request hook didn't break request handling.
 *
 * Skipped on Windows (uses POSIX `ps`/`pgrep` semantics + signal model).
 * Skipped automatically when the bundle is missing (tree wasn't built).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const START_MJS = resolve(REPO_ROOT, "start.mjs");
const BUNDLE = resolve(REPO_ROOT, "server.bundle.mjs");

const POSIX = process.platform !== "win32";
const BUILT = existsSync(START_MJS) && existsSync(BUNDLE);
const RUN = POSIX && BUILT;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!RUN)("lifecycle e2e — real binary (#565)", () => {
  beforeAll(() => {
    if (!RUN) {
      // Vitest's `.skipIf` already skips, but emit a helpful hint to stderr.
      const reason = !POSIX ? "non-POSIX host" : "bundle missing — run `npm run build`";
      process.stderr.write(`[lifecycle-e2e] skipped: ${reason}\n`);
    }
  });

  it("idle timeout fires on real wall-clock against built start.mjs", async () => {
    // Use a short idle window for test speed; keep it well above test/runner
    // jitter (CI workers sometimes pause for a couple seconds).
    const IDLE_MS = 4_000;
    const HARD_DEADLINE = IDLE_MS + 15_000;

    const child = spawn(process.execPath, [START_MJS], {
      env: {
        ...process.env,
        CONTEXT_MODE_IDLE_TIMEOUT_MS: String(IDLE_MS),
        CONTEXT_MODE_STARTUP_SWEEP: "0", // isolated test — don't reap siblings
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (b) => { stdoutBuf += b.toString(); });
    child.stderr.on("data", (b) => { stderrBuf += b.toString(); });

    try {
      // Wait for boot, then drive a tools/list to confirm the request path
      // works post-_onrequest-wrap. We DO NOT bump activity after this; we
      // want the server to go idle and self-exit.
      await settle(1500);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2024-11-05", capabilities: {},
          clientInfo: { name: "lifecycle-e2e", version: "0" },
        },
      }) + "\n");
      await settle(500);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list",
      }) + "\n");

      // Race exit-promise against hard deadline.
      const tStart = Date.now();
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsed: number } | null>((resolve) => {
        child.on("exit", (code, signal) => {
          resolve({ code, signal, elapsed: Date.now() - tStart });
        });
        setTimeout(() => resolve(null), HARD_DEADLINE);
      });

      // Diagnostic dump on failure.
      if (!exit) {
        try { child.kill("SIGKILL"); } catch { /* */ }
        // eslint-disable-next-line no-console
        console.error(
          "[lifecycle-e2e] idle timeout failed to fire. stderr:\n",
          stderrBuf.slice(0, 1000),
          "\nstdout (first 500 chars):\n",
          stdoutBuf.slice(0, 500),
        );
      }

      expect(exit).not.toBeNull();
      expect(exit!.elapsed).toBeGreaterThanOrEqual(IDLE_MS);
      expect(exit!.elapsed).toBeLessThan(HARD_DEADLINE);
      // Clean shutdown via gracefulShutdown() → process.exit(0), not SIGKILL.
      expect(exit!.signal).toBeNull();
      // Request path intact — tools/list responded before idle close.
      expect(stdoutBuf).toMatch(/"tools"/);
    } finally {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch { /* */ }
      }
    }
  }, 30_000);

  it("startup sweep reaps stale siblings spawned under our ppid", async () => {
    const decoys: ChildProcessWithoutNullStreams[] = [];
    let sweepChild: ChildProcessWithoutNullStreams | null = null;

    try {
      // Spawn 3 decoys with sweep disabled — they should idle indefinitely
      // and parent to THIS test process (i.e. they share our ppid via
      // process.ppid via the way Node spawns work — actually they parent
      // to US, so OUR ppid is what they share. discoverSiblingMcpPids
      // with sameParentOnly uses ownPpid = process.ppid; therefore the
      // sweep child we spawn next must have ITS ppid match the decoy's
      // ppid. Since both are children of THIS test process, both have
      // ppid = process.pid (this test). So sweepChild.ownPpid = our pid,
      // and the decoys' ppid is also our pid → they match.
      for (let i = 0; i < 3; i++) {
        const d = spawn(process.execPath, [START_MJS], {
          env: {
            ...process.env,
            CONTEXT_MODE_IDLE_TIMEOUT_MS: "0",      // no self-exit
            CONTEXT_MODE_STARTUP_SWEEP: "0",        // don't reap each other
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        d.stderr.on("data", () => {});
        d.stdout.on("data", () => {});
        decoys.push(d);
      }

      // Wait for decoys to be fully up.
      await settle(2500);

      const decoyPids = decoys.map((d) => d.pid!).filter(Boolean);
      expect(decoyPids).toHaveLength(3);
      expect(decoyPids.every(isAlive)).toBe(true);

      // Spawn the 4th — sweep ENABLED. It should reap the other 3 at boot.
      sweepChild = spawn(process.execPath, [START_MJS], {
        env: {
          ...process.env,
          CONTEXT_MODE_IDLE_TIMEOUT_MS: "0",
          CONTEXT_MODE_STARTUP_SWEEP: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let sweepStderr = "";
      sweepChild.stderr.on("data", (b) => { sweepStderr += b.toString(); });
      sweepChild.stdout.on("data", () => {});

      // Allow sweep + SIGTERM round-trip + decoy graceful-shutdown to settle.
      await settle(4500);

      const alive = decoyPids.filter(isAlive);
      if (alive.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          "[lifecycle-e2e] sweep failed — survivors:", alive,
          "\nsweep stderr:", sweepStderr.slice(0, 600),
        );
      }
      expect(alive).toHaveLength(0);
      expect(sweepStderr).toMatch(/Reaped \d+ stale sibling MCP server/);
    } finally {
      for (const d of decoys) {
        if (!d.killed) {
          try { d.kill("SIGKILL"); } catch { /* */ }
        }
      }
      if (sweepChild && !sweepChild.killed) {
        try { sweepChild.kill("SIGKILL"); } catch { /* */ }
      }
    }
  }, 25_000);
});
