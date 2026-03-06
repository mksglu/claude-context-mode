/**
 * SqlJsWrapper — Drop-in replacement for better-sqlite3's Database class
 * using sql.js (asm.js build) as the backend.
 *
 * This wrapper is only used when better-sqlite3 fails to load (e.g., on
 * systems without build tools or with old glibc). It provides the subset
 * of the better-sqlite3 API that context-mode actually uses.
 *
 * IMPORTANT: Call `await initSqlJs()` once before constructing any
 * SqlJsDatabaseWrapper instances. The MCP server startup path in
 * server.ts handles this automatically.
 *
 * Limitations:
 * - FTS5 is NOT available in sql.js — ContentStore (store.ts) will fail
 *   at schema init. SessionDB works fine.
 * - Performance is slower than native better-sqlite3.
 * - WAL mode is silently ignored (sql.js is in-memory with file persistence).
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ─────────────────────────────────────────────────────────
// Types (minimal subset matching better-sqlite3's API)
// ─────────────────────────────────────────────────────────

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): SqlJsDatabase;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): SqlJsStatement;
  close(): void;
  export(): Uint8Array;
  getRowsModified(): number;
}

interface SqlJsStatement {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(opts?: Record<string, unknown>): Record<string, unknown>;
  get(params?: unknown[]): unknown[];
  run(params?: unknown[]): void;
  reset(): void;
  free(): void;
  freemem(): void;
  columns(): Array<{ name: string }>;
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
}

// ─────────────────────────────────────────────────────────
// sql.js loader (async init, cached)
// ─────────────────────────────────────────────────────────

let _SQL: SqlJsStatic | null = null;

/**
 * Initialize sql.js asynchronously. Must be called once before
 * constructing any SqlJsDatabaseWrapper instances.
 * Safe to call multiple times — only initializes on the first call.
 */
export async function initSqlJsEngine(): Promise<void> {
  if (_SQL) return;

  const require = createRequire(import.meta.url);

  let initFn: (config?: Record<string, unknown>) => Promise<SqlJsStatic>;
  try {
    initFn = require("sql.js/dist/sql-asm.js");
  } catch {
    try {
      initFn = require("sql.js");
    } catch {
      throw new Error(
        "sql.js is not installed. Install it with: npm install sql.js",
      );
    }
  }

  _SQL = await initFn();
}

/**
 * Get the cached sql.js instance. Throws if initSqlJsEngine() hasn't been called.
 */
function getSqlJs(): SqlJsStatic {
  if (!_SQL) {
    throw new Error(
      "sql.js not initialized. Call await initSqlJsEngine() before creating databases.",
    );
  }
  return _SQL;
}

// ─────────────────────────────────────────────────────────
// Statement Wrapper
// ─────────────────────────────────────────────────────────

/**
 * Wraps a SQL string to provide better-sqlite3's Statement interface.
 * Each call to run/get/all/iterate creates a fresh sql.js prepared statement,
 * executes it, and frees it — matching the reusable semantics of better-sqlite3.
 */
class StatementWrapper {
  readonly #db: SqlJsDatabase;
  readonly #sql: string;
  readonly #wrapper: SqlJsDatabaseWrapper;

