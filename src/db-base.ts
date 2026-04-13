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
import { existsSync, unlinkSync, renameSync } from "node:fs";
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
// node:sqlite adapter (#228)
// ─────────────────────────────────────────────────────────

/**
 * Wraps node:sqlite's DatabaseSync to provide better-sqlite3-compatible API.
 * Bridges: .pragma(), .transaction(). Everything else is passthrough.
 * Eliminates native addon SIGSEGV on Linux (nodejs/node#62515).
 */
export class NodeSQLiteAdapter {
  #raw: any; // DatabaseSync instance

  constructor(rawDb: any) {
    this.#raw = rawDb;
  }

  pragma(source: string): any {
    // "journal_mode = WAL" → PRAGMA journal_mode = WAL
    // "table_xinfo(session_events)" → PRAGMA table_xinfo(session_events)
    // "wal_checkpoint(TRUNCATE)" → PRAGMA wal_checkpoint(TRUNCATE)
    const stmt = this.#raw.prepare(`PRAGMA ${source}`);
    const rows = stmt.all();
    if (!rows || rows.length === 0) return undefined;
    if (rows.length > 1) return rows;
    const values = Object.values(rows[0] as Record<string, unknown>);
    return values.length === 1 ? values[0] : rows[0];
  }

  exec(sql: string): any {
    // node:sqlite's exec() supports multi-statement natively
    this.#raw.exec(sql);
    return this;
  }

  prepare(sql: string): any {
    const stmt = this.#raw.prepare(sql);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => stmt.get(...args),
      all: (...args: unknown[]) => stmt.all(...args),
      iterate: (...args: unknown[]) => {
        // node:sqlite uses Symbol.iterator on StatementSync, not .iterate()
        // Check if iterate exists, otherwise use Symbol.iterator
        if (typeof stmt.iterate === 'function') {
          return stmt.iterate(...args);
        }
        // Fallback: use all() to create an iterator
        const rows = stmt.all(...args);
        return rows[Symbol.iterator]();
      },
    };
  }

  transaction(fn: (...args: any[]) => any): any {
    // node:sqlite has no transaction() method — manual BEGIN/COMMIT/ROLLBACK
    return (...args: any[]) => {
      this.#raw.exec("BEGIN");
      try {
        const result = fn(...args);
        this.#raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.#raw.exec("ROLLBACK");
        throw err;
      }
    };
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
 * Linux Node → node:sqlite via NodeSQLiteAdapter (issue #228).
 * Other Node → better-sqlite3 (native addon).
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
        const adapter = new BunSQLiteAdapter(raw);
        // Propagate busy_timeout — better-sqlite3 does this via constructor
        // option but bun:sqlite does not, so we set it via pragma (#243)
        if (opts?.timeout) {
          adapter.pragma(`busy_timeout = ${opts.timeout}`);
        }
        return adapter;
      } as any;
    } else if (process.platform === "linux") {
      // Linux — try node:sqlite to avoid native addon SIGSEGV (nodejs/node#62515).
      // node:sqlite is built into Node >= 22.5, no flag needed since 22.13.
      try {
        const { DatabaseSync } = require(["node", "sqlite"].join(":"));
        _Database = function NodeDatabaseFactory(path: string, opts?: any) {
          const raw = new DatabaseSync(path, {
            readOnly: opts?.readonly ?? false,
          });
          return new NodeSQLiteAdapter(raw);
        } as any;
      } catch {
        // node:sqlite not available — fall through to better-sqlite3
        _Database = require("better-sqlite3") as typeof DatabaseConstructor;
      }
    } else {
      // Non-Linux Node.js — use better-sqlite3.
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
  // Memory-map the DB file for read-heavy FTS5 search workloads.
  // Eliminates read() syscalls — the kernel serves pages directly from
  // the page cache. 256MB is a safe upper bound (SQLite only maps up to
  // the actual file size). Falls back gracefully on platforms where mmap
  // is unavailable or restricted.
  try { db.pragma("mmap_size = 268435456"); } catch { /* unsupported runtime */ }
}

// ─────────────────────────────────────────────────────────
// DB file helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove orphaned WAL/SHM files when the main DB file doesn't exist.
 * On Windows, stale -wal/-shm files from crashed processes cause
 * "file is not a database" errors when creating a fresh DB.
 */
export function cleanOrphanedWALFiles(dbPath: string): void {
  if (!existsSync(dbPath)) {
    for (const suffix of ["-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  }
}

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
 * Pass custom delays for testing (e.g., [0, 0, 0] to skip waits).
 */
export function withRetry<T>(fn: () => T, delays: number[] = [100, 500, 2000]): T {
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
// Corrupt DB recovery (#244)
// ─────────────────────────────────────────────────────────

/**
 * Detect SQLite corruption errors that warrant a rename-and-recreate.
 * Matches SQLITE_CORRUPT, SQLITE_NOTADB, and their human-readable equivalents.
 */
export function isSQLiteCorruptionError(msg: string): boolean {
  return (
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("database disk image is malformed") ||
    msg.includes("file is not a database")
  );
}

/**
 * Rename a corrupt DB and its WAL/SHM files so a fresh DB can be created.
 * Best-effort — individual rename failures are silently ignored.
 */
export function renameCorruptDB(dbPath: string): void {
  const ts = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      renameSync(dbPath + suffix, `${dbPath}${suffix}.corrupt-${ts}`);
    } catch { /* file may not exist */ }
  }
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
        closeDB(db);
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
    cleanOrphanedWALFiles(dbPath);
    let db: DatabaseInstance;
    try {
      db = new Database(dbPath, { timeout: 30000 });
      applyWALPragmas(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg)) {
        renameCorruptDB(dbPath);
        cleanOrphanedWALFiles(dbPath);
        try {
          db = new Database(dbPath, { timeout: 30000 });
          applyWALPragmas(db);
        } catch (retryErr) {
          throw new Error(
            `Failed to create fresh DB after renaming corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      } else {
        throw err;
      }
    }
    this.#db = db;
    _liveDBs.add(this.#db);
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
