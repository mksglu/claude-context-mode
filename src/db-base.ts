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
import { SqlJsDatabaseWrapper, initSqlJsEngine } from "./sqljs-wrapper.js";

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
// Lazy loader
// ─────────────────────────────────────────────────────────

let _Database: typeof DatabaseConstructor | null = null;
let _useFallback = false;

/**
 * Returns true if the sql.js fallback is active (better-sqlite3 unavailable).
 * Useful for feature checks — e.g., FTS5 is not available in fallback mode.
 */
export function isFallbackMode(): boolean {
  return _useFallback;
}

/**
 * Lazy-load better-sqlite3. Only resolves the native module on first call.
 * This allows the MCP server to start instantly even when the native addon
 * is not yet installed (marketplace first-run scenario).
 *
 * If better-sqlite3 fails to load (missing build tools, old glibc, etc.),
 * sets fallback mode so that callers use SqlJsDatabaseWrapper instead.
 */
export function loadDatabase(): typeof DatabaseConstructor | null {
  if (_Database || _useFallback) {
    return _Database;
  }
  try {
    const require = createRequire(import.meta.url);
    _Database = require("better-sqlite3") as typeof DatabaseConstructor;
  } catch {
    _useFallback = true;
    _Database = null;
  }
  return _Database;
}

/**
 * Initialize the database backend. Must be called (and awaited) once
 * before constructing any SQLiteBase subclass.
 *
 * - If better-sqlite3 is available, this is a no-op.
 * - If better-sqlite3 fails, initializes the sql.js fallback engine.
 *
 * The MCP server startup path (server.ts) calls this automatically.
 */
export async function ensureDatabaseReady(): Promise<void> {
  loadDatabase();
  if (_useFallback) {
    await initSqlJsEngine();
  }
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
export abstract class SQLiteBase {
  readonly #dbPath: string;
  readonly #db: DatabaseInstance | SqlJsDatabaseWrapper;

  constructor(dbPath: string) {
    const Database = loadDatabase();
    this.#dbPath = dbPath;

    if (Database) {
      // Native better-sqlite3 path (fast)
      this.#db = new Database(dbPath, { timeout: 5000 });
    } else {
      // sql.js fallback path (WASM/asm.js)
      this.#db = new SqlJsDatabaseWrapper(dbPath);
    }

    applyWALPragmas(this.#db as DatabaseInstance);
    this.initSchema();
    this.prepareStatements();
  }

  /** Called once after WAL pragmas are applied. Subclasses run CREATE TABLE/VIRTUAL TABLE here. */
  protected abstract initSchema(): void;

  /** Called once after schema init. Subclasses compile and cache their prepared statements here. */
  protected abstract prepareStatements(): void;

  /** Raw database instance — available to subclasses only. */
  protected get db(): DatabaseInstance {
    return this.#db as DatabaseInstance;
  }

  /** The path this database was opened from. */
  get dbPath(): string {
    return this.#dbPath;
  }

  /** Close the database connection without deleting files. */
  close(): void {
    closeDB(this.#db as DatabaseInstance);
  }

  /**
   * Close the connection and delete all associated DB files (main, WAL, SHM).
   * Call on process exit or at end of session lifecycle.
   */
  cleanup(): void {
    closeDB(this.#db as DatabaseInstance);
    deleteDBFiles(this.#dbPath);
  }
}
