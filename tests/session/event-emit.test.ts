/**
 * event-emit — Phase 5+7 of D2 PRD (stats-event-driven-architecture)
 *
 * Server-side emitters that write rows directly into `session_events`
 * with the new `bytes_avoided` / `bytes_returned` columns the schema
 * engineer added. Each emitter is fire-and-forget (best-effort) so a
 * stats failure can never break the parent MCP tool call.
 *
 * The emitters live in `src/session/event-emit.ts` instead of `db.ts`
 * because:
 * 1. db.ts is owned by the schema engineer in this branch — additive
 *    server-side helpers don't belong to that surface.
 * 2. Direct-SQL inserts here let the renderer use the new columns
 *    without waiting for `insertEvent` to grow an options bag.
 * 3. Best-effort error swallowing matches the persist-tool-calls.ts
 *    sibling helper (same wiring pattern from `trackResponse`).
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { loadDatabase } from "../../src/db-base.js";
import {
  emitCacheHitEvent,
  emitIndexWriteEvent,
  emitSandboxExecuteEvent,
} from "../../src/session/event-emit.js";

interface RawEventRow {
  type: string;
  category: string;
  bytes_returned: number;
  bytes_avoided: number;
  data: string;
}

/** Read raw rows including the new columns the SessionDB API doesn't surface. */
function readEvents(dbPath: string, sessionId: string, type: string): RawEventRow[] {
  const Database = loadDatabase();
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw
      .prepare(
        "SELECT type, category, bytes_returned, bytes_avoided, data FROM session_events " +
        "WHERE session_id = ? AND type = ?",
      )
      .all(sessionId, type) as RawEventRow[];
  } finally {
    raw.close();
  }
}

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function tmpDbPath(): string {
  return join(tmpdir(), `event-emit-${randomUUID()}.db`);
}

/** Seed a session_meta row so the helper can resolve the latest session id. */
function seedSession(dbPath: string, sessionId: string): SessionDB {
  const sdb = new SessionDB({ dbPath });
  // ensureSession creates the session_meta row used by getLatestSessionId().
  sdb.ensureSession(sessionId, "/tmp/proj");
  return sdb;
}

describe("event-emit (Phase 5/7 server-side emitters)", () => {
  test("emitSandboxExecuteEvent writes bytes_returned to session_events", () => {
    const dbPath = tmpDbPath();
    const sid = `sess-${randomUUID()}`;
    const sdb = seedSession(dbPath, sid);
    cleanups.push(() => { try { sdb.close(); } catch {} try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch {} });

    emitSandboxExecuteEvent({
      sessionDbPath: dbPath,
      toolName: "ctx_execute",
      bytesReturned: 1234,
    });
    sdb.close(); // release lock so the raw reader can open

    const rows = readEvents(dbPath, sid, "sandbox-execute");
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe("sandbox");
    expect(rows[0].type).toBe("sandbox-execute");
    expect(rows[0].bytes_returned).toBe(1234);
    expect(rows[0].bytes_avoided).toBe(0);
    expect(rows[0].data).toBe("ctx_execute");
  });

  test("emitIndexWriteEvent writes bytes_avoided to session_events", () => {
    const dbPath = tmpDbPath();
    const sid = `sess-${randomUUID()}`;
    const sdb = seedSession(dbPath, sid);
    cleanups.push(() => { try { sdb.close(); } catch {} try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch {} });

    emitIndexWriteEvent({
      sessionDbPath: dbPath,
      source: "execute:javascript",
      bytesAvoided: 5678,
    });
    sdb.close();

    const rows = readEvents(dbPath, sid, "index-write");
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe("sandbox");
    expect(rows[0].bytes_avoided).toBe(5678);
    expect(rows[0].bytes_returned).toBe(0);
    expect(rows[0].data).toBe("execute:javascript");
  });

  test("emitCacheHitEvent writes bytes_avoided to session_events", () => {
    const dbPath = tmpDbPath();
    const sid = `sess-${randomUUID()}`;
    const sdb = seedSession(dbPath, sid);
    cleanups.push(() => { try { sdb.close(); } catch {} try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch {} });

    emitCacheHitEvent({
      sessionDbPath: dbPath,
      source: "https://example.com/docs",
      bytesAvoided: 9000,
    });
    sdb.close();

    const rows = readEvents(dbPath, sid, "cache-hit");
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe("cache");
    expect(rows[0].bytes_avoided).toBe(9000);
    expect(rows[0].bytes_returned).toBe(0);
  });

  test("emitters never throw on missing DB (best-effort)", () => {
    const missing = join(tmpdir(), `does-not-exist-${randomUUID()}.db`);
    expect(() => emitSandboxExecuteEvent({ sessionDbPath: missing, toolName: "x", bytesReturned: 1 })).not.toThrow();
    expect(() => emitIndexWriteEvent({ sessionDbPath: missing, source: "x", bytesAvoided: 1 })).not.toThrow();
    expect(() => emitCacheHitEvent({ sessionDbPath: missing, source: "x", bytesAvoided: 1 })).not.toThrow();
  });

  test("emitters skip silently when no session exists in the DB", () => {
    const dbPath = tmpDbPath();
    const sdb = new SessionDB({ dbPath });
    // No insertEvent → no session_meta row → emitter must return without throwing.
    expect(() => emitSandboxExecuteEvent({ sessionDbPath: dbPath, toolName: "x", bytesReturned: 1 })).not.toThrow();
    sdb.close();
    cleanups.push(() => { try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch {} });

    const Database = loadDatabase();
    const raw = new Database(dbPath, { readonly: true });
    try {
      const r = raw.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number };
      expect(r.n).toBe(0);
    } finally {
      raw.close();
    }
  });
});
