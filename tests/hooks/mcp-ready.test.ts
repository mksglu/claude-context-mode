/**
 * mcp-ready.mjs regression matrix (#347 guard).
 *
 * PR #347 replaced the PPID-keyed sentinel lookup with a directory-scan over
 * `<sentinelDir()>/context-mode-mcp-ready-*` files. The 11 test files updated
 * by #347 changed the sentinel path but did not assert the load-bearing
 * contract — that `isMCPReady()` returns true when the sentinel was written
 * by a process whose PID is not in the test runner's process tree.
 *
 * This file locks in:
 *   1. `sentinelPathForPid` shape, deprecated `sentinelPath` backward-compat.
 *   2. `sentinelDir()` platform branch (/tmp on Unix, os.tmpdir() on win32).
 *   3. `isMCPReady()` happy path + resilience to malformed payloads.
 *   4. `isMCPReady()` cleanup of dead-PID sentinels (#347 self-healing).
 *   5. PPID-independence — sentinel at child.pid (∉ runner tree) → true.
 *
 * The cleanup tests assume a fresh `sentinelDir()` (no other live sentinels).
 * They skip locally when the dev's MCP server has its own live sentinel,
 * since `isMCPReady()` returns on the first live PID it encounters and the
 * cleanup of unrelated dead sentinels becomes order-dependent. In CI the
 * directory is clean, so these tests run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sentinelDir,
  sentinelPathForPid,
  sentinelPath,
  isMCPReady,
} from "../../hooks/core/mcp-ready.mjs";

const SENTINEL_PREFIX = "context-mode-mcp-ready-";
const DEAD_PID = 2_147_483_647; // INT32_MAX — never a live PID on any platform

// Track sentinels we create so cleanup runs even on assertion failure.
const fixtures = new Set<string>();
function createSentinel(pidOrLabel: number | string, content?: string): string {
  const path = join(sentinelDir(), `${SENTINEL_PREFIX}${pidOrLabel}`);
  writeFileSync(path, content ?? String(pidOrLabel));
  fixtures.add(path);
  return path;
}
afterEach(() => {
  for (const p of fixtures) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
  fixtures.clear();
});

// Detect whether another process already has a live sentinel in sentinelDir().
// Used to gate cleanup tests whose assertions depend on iteration order.
function hasUnrelatedLiveSentinel(): boolean {
  try {
    const dir = sentinelDir();
    for (const f of readdirSync(dir).filter((f) => f.startsWith(SENTINEL_PREFIX))) {
      try {
        const pid = parseInt(readFileSync(join(dir, f), "utf8"), 10);
        if (!Number.isNaN(pid) && pid !== process.pid) {
          process.kill(pid, 0);
          return true;
        }
      } catch { /* dead — ignore */ }
    }
    return false;
  } catch {
    return false;
  }
}
const POLLUTED = hasUnrelatedLiveSentinel();

describe("mcp-ready: contract", () => {
  it("sentinelPathForPid joins sentinelDir + prefix + pid", () => {
    expect(sentinelPathForPid(12345)).toBe(join(sentinelDir(), `${SENTINEL_PREFIX}12345`));
  });

  it("sentinelPath (deprecated) still resolves to a path keyed by process.ppid", () => {
    expect(sentinelPath()).toBe(join(sentinelDir(), `${SENTINEL_PREFIX}${process.ppid}`));
  });

  describe("sentinelDir platform branch", () => {
    let originalPlatform: NodeJS.Platform;
    beforeEach(() => { originalPlatform = process.platform; });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("returns os.tmpdir() on win32", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(sentinelDir()).toBe(tmpdir());
    });

    it("returns /tmp on non-win32", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(sentinelDir()).toBe("/tmp");
    });
  });

  it("isMCPReady returns true when a sentinel with a live PID exists", () => {
    createSentinel(process.pid);
    expect(isMCPReady()).toBe(true);
  });

  it("isMCPReady does not throw on empty-payload sentinels", () => {
    createSentinel("test-empty-9991", "");
    expect(() => isMCPReady()).not.toThrow();
  });

  it("isMCPReady does not throw on non-numeric-payload sentinels", () => {
    createSentinel("test-garbage-9992", "abc");
    expect(() => isMCPReady()).not.toThrow();
  });
});

describe.skipIf(POLLUTED)("mcp-ready: stale-cleanup self-healing", () => {
  it("unlinks a sentinel whose PID is dead", () => {
    const path = createSentinel(DEAD_PID);
    isMCPReady();
    expect(existsSync(path)).toBe(false);
    fixtures.delete(path);
  });

  it("unlinks two dead sentinels in a single scan", () => {
    const a = createSentinel(DEAD_PID);
    const b = createSentinel(DEAD_PID - 1);
    expect(isMCPReady()).toBe(false);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    fixtures.delete(a);
    fixtures.delete(b);
  });
});

describe("mcp-ready: PPID-independence (regression for #347)", () => {
  it("returns true when the only live sentinel is at a child PID outside the runner's process tree", async () => {
    const childScript = `
      const { writeFileSync, unlinkSync } = require("node:fs");
      const { tmpdir } = require("node:os");
      const { join } = require("node:path");
      const dir = process.platform === "win32" ? tmpdir() : "/tmp";
      const path = join(dir, "context-mode-mcp-ready-" + process.pid);
      writeFileSync(path, String(process.pid));
      const cleanup = () => { try { unlinkSync(path); } catch {} process.exit(0); };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", childScript], { stdio: "ignore" });
    const childPid = child.pid!;
    const childSentinel = join(sentinelDir(), `${SENTINEL_PREFIX}${childPid}`);

    try {
      // Wait up to 2s for child to write its sentinel.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !existsSync(childSentinel)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(childSentinel)).toBe(true);

      // The regression-defining assertion: the sentinel's PID is not in the
      // test runner's process tree. A PPID-keyed lookup would return false here.
      expect(childPid).not.toBe(process.pid);
      expect(childPid).not.toBe(process.ppid);

      // Directory-scan finds the child's sentinel regardless of PPID.
      expect(isMCPReady()).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.on("exit", () => r()));
      try { unlinkSync(childSentinel); } catch { /* child cleaned up */ }
    }
  });
});
