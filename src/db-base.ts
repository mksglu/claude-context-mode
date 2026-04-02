/**
 * db-base — Reusable SQLite infrastructure for context-mode packages.
 *
 * Provides lazy-loading of better-sqlite3, WAL pragma setup, prepared
 * statement caching interface, and DB file cleanup helpers. Both
 * ContentStore and SessionDB build on top of these primitives.
 */

import type DatabaseConstructor from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/**
 * Explicit interface for cached prepared statements that accept varying
 * parameter counts. better-sqlite3's generic `Statement` collapses under
 * `ReturnType` to a single-param signature, so we define our own.
 */
export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

// ─────────────────────────────────────────────────────────
// bun:sqlite adapter (#45)
// ─────────────────────────────────────────────────────────

/**
 * Wraps a bun:sqlite Database to provide better-sqlite3-compatible API.
 * Bridges: .pragma(), multi-statement .exec(), .get() null→undefined.
 */
export class BunSQLiteAdapter {
  #raw: any;

  constructor(rawDb: any) {
    this.#raw = rawDb;
  }

  pragma(source: string): any {
    const stmt = this.#raw.prepare(`PRAGMA ${source}`);
    const rows = stmt.all();
    if (!rows || rows.length === 0) return undefined;
    // Multi-row pragmas (table_xinfo, etc.) → return array
    if (rows.length > 1) return rows;
    // Single-row: extract scalar value (e.g. journal_mode = "wal")
    const values = Object.values(rows[0] as Record<string, unknown>);
    return values.length === 1 ? values[0] : rows[0];
  }

  exec(sql: string): any {
    // bun:sqlite .exec() is single-statement only.
    // Split multi-statement SQL respecting string literals (don't split on ; inside quotes).
    let current = "";
    let inString: string | null = null;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (inString) {
        current += ch;
        if (ch === inString) inString = null;
      } else if (ch === "'" || ch === '"') {
        current += ch;
        inString = ch;
      } else if (ch === ";") {
        const trimmed = current.trim();
        if (trimmed) this.#raw.prepare(trimmed).run();
        current = "";
      } else {
        current += ch;
      }
    }
    const trimmed = current.trim();
    if (trimmed) this.#raw.prepare(trimmed).run();
    return this;
  }

  prepare(sql: string): any {
    const stmt = this.#raw.prepare(sql);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => {
        const r = stmt.get(...args);
        return r === null ? undefined : r;
      },
      all: (...args: unknown[]) => stmt.all(...args),
      iterate: (...args: unknown[]) => stmt.iterate(...args),
    };
  }

  transaction(fn: (...args: any[]) => any): any {
    return this.#raw.transaction(fn);
  }

  close(): void {
    this.#raw.close();
  }
}

// ─────────────────────────────────────────────────────────
// Lazy loader
// ─────────────────────────────────────────────────────────

let _Database: typeof DatabaseConstructor | null = null;

/**
 * Lazy-load the SQLite driver for the current runtime.
 * Bun → bun:sqlite via BunSQLiteAdapter (issue #45).
 * Node → better-sqlite3 (native addon).
 */
export function loadDatabase(): typeof DatabaseConstructor {
  if (!_Database) {
    const require = createRequire(import.meta.url);

    if ((globalThis as any).Bun) {
      // Bun runtime — use bun:sqlite directly.
      // Array.join() prevents esbuild from resolving the specifier at bundle time.
      const BunDB = require(["bun", "sqlite"].join(":")).Database;
      _Database = function BunDatabaseFactory(path: string, opts?: any) {
        const raw = new BunDB(path, {
          readonly: opts?.readonly,
          create: true,
        });
        return new BunSQLiteAdapter(raw);
      } as any;
    } else {
      // Node.js — use better-sqlite3.
      _Database = require("better-sqlite3") as typeof DatabaseConstructor;
    }
  }
  return _Database!;
}

// ─────────────────────────────────────────────────────────
// WAL setup
// ─────────────────────────────────────────────────────────

/**
 * Apply WAL mode and NORMAL synchronous pragma to a database instance.
 * Should be called immediately after opening a new database connection.
 *
 * WAL mode provides:
 * - Concurrent readers while a write is in progress
 * - Dramatically faster writes (no full-page sync on each commit)
 * NORMAL synchronous is safe under WAL and avoids an extra fsync per
 * transaction.
 */
export function applyWALPragmas(db: DatabaseInstance): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
}

// ─────────────────────────────────────────────────────────
// DB file helpers
// ─────────────────────────────────────────────────────────

