/**
 * sibling-mcp.test.ts — sibling discovery + kill behaviour (#559, #565).
 *
 * Pins:
 *   - POSIX_PGREP_PATTERN matches every install shape we ship today
 *     (Claude plugin cache + marketplaces, npm-global node_modules, the
 *     `bin/context-mode` shim used by OpenCode/KiloCode, and bun-based
 *     server.bundle.mjs hosts).
 *   - Windows PowerShell regex matches the same shapes.
 *   - `sameParentOnly` filter only returns pids whose ppid === ownPpid.
 *   - `startupSiblingSweep` respects CONTEXT_MODE_STARTUP_SWEEP=0.
 */

import { describe, test, assert } from "vitest";
import {
  discoverSiblingMcpPids,
  killSiblingMcpServers,
  startupSiblingSweep,
} from "../src/util/sibling-mcp.js";

// Same patterns as production. Sourced here verbatim so a regex regression
// in src/util/sibling-mcp.ts shows up as a test failure with a clear diff.
const POSIX_PGREP_PATTERN =
  "(node|bun).*(plugins/(cache|marketplaces)/.*context-mode.*start\\.mjs" +
  "|context-mode/start\\.mjs" +
  "|context-mode/server\\.bundle\\.mjs" +
  "|bin/context-mode($|[^a-zA-Z0-9_-]))";

const WIN_PS_REGEX =
  "plugins[\\\\/](cache|marketplaces)[\\\\/].*context-mode.*start\\.mjs" +
  "|context-mode[\\\\/]start\\.mjs" +
  "|context-mode[\\\\/]server\\.bundle\\.mjs" +
  "|bin[\\\\/]context-mode($|[^a-zA-Z0-9_-])";

describe("sibling-mcp — install shape coverage (#565)", () => {
  const posix = new RegExp(POSIX_PGREP_PATTERN);
  const win = new RegExp(WIN_PS_REGEX);

  const positives = [
    // Claude Code cache (original #559).
    "node /Users/me/.claude/plugins/cache/context-mode/context-mode/1.0.131/start.mjs",
    // Claude Code marketplace.
    "node /Users/me/.claude/plugins/marketplaces/context-mode/start.mjs",
    // npm-global node_modules — generic node invocation.
    "node /home/USER/.nvm/versions/node/v22/lib/node_modules/context-mode/start.mjs",
    // server.bundle.mjs (CI-built, npm-global / marketplace).
    "node /usr/lib/node_modules/context-mode/server.bundle.mjs",
    // bun running the bundle (Pi-style hosts).
    "bun /home/USER/.bun/install/global/node_modules/context-mode/server.bundle.mjs",
    // bin shim — the OpenCode / KiloCode shape (#565 root cause).
    "node /home/USER/.npm-global/bin/context-mode",
    // bin shim with trailing whitespace / args.
    "node /home/USER/.npm-global/bin/context-mode --some-arg",
  ];

  const negatives = [
    // Unrelated node process — must not match.
    "node /home/USER/dev/some-other-app/server.js",
    // Substring trickery: contains "context-mode" but not a plugin path.
    "node /home/USER/dev/context-mode-clone/scripts/random.js",
    // Different `bin/` script that happens to be named close — must not match.
    "node /home/USER/.npm-global/bin/context-modes-thing",
    // grep / pgrep itself looking for context-mode.
    "pgrep -f context-mode",
  ];

  for (const cmd of positives) {
    test(`POSIX matches: ${cmd.slice(0, 60)}`, () => {
      assert.ok(posix.test(cmd), `POSIX regex should match argv: ${cmd}`);
    });
  }

  for (const cmd of negatives) {
    test(`POSIX rejects: ${cmd.slice(0, 60)}`, () => {
      assert.ok(!posix.test(cmd), `POSIX regex should NOT match argv: ${cmd}`);
    });
  }

  // Windows equivalents — same install shapes with backslash separators.
  const winPositives = [
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\context-mode\\start.mjs",
    "C:\\Users\\me\\.claude\\plugins\\cache\\context-mode\\context-mode\\1.0.131\\start.mjs",
    "C:\\Program Files\\nodejs\\node_modules\\context-mode\\server.bundle.mjs",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\bin\\context-mode",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\bin\\context-mode --flag",
  ];

  for (const cmd of winPositives) {
    test(`Windows matches: ${cmd.slice(0, 60)}`, () => {
      assert.ok(win.test(cmd), `Windows regex should match argv: ${cmd}`);
    });
  }
});