  constructor(db: SqlJsDatabase, sql: string, wrapper: SqlJsDatabaseWrapper) {
    this.#db = db;
    this.#sql = sql;
    this.#wrapper = wrapper;
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.#db.prepare(this.#sql);
    try {
      stmt.run(params.length > 0 ? params : undefined);
      const changes = this.#db.getRowsModified();
      let lastInsertRowid: number | bigint = 0;
      try {
        const ridStmt = this.#db.prepare("SELECT last_insert_rowid() as rid");
        if (ridStmt.step()) {
          const row = ridStmt.getAsObject();
          lastInsertRowid = (row.rid as number) ?? 0;
        }
        ridStmt.free();
      } catch {
        // ignore
      }
      this.#wrapper._persistIfNeeded();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  get(...params: unknown[]): unknown {
    const stmt = this.#db.prepare(this.#sql);
    try {
      if (params.length > 0) stmt.bind(params);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all(...params: unknown[]): unknown[] {
    const stmt = this.#db.prepare(this.#sql);
    try {
      if (params.length > 0) stmt.bind(params);
      const results: unknown[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    const stmt = this.#db.prepare(this.#sql);
    try {
      if (params.length > 0) stmt.bind(params);
      while (stmt.step()) {
        yield stmt.getAsObject();
      }
    } finally {
      stmt.free();
    }
  }
}

// ─────────────────────────────────────────────────────────
// Database Wrapper
// ─────────────────────────────────────────────────────────

/**
 * SqlJsDatabaseWrapper — provides better-sqlite3's Database interface
 * on top of sql.js.
 *
 * File persistence: loads from file on open, saves after mutations.
 * WAL/SHM files are not created (sql.js doesn't use them).
 */
export class SqlJsDatabaseWrapper {
  readonly #dbPath: string;
  readonly #sqlJsDb: SqlJsDatabase;
  #inTransaction = false;
  #transactionDepth = 0;

  constructor(dbPath: string, _options?: Record<string, unknown>) {
    this.#dbPath = dbPath;

    const SQL = getSqlJs();

    // Load existing database file if it exists
    let data: Buffer | null = null;
    try {
      if (existsSync(dbPath)) {
        data = readFileSync(dbPath);
      }
    } catch {
      // ignore — start fresh
    }

    this.#sqlJsDb = new SQL.Database(data);
  }

  get inTransaction(): boolean {
    return this.#inTransaction;
  }

  /**
   * Execute a PRAGMA statement. Returns the result value(s).
   */
  pragma(source: string): unknown {
    const sql = `PRAGMA ${source}`;
    try {
      const results = this.#sqlJsDb.exec(sql);
      if (results.length === 0) return undefined;
      const { columns, values } = results[0];
      if (values.length === 0) return undefined;
      if (values.length === 1 && columns.length === 1) {
        return values[0][0];
      }
      return values.map((row) => {
        const obj: Record<string, unknown> = {};
        columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        return obj;
      });
    } catch {
      // Silently ignore unsupported pragmas (WAL, synchronous in sql.js)
      return undefined;
    }
  }

  /**
   * Prepare a SQL statement for repeated execution.
   */
  prepare(sql: string): StatementWrapper {
    return new StatementWrapper(this.#sqlJsDb, sql, this);
  }

  /**
   * Execute raw SQL (one or more statements).
   */
  exec(sql: string): void {
    this.#sqlJsDb.run(sql);
    this._persistIfNeeded();
  }

  /**
   * Close the database and save to file.
   */
  close(): void {
    try {
      this._persist();
    } catch {
      // ignore persist errors on close
    }
    try {
      this.#sqlJsDb.close();
    } catch {
      // ignore
    }
  }

  /**
   * Wrap a function in a transaction.
   */
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const wrapper = ((...args: unknown[]) => {
      if (this.#transactionDepth === 0) {
        this.#sqlJsDb.run("BEGIN");
        this.#inTransaction = true;
      }
      this.#transactionDepth++;
      try {
        const result = fn(...args);
        this.#transactionDepth--;
        if (this.#transactionDepth === 0) {
          this.#sqlJsDb.run("COMMIT");
          this.#inTransaction = false;
          this._persist();
        }
        return result;
      } catch (err) {
        this.#transactionDepth--;
        if (this.#transactionDepth === 0) {
          try {
            this.#sqlJsDb.run("ROLLBACK");
          } catch {
            // ignore rollback errors
          }
          this.#inTransaction = false;
        }
        throw err;
      }
    }) as unknown as T;
    return wrapper;
  }

  /** @internal */
  _persistIfNeeded(): void {
    if (!this.#inTransaction) {
      this._persist();
    }
  }

  /** @internal */
  _persist(): void {
    try {
      const data = this.#sqlJsDb.export();
      const dir = dirname(this.#dbPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.#dbPath, Buffer.from(data));
    } catch {
      // ignore persist errors (e.g., read-only filesystem)
    }
  }
}