/**
 * Delete all three SQLite files for a given db path (main, WAL, SHM).
 * Silently ignores individual deletion errors so a partial cleanup
 * does not abort the rest.
 */
export function deleteDBFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // ignore — file may not exist
    }
  }
}

/**
 * Safely close a database connection. Swallows errors so callers can
 * always call this in a finally/cleanup path without try/catch.
 */
export function closeDB(db: DatabaseInstance): void {
  try {
    // Checkpoint WAL before close to prevent contention on restart (#103)
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch { /* WAL may not be active */ }
  try {
    db.close();
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────
// Default path helper
// ─────────────────────────────────────────────────────────

/**
 * Return the default per-process DB path for context-mode databases.
 * Uses the OS temp directory and embeds the current PID so multiple
 * server instances never share a file.
 */
export function defaultDBPath(prefix: string = "context-mode"): string {
  return join(tmpdir(), `${prefix}-${process.pid}.db`);
}

// ─────────────────────────────────────────────────────────
// Retry helper
// ─────────────────────────────────────────────────────────

/**
 * Retry a DB operation with exponential backoff on SQLITE_BUSY errors.
 * Catches errors containing "SQLITE_BUSY" or "database is locked" and
 * retries up to 3 times with delays: 100ms, 500ms, 2000ms.
 * If all retries fail, throws a descriptive error.
 */
export function withRetry<T>(fn: () => T): T {
  const delays = [100, 500, 2000];
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(msg);
      if (attempt < delays.length) {
        const delay = delays[attempt];
        const start = Date.now();
        while (Date.now() - start < delay) { /* busy-wait for sync retry */ }
      }
    }
  }
  throw new Error(
    `SQLITE_BUSY: database is locked after ${delays.length} retries. ` +
    `Original error: ${lastError?.message}`
  );
}

// ─────────────────────────────────────────────────────────
// Base class
// ─────────────────────────────────────────────────────────

/**
 * SQLiteBase — minimal base class that handles open/close/cleanup lifecycle.
 *
 * Subclasses call `super(dbPath)` to open the database with WAL pragmas
 * applied, then implement `initSchema()` and `prepareStatements()`.
 *
 * The `db` getter exposes the raw `DatabaseInstance` to subclasses only.
 */
/**
 * Track all live DatabaseInstance objects so we can close them on process exit.
 * Prevents better-sqlite3 segfaults caused by V8 garbage-collecting Database
 * objects after the native addon context is already torn down.
 *
 * Uses a global symbol so the set and exit handler survive vitest's module
 * re-imports within the same fork process (ESM isolate mode clears
 * module-level state but globalThis persists).
 */
const _kLiveDBs = Symbol.for("__context_mode_live_dbs__");
const _liveDBs: Set<DatabaseInstance> = (() => {
  const g = globalThis as Record<symbol, Set<DatabaseInstance> | undefined>;
  if (!g[_kLiveDBs]) {
    g[_kLiveDBs] = new Set<DatabaseInstance>();
    process.on("exit", () => {
      for (const db of g[_kLiveDBs]!) {
        try { db.close(); } catch { /* already closed */ }
      }
      g[_kLiveDBs]!.clear();
    });
  }
  return g[_kLiveDBs]!;
})();

export abstract class SQLiteBase {
  readonly #dbPath: string;
  readonly #db: DatabaseInstance;

  constructor(dbPath: string) {
    const Database = loadDatabase();
    this.#dbPath = dbPath;
    this.#db = new Database(dbPath, { timeout: 30000 });
    _liveDBs.add(this.#db);
    applyWALPragmas(this.#db);
    this.initSchema();
    this.prepareStatements();
  }

  /** Called once after WAL pragmas are applied. Subclasses run CREATE TABLE/VIRTUAL TABLE here. */
  protected abstract initSchema(): void;

  /** Called once after schema init. Subclasses compile and cache their prepared statements here. */
  protected abstract prepareStatements(): void;

  /** Raw database instance — available to subclasses only. */
  protected get db(): DatabaseInstance {
    return this.#db;
  }

  /** The path this database was opened from. */
  get dbPath(): string {
    return this.#dbPath;
  }

  /** Close the database connection without deleting files. */
  close(): void {
    _liveDBs.delete(this.#db);
    closeDB(this.#db);
  }

  protected withRetry<T>(fn: () => T): T {
    return withRetry(fn);
  }

  /**
   * Close the connection and delete all associated DB files (main, WAL, SHM).
   * Call on process exit or at end of session lifecycle.
   */
  cleanup(): void {
    _liveDBs.delete(this.#db);
    closeDB(this.#db);
    deleteDBFiles(this.#dbPath);
  }
}
