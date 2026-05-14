import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB } from "../../src/session/db.js";
import {
  flushToolCallCountersSync,
  persistToolCallCounter,
} from "../../src/session/persist-tool-calls.js";
import {
  emitIndexWriteEvent,
  emitSandboxExecuteEvent,
  flushSessionEventsSync,
} from "../../src/session/event-emit.js";

function withSessionDb(fn: (dbPath: string, sessionId: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "context-mode-session-coalesce-"));
  const dbPath = join(dir, "session.db");
  const sessionId = "session-coalesce";
  const db = new SessionDB({ dbPath });
  db.ensureSession(sessionId, "/tmp/context-mode");
  db.close();
  try {
    fn(dbPath, sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("coalesced SessionDB persistence", () => {
  test("tool call counters stay pending until flush and persist as one batch", () => {
    withSessionDb((dbPath, sessionId) => {
      persistToolCallCounter(dbPath, "ctx_search", 100);
      persistToolCallCounter(dbPath, "ctx_search", 50);
      persistToolCallCounter(dbPath, "ctx_index", 25);

      const before = new SessionDB({ dbPath });
      expect(before.getToolCallStats(sessionId).totalCalls).toBe(0);
      before.close();

      flushToolCallCountersSync();

      const after = new SessionDB({ dbPath });
      const stats = after.getToolCallStats(sessionId);
      after.close();
      expect(stats.totalCalls).toBe(3);
      expect(stats.totalBytesReturned).toBe(175);
      expect(stats.byTool.ctx_search.calls).toBe(2);
      expect(stats.byTool.ctx_search.bytesReturned).toBe(150);
      expect(stats.byTool.ctx_index.calls).toBe(1);
    });
  });

  test("session events stay pending until flush and persist in one drain", () => {
    withSessionDb((dbPath, sessionId) => {
      emitSandboxExecuteEvent({ sessionDbPath: dbPath, toolName: "ctx_execute", bytesReturned: 40 });
      emitIndexWriteEvent({ sessionDbPath: dbPath, source: "batch:test", bytesAvoided: 90 });

      const before = new SessionDB({ dbPath });
      expect(before.getEventCount(sessionId)).toBe(0);
      before.close();

      flushSessionEventsSync();

      const after = new SessionDB({ dbPath });
      expect(after.getEventCount(sessionId)).toBe(2);
      expect(after.getEventBytesSummary(sessionId)).toEqual({ bytesAvoided: 90, bytesReturned: 40 });
      after.close();
    });
  });
});