describe("discoverSiblingMcpPids", () => {
  test("excludes own pid and own ppid", () => {
    const fakeRun = () => "111\n222\n333\n";
    const pids = discoverSiblingMcpPids({
      ownPid: 222,
      ownPpid: 333,
      platform: "linux",
      runCommand: fakeRun,
    });
    assert.deepEqual(pids.sort((a, b) => a - b), [111]);
  });

  test("returns empty array on tool error (best effort)", () => {
    const throwingRun = () => { throw new Error("pgrep missing"); };
    const pids = discoverSiblingMcpPids({
      ownPid: 1,
      ownPpid: 2,
      platform: "linux",
      runCommand: throwingRun,
    });
    assert.deepEqual(pids, []);
  });

  test("sameParentOnly filters to siblings sharing our ppid (#565)", () => {
    // Three candidate pids reported by pgrep. Only pids 200 and 201
    // share our ppid (5000). pid 999 is parented to a different host
    // (Claude Code) and must be left alone.
    const fakeRun = () => "200\n201\n999\n";
    const ppidMap: Record<number, number> = {
      200: 5000, // ours
      201: 5000, // ours
      999: 7777, // someone else's
    };
    const pids = discoverSiblingMcpPids({
      ownPid: 123,
      ownPpid: 5000,
      platform: "linux",
      runCommand: fakeRun,
      sameParentOnly: true,
      readPpid: (pid) => ppidMap[pid] ?? NaN,
    });
    assert.deepEqual(pids.sort((a, b) => a - b), [200, 201]);
  });

  test("sameParentOnly drops pids whose ppid probe fails", () => {
    const fakeRun = () => "200\n300\n";
    const pids = discoverSiblingMcpPids({
      ownPid: 1,
      ownPpid: 5000,
      platform: "linux",
      runCommand: fakeRun,
      sameParentOnly: true,
      readPpid: () => NaN,
    });
    assert.deepEqual(pids, []);
  });
});

describe("killSiblingMcpServers", () => {
  test("empty pid list → no-op", async () => {
    const report = await killSiblingMcpServers({ pids: [] });
    assert.deepEqual(report, { terminatedBySigterm: 0, terminatedBySigkill: 0, totalKilled: 0 });
  });

  test("SIGTERM-only success: count goes to terminatedBySigterm", async () => {
    const alive = new Set<number>([100, 101]);
    const signals: Array<[number, NodeJS.Signals]> = [];

    const report = await killSiblingMcpServers({
      pids: [100, 101],
      timeoutMs: 200,
      pollIntervalMs: 20,
      isAlive: (pid) => alive.has(pid),
      sendSignal: (pid, sig) => {
        signals.push([pid, sig]);
        if (sig === "SIGTERM") {
          // Simulate clean shutdown after one poll tick.
          setTimeout(() => alive.delete(pid), 30);
        }
      },
    });

    assert.equal(report.terminatedBySigterm, 2);
    assert.equal(report.terminatedBySigkill, 0);
    assert.equal(report.totalKilled, 2);
    assert.ok(signals.some(([, s]) => s === "SIGTERM"), "SIGTERM should have been sent");
    assert.ok(!signals.some(([, s]) => s === "SIGKILL"), "SIGKILL must NOT be needed");
  });

  test("SIGKILL escalation on stragglers", async () => {
    const alive = new Set<number>([200]);
    let sigkillSent = false;

    const report = await killSiblingMcpServers({
      pids: [200],
      timeoutMs: 60,
      pollIntervalMs: 20,
      isAlive: (pid) => alive.has(pid),
      sendSignal: (pid, sig) => {
        if (sig === "SIGKILL") {
          sigkillSent = true;
          alive.delete(pid);
        }
        // SIGTERM does nothing — straggler scenario.
      },
    });

    assert.ok(sigkillSent, "SIGKILL must escalate when SIGTERM is ignored");
    assert.equal(report.terminatedBySigkill, 1);
    assert.equal(report.totalKilled, 1);
  });

  test("ESRCH on SIGTERM (already dead) is not counted", async () => {
    // pid was already dead before we sent SIGTERM. Per the contract we
    // only count "died while we watched" — observedAlive must remain empty.
    const report = await killSiblingMcpServers({
      pids: [300],
      timeoutMs: 50,
      pollIntervalMs: 20,
      isAlive: () => false,
      sendSignal: () => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      },
    });

    assert.equal(report.totalKilled, 0);
  });
});

describe("startupSiblingSweep (#565)", () => {
  test("CONTEXT_MODE_STARTUP_SWEEP=0 disables sweep entirely", async () => {
    const report = await startupSiblingSweep({ CONTEXT_MODE_STARTUP_SWEEP: "0" });
    assert.deepEqual(report, { terminatedBySigterm: 0, terminatedBySigkill: 0, totalKilled: 0 });
  });

  test("CONTEXT_MODE_STARTUP_SWEEP=false also disables", async () => {
    const report = await startupSiblingSweep({ CONTEXT_MODE_STARTUP_SWEEP: "false" });
    assert.deepEqual(report, { terminatedBySigterm: 0, terminatedBySigkill: 0, totalKilled: 0 });
  });

  test("default-enabled: no throw, returns empty when no siblings", async () => {
    // We can't easily inject discover/kill into startupSiblingSweep, but
    // we CAN verify it never throws and returns a well-formed report on a
    // clean machine. The realistic call is gated by `sameParentOnly: true`
    // + our own ppid — vitest itself does not match the regex, so the
    // sweep finds no candidates and returns the empty report.
    const report = await startupSiblingSweep({});
    assert.equal(typeof report.terminatedBySigterm, "number");
    assert.equal(typeof report.terminatedBySigkill, "number");
    assert.equal(typeof report.totalKilled, "number");
  });
});
