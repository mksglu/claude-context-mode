/**
 * Tests for the database provider layer — verifies both native (better-sqlite3)
 * and fallback (sql.js) paths produce working databases.
 *
 * These tests exercise the SqlJsDatabaseWrapper directly (since better-sqlite3
 * is available in dev, the fallback path would not activate automatically).
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { SqlJsDatabaseWrapper, initSqlJsEngine } from "../src/sqljs-wrapper.js";
import { isFallbackMode, loadDatabase } from "../src/db-base.js";

function tmpDbPath(): string {
  return join(tmpdir(), `test-sqljs-${randomBytes(4).toString("hex")}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────
// isFallbackMode / loadDatabase
// ─────────────────────────────────────────────────────────

describe("loadDatabase", () => {
  it("returns a constructor when better-sqlite3 is available", () => {
    const Database = loadDatabase();
    expect(Database).not.toBeNull();
  });

  it("isFallbackMode returns a boolean", () => {
    expect(typeof isFallbackMode()).toBe("boolean");
  });
});

// ─────────────────────────────────────────────────────────
// SqlJsDatabaseWrapper — unit tests
// ─────────────────────────────────────────────────────────

describe("SqlJsDatabaseWrapper", () => {
  let dbPath: string;
  let db: SqlJsDatabaseWrapper;

  beforeAll(async () => {
    await initSqlJsEngine();
  });

  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
    if (dbPath) cleanupDb(dbPath);
  });

  it("creates a database and runs schema", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      );
    `);
    // Should not throw
    expect(true).toBe(true);
  });

  it("insert and select via prepare/run/get/all", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, value INTEGER)");

    const insert = db.prepare("INSERT INTO items (name, value) VALUES (?, ?)");
    const r1 = insert.run("alpha", 10);
    expect(r1.changes).toBe(1);
    expect(Number(r1.lastInsertRowid)).toBeGreaterThan(0);

    insert.run("beta", 20);
    insert.run("gamma", 30);

    const get = db.prepare("SELECT * FROM items WHERE name = ?");
    const row = get.get("beta") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.name).toBe("beta");
    expect(row.value).toBe(20);

    const all = db.prepare("SELECT * FROM items ORDER BY id");
    const rows = all.all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0].name).toBe("alpha");
    expect(rows[2].name).toBe("gamma");
  });

  it("get returns undefined for no match", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");

    const result = db.prepare("SELECT * FROM items WHERE id = ?").get(999);
    expect(result).toBeUndefined();
  });

  it("iterate yields rows one at a time", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

    const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
    insert.run("a");
    insert.run("b");
    insert.run("c");

    const iter = db.prepare("SELECT * FROM items ORDER BY id").iterate();
    const collected: unknown[] = [];
    for (const row of iter) {
      collected.push(row);
    }
    expect(collected).toHaveLength(3);
  });

  it("pragma returns values", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);

    // WAL mode is silently ignored in sql.js, but pragma should not throw
    const result = db.pragma("journal_mode = WAL");
    // sql.js may return "memory" or "delete" instead of "wal", that's fine
    expect(result).toBeDefined();
  });

  it("transaction commits on success", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

    const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
    const txn = db.transaction(() => {
      insert.run("x");
      insert.run("y");
    });
    txn();

    const rows = db.prepare("SELECT * FROM items").all();
    expect(rows).toHaveLength(2);
  });

  it("transaction rolls back on error", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)");

    const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
    const txn = db.transaction(() => {
      insert.run("ok");
      // Force an error
      throw new Error("rollback test");
    });

    expect(() => txn()).toThrow("rollback test");

    const rows = db.prepare("SELECT * FROM items").all();
    expect(rows).toHaveLength(0);
  });

  it("persists to file and reopens", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
    db.prepare("INSERT INTO items (name) VALUES (?)").run("persisted");
    db.close();

    expect(existsSync(dbPath)).toBe(true);

    // Reopen
    const db2 = new SqlJsDatabaseWrapper(dbPath);
    const row = db2.prepare("SELECT * FROM items WHERE name = ?").get("persisted") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.name).toBe("persisted");
    db2.close();
  });

  it("works with SessionDB-like schema (no FTS5)", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);

    // Simulate SessionDB schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Insert and query
    const insertMeta = db.prepare(
      "INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"
    );
    insertMeta.run("sess-001", "/tmp/project");

    const meta = db.prepare(
      "SELECT * FROM session_meta WHERE session_id = ?"
    ).get("sess-001") as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta.session_id).toBe("sess-001");
    expect(meta.project_dir).toBe("/tmp/project");

    // Insert event
    const insertEvent = db.prepare(
      "INSERT INTO session_events (session_id, type, category, priority, data, source_hook, data_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insertEvent.run("sess-001", "file_change", "edit", 2, '{"file":"test.ts"}', "PostToolUse", "ABCD1234");

    const events = db.prepare(
      "SELECT * FROM session_events WHERE session_id = ?"
    ).all("sess-001") as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("file_change");
  });

  it("FTS5 is NOT available (expected limitation)", () => {
    dbPath = tmpDbPath();
    db = new SqlJsDatabaseWrapper(dbPath);

    // FTS5 should fail in sql.js
    expect(() => {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS test_fts USING fts5(
          title,
          content
        );
      `);
    }).toThrow();
  });
});
