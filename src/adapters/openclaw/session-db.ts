/**
 * OpenClawSessionDB — OpenClaw-specific extension of SessionDB.
 *
 * Adds session_key mapping (openclaw_session_map table) and session
 * rename support needed for OpenClaw's gateway restart re-keying.
 *
 * The shared SessionDB remains unaware of session_key; all OpenClaw-specific
 * session mapping lives here.
 */

import { SessionDB } from "../../session/db.js";
import type { PreparedStatement } from "../../db-base.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Row from the openclaw_session_map table. */
export interface SessionMapRow {
  session_key: string;
  session_id: string;
  created_at: string;
}

// ─────────────────────────────────────────────────────────
// OpenClawSessionDB
// ─────────────────────────────────────────────────────────

export class OpenClawSessionDB extends SessionDB {
  /**
   * OpenClaw-specific prepared statements, separate from the parent's
   * private statement cache. Created in prepareStatements() after
   * super.prepareStatements() finishes.
   *
   * `declare` prevents TypeScript from emitting a field initializer
   * that would wipe the value set during the base constructor's
   * prepareStatements() call chain.
   */
  private declare ocStmts: Map<string, PreparedStatement>;

  // ── Schema ──

  protected initSchema(): void {
    super.initSchema();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS openclaw_session_map (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  protected prepareStatements(): void {
    super.prepareStatements();

    this.ocStmts = new Map<string, PreparedStatement>();

    const p = (key: string, sql: string) => {
      this.ocStmts.set(key, this.db.prepare(sql) as PreparedStatement);
    };

    p("getMostRecentSession",
      `SELECT session_id FROM openclaw_session_map WHERE session_key = ?`);

    p("upsertSessionMap",
      `INSERT INTO openclaw_session_map (session_key, session_id)
       VALUES (?, ?)
       ON CONFLICT(session_key) DO UPDATE SET
         session_id = excluded.session_id`);

    p("deleteSessionMap",
      `DELETE FROM openclaw_session_map WHERE session_key = ?`);

    p("renameSessionMeta",
      `UPDATE session_meta SET session_id = ? WHERE session_id = ?`);

    p("renameSessionEvents",
      `UPDATE session_events SET session_id = ? WHERE session_id = ?`);

    p("renameSessionResume",
      `UPDATE session_resume SET session_id = ? WHERE session_id = ?`);

    p("renameSessionMap",
      `UPDATE openclaw_session_map SET session_id = ? WHERE session_id = ?`);
  }

  /** Shorthand to retrieve an OpenClaw-specific cached statement. */
  private oc(key: string): PreparedStatement {
    return this.ocStmts.get(key)!;
  }

  // ═══════════════════════════════════════════
  // Session key mapping
  // ═══════════════════════════════════════════

  /**
   * Ensure a session metadata entry exists with an associated session_key.
   * Calls the parent's 2-param ensureSession and also records the mapping
   * in openclaw_session_map.
   */
  ensureSessionWithKey(sessionId: string, projectDir: string, sessionKey: string): void {
    this.ensureSession(sessionId, projectDir);
    this.oc("upsertSessionMap").run(sessionKey, sessionId);
  }

  /**
   * Get the session_id of the most recently mapped session for a given sessionKey.
   * Returns null if no sessions exist for that key.
   */
  getMostRecentSession(sessionKey: string): string | null {
    const row = this.oc("getMostRecentSession").get(sessionKey) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  /**
   * Rename a session ID in-place across all tables (session_meta, session_events,
   * session_resume, openclaw_session_map), preserving all events, metadata,
   * and resume snapshots. Used when OpenClaw re-keys session IDs on gateway
   * restart so accumulated events survive the re-key.
   */
  renameSession(oldId: string, newId: string): void {
    this.db.transaction(() => {
      this.oc("renameSessionMeta").run(newId, oldId);
      this.oc("renameSessionEvents").run(newId, oldId);
      this.oc("renameSessionResume").run(newId, oldId);
      this.oc("renameSessionMap").run(newId, oldId);
    })();
  }

  /**
   * Remove a session_key mapping from openclaw_session_map.
   * Called on command:stop to clean up agent session tracking.
   */
  removeSessionKey(sessionKey: string): void {
    this.oc("deleteSessionMap").run(sessionKey);
  }
}
