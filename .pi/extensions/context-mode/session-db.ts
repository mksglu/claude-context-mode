/**
 * SessionDB — Persistent SQLite database for pi context-mode extension.
 *
 * Stores session events, metadata, and resume snapshots.
 * Simplified version without OpenClaw-specific session_key mapping.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type { SessionEvent } from "./types.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface PreparedStatement {
  run: (...params: unknown[]) => { changes: number };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

/** A stored event row from the session_events table. */
export interface StoredEvent {
  id: number;
  session_id: string;
  type: string;
  category: string;
  priority: number;
  data: string;
  source_hook: string;
  created_at: string;
  data_hash: string;
}

/** Session metadata row. */
export interface SessionMeta {
  session_id: string;
  project_dir: string;
  started_at: string;
  last_event_at: string | null;
  event_count: number;
  compact_count: number;
}

/** Resume snapshot row. */
export interface ResumeRow {
  snapshot: string;
  event_count: number;
  consumed: number;
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const MAX_EVENTS_PER_SESSION = 1000;
const DEDUP_WINDOW = 5;

// ─────────────────────────────────────────────────────────
// SessionDB
// ─────────────────────────────────────────────────────────

export class SessionDB {
  private db: import("better-sqlite3").Database;
  private stmts: Map<string, PreparedStatement>;

  constructor(opts?: { dbPath?: string }) {
    // Lazy load better-sqlite3
    const betterSqlite3 = require("better-sqlite3");
    const dbPath = opts?.dbPath ?? this.defaultDBPath();

    // Ensure parent directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    this.db = new betterSqlite3(dbPath);
    this.stmts = new Map();

    this.initSchema();
    this.prepareStatements();
  }

  private defaultDBPath(): string {
    const dir = join(homedir(), ".pi", "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return join(dir, "context-mode.db");
  }

  private initSchema(): void {
    // Check for old schema with generated column
    try {
      const colInfo = this.db.pragma("table_xinfo(session_events)") as Array<{ name: string; hidden: number }>;
      const hashCol = colInfo.find((c) => c.name === "data_hash");
      if (hashCol && hashCol.hidden !== 0) {
        this.db.exec("DROP TABLE session_events");
      }
    } catch { /* table doesn't exist */ }

    this.db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

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
  }

  private prepareStatements(): void {
    const p = (key: string, sql: string) => {
      this.stmts.set(key, this.db.prepare(sql) as PreparedStatement);
    };

    p("insertEvent",
      `INSERT INTO session_events (session_id, type, category, priority, data, source_hook, data_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`);

    p("getEvents",
      `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`);

    p("getEventsByType",
      `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`);

    p("getEventsByPriority",
      `SELECT id, session_id, type, category, priority, data, source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`);

    p("getEventCount",
      `SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?`);

    p("checkDuplicate",
      `SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`);

    p("evictLowestPriority",
      `DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`);

    p("updateMetaLastEvent",
      `UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`);

    p("ensureSession",
      `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)`);

    p("getSessionStats",
      `SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`);

    p("incrementCompactCount",
      `UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?`);

    p("upsertResume",
      `INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`);

    p("getResume",
      `SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?`);

    p("markResumeConsumed",
      `UPDATE session_resume SET consumed = 1 WHERE session_id = ?`);

    p("deleteEvents", `DELETE FROM session_events WHERE session_id = ?`);
    p("deleteMeta", `DELETE FROM session_meta WHERE session_id = ?`);
    p("deleteResume", `DELETE FROM session_resume WHERE session_id = ?`);
    p("getOldSessions",
      `SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')`);
  }

  private stmt(key: string): PreparedStatement {
    return this.stmts.get(key)!;
  }

  // ── Events ─────────────────────────────────────────────

  insertEvent(sessionId: string, event: SessionEvent, sourceHook: string = "tool_result"): void {
    const dataHash = createHash("sha256")
      .update(event.data)
      .digest("hex")
      .slice(0, 16)
      .toUpperCase();

    const transaction = this.db.transaction(() => {
      // Deduplication
      const dup = this.stmt("checkDuplicate").get(sessionId, DEDUP_WINDOW, event.type, dataHash);
      if (dup) return;

      // Eviction if over limit
      const countRow = this.stmt("getEventCount").get(sessionId) as { cnt: number };
      if (countRow.cnt >= MAX_EVENTS_PER_SESSION) {
        this.stmt("evictLowestPriority").run(sessionId);
      }

      // Insert
      this.stmt("insertEvent").run(
        sessionId,
        event.type,
        event.category,
        event.priority,
        event.data,
        sourceHook,
        dataHash,
      );

      this.stmt("updateMetaLastEvent").run(sessionId);
    });

    transaction();
  }

  getEvents(
    sessionId: string,
    opts?: { type?: string; minPriority?: number; limit?: number },
  ): StoredEvent[] {
    const limit = opts?.limit ?? 1000;
    const type = opts?.type;
    const minPriority = opts?.minPriority;

    if (type && minPriority !== undefined) {
      return this.stmt("getEventsByType").all(sessionId, type, limit) as StoredEvent[];
    }
    if (type) {
      return this.stmt("getEventsByType").all(sessionId, type, limit) as StoredEvent[];
    }
    if (minPriority !== undefined) {
      return this.stmt("getEventsByPriority").all(sessionId, minPriority, limit) as StoredEvent[];
    }
    return this.stmt("getEvents").all(sessionId, limit) as StoredEvent[];
  }

  getEventCount(sessionId: string): number {
    const row = this.stmt("getEventCount").get(sessionId) as { cnt: number };
    return row.cnt;
  }

  // ── Meta ───────────────────────────────────────────────

  ensureSession(sessionId: string, projectDir: string): void {
    this.stmt("ensureSession").run(sessionId, projectDir);
  }

  getSessionStats(sessionId: string): SessionMeta | null {
    const row = this.stmt("getSessionStats").get(sessionId) as SessionMeta | undefined;
    return row ?? null;
  }

  incrementCompactCount(sessionId: string): void {
    this.stmt("incrementCompactCount").run(sessionId);
  }

  // ── Resume ─────────────────────────────────────────────

  upsertResume(sessionId: string, snapshot: string, eventCount?: number): void {
    this.stmt("upsertResume").run(sessionId, snapshot, eventCount ?? 0);
  }

  getResume(sessionId: string): ResumeRow | null {
    const row = this.stmt("getResume").get(sessionId) as ResumeRow | undefined;
    return row ?? null;
  }

  markResumeConsumed(sessionId: string): void {
    this.stmt("markResumeConsumed").run(sessionId);
  }

  // ── Lifecycle ──────────────────────────────────────────

  deleteSession(sessionId: string): void {
    this.db.transaction(() => {
      this.stmt("deleteEvents").run(sessionId);
      this.stmt("deleteResume").run(sessionId);
      this.stmt("deleteMeta").run(sessionId);
    })();
  }

  cleanupOldSessions(maxAgeDays: number = 7): number {
    const negDays = `-${maxAgeDays}`;
    const oldSessions = this.stmt("getOldSessions").all(negDays) as Array<{ session_id: string }>;

    for (const { session_id } of oldSessions) {
      this.deleteSession(session_id);
    }

    return oldSessions.length;
  }
}
