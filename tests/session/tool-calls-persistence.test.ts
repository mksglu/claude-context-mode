/**
 * tool-calls-persistence — Bug #1 + #2
 *
 * The ctx_stats counter currently lives in process memory only. When the
 * server restarts (upgrade) or the user runs `claude --continue`, the
 * counter resets to zero even though the session is logically the same.
 *
 * Fix: persist tool call counters in SessionDB so they survive process
 * restarts as long as the session_id is reused.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function tmpDbPath(): string {
  return join(tmpdir(), `tool-calls-${randomUUID()}.db`);
}

describe("Tool call counter persistence", () => {
  test("incrementToolCall + getToolCallStats round-trip in same instance", () => {
    const dbPath = tmpDbPath();
    const db = new SessionDB({ dbPath });
    cleanups.push(() => db.cleanup());

    db.incrementToolCall("sess-A", "ctx_search", 1024);
    db.incrementToolCall("sess-A", "ctx_search", 2048);
    db.incrementToolCall("sess-A", "ctx_fetch_and_index", 4096);

    const stats = db.getToolCallStats("sess-A");
    expect(stats.totalCalls).toBe(3);
    expect(stats.totalBytesReturned).toBe(1024 + 2048 + 4096);
    expect(stats.byTool.ctx_search.calls).toBe(2);
    expect(stats.byTool.ctx_search.bytesReturned).toBe(1024 + 2048);
    expect(stats.byTool.ctx_fetch_and_index.calls).toBe(1);
    expect(stats.byTool.ctx_fetch_and_index.bytesReturned).toBe(4096);
  });

  test("tool call counts persist across SessionDB instances (upgrade scenario)", () => {
    const dbPath = tmpDbPath();

    // Instance A — simulates the running server before upgrade
    const dbA = new SessionDB({ dbPath });
    dbA.incrementToolCall("sess-resume", "ctx_search", 100);
    dbA.incrementToolCall("sess-resume", "ctx_search", 200);
    dbA.incrementToolCall("sess-resume", "ctx_execute", 50);
    // close() — keeps file on disk so a fresh instance can re-open
    dbA.close();

    // Instance B — simulates the new server after upgrade / --continue
    const dbB = new SessionDB({ dbPath });
    cleanups.push(() => dbB.cleanup());
    const stats = dbB.getToolCallStats("sess-resume");

    expect(stats.totalCalls).toBe(3);
    expect(stats.totalBytesReturned).toBe(350);
    expect(stats.byTool.ctx_search.calls).toBe(2);
    expect(stats.byTool.ctx_execute.calls).toBe(1);
  });

  test("getToolCallStats returns zero stats for unknown session", () => {
    const db = new SessionDB({ dbPath: tmpDbPath() });
    cleanups.push(() => db.cleanup());

    const stats = db.getToolCallStats("never-seen");
    expect(stats.totalCalls).toBe(0);
    expect(stats.totalBytesReturned).toBe(0);
    expect(stats.byTool).toEqual({});
  });
});
