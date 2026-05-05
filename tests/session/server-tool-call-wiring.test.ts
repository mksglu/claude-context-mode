/**
 * server-tool-call-wiring — Bug regression for /ctx-upgrade reset
 *
 * Originally fixed in 4742160 (added persistToolCallCounter), then
 * dropped as collateral by the b392c2f concurrency refactor. Same-session
 * statusline now flips to `0 calls / $0.00` after `/ctx-upgrade` because
 * the counter only lives in process memory and the read-side restore was
 * never wired in.
 *
 * Cycle 1 (write-back): the server-side helper must persist (toolName, bytes)
 * into the SessionDB tool_calls table so a fresh process can recover them.
 *
 * Cycle 2 (restore-on-startup): on boot, the server must hydrate
 * sessionStats.calls / bytesReturned / sessionStart from the latest session
 * row so the statusline picks up where the prior PID left off.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import {
  persistToolCallCounter,
  restoreSessionStats,
} from "../../src/session/persist-tool-calls.js";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-call-wiring-"));
  tmpDirs.push(dir);
  return join(dir, "session.db");
}

function seedSession(dbPath: string, sessionId: string): void {
  const db = new SessionDB({ dbPath });
  try {
    // ensureSession writes into session_meta with started_at = now()
    db.ensureSession(sessionId, "/fake/project");
  } finally {
    db.close();
  }
}

describe("Cycle 1 — persistToolCallCounter (write-back)", () => {
  test("no-op when DB file does not exist (best-effort, never throws)", () => {
    const missing = join(tmpdir(), `does-not-exist-${Date.now()}.db`);
    expect(() => persistToolCallCounter(missing, "ctx_search", 1024)).not.toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  test("no-op when DB exists but no session_meta row yet", () => {
    const dbPath = freshDbPath();
    // Create the schema only — no session row.
    new SessionDB({ dbPath }).close();
    expect(() => persistToolCallCounter(dbPath, "ctx_search", 100)).not.toThrow();
    // Counter should remain empty since there is no session to attach to.
    const db = new SessionDB({ dbPath });
    try {
      const stats = db.getToolCallStats("any-id");
      expect(stats.totalCalls).toBe(0);
    } finally {
      db.close();
    }
  });

  test("writes (toolName, bytes) under the latest session id", () => {
    const dbPath = freshDbPath();
    seedSession(dbPath, "sess-write-1");

    persistToolCallCounter(dbPath, "ctx_search", 1024);
    persistToolCallCounter(dbPath, "ctx_search", 2048);
    persistToolCallCounter(dbPath, "ctx_fetch_and_index", 4096);

    const db = new SessionDB({ dbPath });
    try {
      const stats = db.getToolCallStats("sess-write-1");
      expect(stats.totalCalls).toBe(3);
      expect(stats.totalBytesReturned).toBe(1024 + 2048 + 4096);
      expect(stats.byTool.ctx_search?.calls).toBe(2);
      expect(stats.byTool.ctx_search?.bytesReturned).toBe(3072);
      expect(stats.byTool.ctx_fetch_and_index?.calls).toBe(1);
    } finally {
      db.close();
    }
  });

  test("survives across SessionDB instance close — process-restart proxy", () => {
    const dbPath = freshDbPath();
    seedSession(dbPath, "sess-write-2");

    // First "process": writes 2 calls.
    persistToolCallCounter(dbPath, "ctx_execute", 500);
    persistToolCallCounter(dbPath, "ctx_execute", 700);

    // Second "process": new SessionDB instance, same dbPath.
    const db = new SessionDB({ dbPath });
    try {
      const stats = db.getToolCallStats("sess-write-2");
      expect(stats.totalCalls).toBe(2);
      expect(stats.totalBytesReturned).toBe(1200);
    } finally {
      db.close();
    }
  });
});

describe("Cycle 2 — restoreSessionStats (read-side)", () => {
  test("returns null when DB file is missing", () => {
    const missing = join(tmpdir(), `does-not-exist-${Date.now()}.db`);
    expect(restoreSessionStats(missing)).toBeNull();
  });

  test("returns null when DB exists but no sessions recorded", () => {
    const dbPath = freshDbPath();
    new SessionDB({ dbPath }).close();
    expect(restoreSessionStats(dbPath)).toBeNull();
  });

  test("hydrates calls + bytesReturned from latest session", () => {
    const dbPath = freshDbPath();
    seedSession(dbPath, "sess-restore-1");

    // Pre-seed prior tool-call rows (simulates work done by previous PID).
    persistToolCallCounter(dbPath, "ctx_search", 1500);
    persistToolCallCounter(dbPath, "ctx_search", 2500);
    persistToolCallCounter(dbPath, "ctx_execute", 800);

    const restored = restoreSessionStats(dbPath);
    expect(restored).not.toBeNull();
    expect(restored!.calls.ctx_search).toBe(2);
    expect(restored!.calls.ctx_execute).toBe(1);
    expect(restored!.bytesReturned.ctx_search).toBe(4000);
    expect(restored!.bytesReturned.ctx_execute).toBe(800);
  });

  test("hydrates sessionStart from session_meta.started_at", () => {
    const dbPath = freshDbPath();
    seedSession(dbPath, "sess-restore-2");
    persistToolCallCounter(dbPath, "ctx_search", 1);

    const restored = restoreSessionStats(dbPath);
    expect(restored).not.toBeNull();
    // sessionStart must be a finite epoch-ms in the past (or "now"-ish).
    expect(typeof restored!.sessionStart).toBe("number");
    expect(restored!.sessionStart).toBeGreaterThan(0);
    expect(restored!.sessionStart).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("returns latest session only when multiple exist", () => {
    const dbPath = freshDbPath();
    seedSession(dbPath, "sess-old");
    // Newer session — `started_at DESC LIMIT 1` should win.
    // SQLite datetime() resolves to 1-second granularity; pause briefly so the
    // newer row gets a strictly later timestamp.
    const wait = Date.now() + 1100;
    while (Date.now() < wait) { /* spin */ }
    seedSession(dbPath, "sess-new");

    persistToolCallCounter(dbPath, "ctx_search", 100);

    const restored = restoreSessionStats(dbPath);
    expect(restored).not.toBeNull();
    // Latest session only has one ctx_search row.
    expect(restored!.calls.ctx_search).toBe(1);
  });
});
