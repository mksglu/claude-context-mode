/**
 * SessionDB — bytes_avoided / bytes_returned schema migration (D2 PRD Phase 1).
 *
 * The session_events table must carry per-event byte accounting so the
 * Insight dashboard can compute "tokens returned" vs "tokens we kept out
 * of the model's context window". Both columns are NOT NULL with a
 * default of 0 so existing callers (and rows) keep working unchanged.
 */

import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, describe, test } from "vitest";
import Database from "better-sqlite3";
import { SessionDB } from "../../src/session/db.js";

interface ColInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | number | null;
}

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

/**
 * Create a SessionDB at a known on-disk path so the test can open a
 * second read-only handle against the same file to inspect schema.
 */
function createTestDB(): { db: SessionDB; dbPath: string } {
  const dbPath = join(tmpdir(), `session-bytes-migration-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return { db, dbPath };
}

function getColumnInfo(dbPath: string, table: string): Map<string, ColInfo> {
  const reader = new Database(dbPath, { readonly: true });
  try {
    const rows = reader.pragma(`table_xinfo(${table})`) as ColInfo[];
    return new Map(rows.map((r) => [r.name, r]));
  } finally {
    reader.close();
  }
}

/**
 * Hand-roll a legacy session_events table that omits both bytes columns,
 * to simulate a DB created by an older context-mode version.
 */
function seedLegacyDB(dbPath: string): void {
  const writer = new Database(dbPath);
  try {
    writer.exec(`
      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );
    `);
    writer.prepare(
      `INSERT INTO session_events
         (session_id, type, category, priority, data, source_hook, data_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("legacy-sess", "file", "file", 2, "/legacy/path.ts", "PostToolUse", "legacyhash");
  } finally {
    writer.close();
  }
}

describe("SessionDB bytes columns (D2 PRD Phase 1)", () => {
  test("session_events has bytes_avoided NOT NULL DEFAULT 0", () => {
    const { dbPath } = createTestDB();
    const cols = getColumnInfo(dbPath, "session_events");
    const col = cols.get("bytes_avoided");
    assert.ok(col, "bytes_avoided column must exist");
    assert.equal(col!.notnull, 1, "bytes_avoided must be NOT NULL");
    assert.equal(Number(col!.dflt_value), 0, "bytes_avoided default must be 0");
  });

  test("session_events has bytes_returned NOT NULL DEFAULT 0", () => {
    const { dbPath } = createTestDB();
    const cols = getColumnInfo(dbPath, "session_events");
    const col = cols.get("bytes_returned");
    assert.ok(col, "bytes_returned column must exist");
    assert.equal(col!.notnull, 1, "bytes_returned must be NOT NULL");
    assert.equal(Number(col!.dflt_value), 0, "bytes_returned default must be 0");
  });

  test("re-opening a migrated DB is idempotent (no duplicate columns or errors)", () => {
    const dbPath = join(tmpdir(), `session-bytes-idem-${randomUUID()}.db`);

    // First open: cold-create, runs full schema + migration path.
    const first = new SessionDB({ dbPath });
    first.cleanup();

    // Second open: hot-attach to the same file. Migration must be a no-op.
    // If the ALTER TABLE for bytes_avoided/bytes_returned is not guarded
    // by `cols.has(...)` this throws "duplicate column name".
    const second = new SessionDB({ dbPath });
    cleanups.push(() => second.cleanup());

    const cols = getColumnInfo(dbPath, "session_events");
    // Each column appears exactly once
    const all = Array.from(cols.values());
    assert.equal(all.filter((c) => c.name === "bytes_avoided").length, 1);
    assert.equal(all.filter((c) => c.name === "bytes_returned").length, 1);

    // Second instance must still be functional after no-op migration.
    second.ensureSession("idem-sess", "/p");
    second.insertEvent(
      "idem-sess",
      { type: "file", category: "file", data: "/idem.ts", priority: 2 },
      "PostToolUse",
    );
    assert.equal(second.getEventCount("idem-sess"), 1);
  });

  test("legacy DB auto-migrates and existing rows default to 0 for both bytes columns", () => {
    // Seed an "old format" file first, THEN open with SessionDB so the
    // migration code path runs against a real legacy schema.
    const dbPath = join(tmpdir(), `session-bytes-legacy-${randomUUID()}.db`);
    seedLegacyDB(dbPath);

    const db = new SessionDB({ dbPath });
    cleanups.push(() => db.cleanup());

    const cols = getColumnInfo(dbPath, "session_events");
    assert.ok(cols.get("bytes_avoided"), "bytes_avoided must be added by migration");
    assert.ok(cols.get("bytes_returned"), "bytes_returned must be added by migration");

    // Pre-existing row must read back with 0/0 for the new columns
    const reader = new Database(dbPath, { readonly: true });
    try {
      const row = reader.prepare(
        `SELECT bytes_avoided, bytes_returned FROM session_events WHERE session_id = ?`,
      ).get("legacy-sess") as { bytes_avoided: number; bytes_returned: number } | undefined;
      assert.ok(row, "legacy row must still be readable");
      assert.equal(row!.bytes_avoided, 0);
      assert.equal(row!.bytes_returned, 0);
    } finally {
      reader.close();
    }
  });
});
