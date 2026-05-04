/**
 * SessionDB — Persistent per-project SQLite database for session events.
 *
 * Stores raw events captured by hooks during a Claude Code session,
 * session metadata, and resume snapshots. Extends SQLiteBase from
 * the shared package.
 */

import { SQLiteBase, defaultDBPath } from "../db-base.js";
import type { PreparedStatement } from "../db-base.js";
import type { SessionEvent } from "../types.js";
import type { ProjectAttribution } from "./project-attribution.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// ─────────────────────────────────────────────────────────
// Worktree isolation
// ─────────────────────────────────────────────────────────

/**
 * Returns the worktree suffix to append to session identifiers.
 * Returns empty string when running in the main working tree.
 *
 * Set CONTEXT_MODE_SESSION_SUFFIX to an explicit value to override
 * (useful in CI environments or when git is unavailable).
 * Set to empty string to disable isolation entirely.
 */
// Memoized per (cwd, env override) — recomputing on every tool call cost
// ~12ms (git worktree list subprocess fork) on macOS, 50ms+ on Windows.
// Key by cwd so a defensive `process.chdir()` invalidates rather than
// returning stale data.
let _wtCache: { cwd: string; envSuffix: string | undefined; suffix: string } | undefined;

export function getWorktreeSuffix(): string {
  const envSuffix = process.env.CONTEXT_MODE_SESSION_SUFFIX;
  const cwd = process.cwd();
  if (_wtCache && _wtCache.cwd === cwd && _wtCache.envSuffix === envSuffix) {
    return _wtCache.suffix;
  }

  let suffix = "";
  if (envSuffix !== undefined) {
    suffix = envSuffix ? `__${envSuffix}` : "";
  } else {
    try {
      const mainWorktree = execFileSync(
        "git",
        ["worktree", "list", "--porcelain"],
        {
          encoding: "utf-8",
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
        .split(/\r?\n/)
        .find((l) => l.startsWith("worktree "))
        ?.replace("worktree ", "")
        ?.trim();

      if (mainWorktree && cwd !== mainWorktree) {
        suffix = `__${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
      }
    } catch {
      // git not available or not a git repo — no suffix
    }
  }

  _wtCache = { cwd, envSuffix, suffix };
  return suffix;
}

// Test-only helper: clear the memoization between cases.
export function _resetWorktreeSuffixCacheForTests(): void {
  _wtCache = undefined;
}

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** A stored event row from the session_events table. */
export interface StoredEvent {
  id: number;
  session_id: string;
  type: string;
  category: string;
  priority: number;
  data: string;
  project_dir: string;
  attribution_source: string;
  attribution_confidence: number;
  source_hook: string;
  created_at: string;
  data_hash: string;
}

/** Session metadata row from the session_meta table. */
export interface SessionMeta {
  session_id: string;
  project_dir: string;
  started_at: string;
  last_event_at: string | null;
  event_count: number;
  compact_count: number;
}

/** Resume snapshot row from the session_resume table. */
export interface ResumeRow {
  snapshot: string;
  event_count: number;
  consumed: number;
}

/** Aggregated tool-call stats for a single session. */
export interface ToolCallStats {
  totalCalls: number;
  totalBytesReturned: number;
  byTool: Record<string, { calls: number; bytesReturned: number }>;
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** Maximum events per session before FIFO eviction kicks in. */
const MAX_EVENTS_PER_SESSION = 1000;

/** Number of recent events to check for deduplication. */
const DEDUP_WINDOW = 5;

// ─────────────────────────────────────────────────────────
// Statement keys (typed enum to avoid string typos)
// ─────────────────────────────────────────────────────────

const S = {
  insertEvent: "insertEvent",
  getEvents: "getEvents",
  getEventsByType: "getEventsByType",
  getEventsByPriority: "getEventsByPriority",
  getEventsByTypeAndPriority: "getEventsByTypeAndPriority",
  getEventCount: "getEventCount",
  getLatestAttributedProject: "getLatestAttributedProject",
  checkDuplicate: "checkDuplicate",
  evictLowestPriority: "evictLowestPriority",
  updateMetaLastEvent: "updateMetaLastEvent",
  ensureSession: "ensureSession",
  getSessionStats: "getSessionStats",
  incrementCompactCount: "incrementCompactCount",
  upsertResume: "upsertResume",
  getResume: "getResume",
  markResumeConsumed: "markResumeConsumed",
  claimLatestUnconsumedResume: "claimLatestUnconsumedResume",
  deleteEvents: "deleteEvents",
  deleteMeta: "deleteMeta",
  deleteResume: "deleteResume",
  getOldSessions: "getOldSessions",
  searchEvents: "searchEvents",
  incrementToolCall: "incrementToolCall",
  getToolCallTotals: "getToolCallTotals",
  getToolCallByTool: "getToolCallByTool",
} as const;

// ─────────────────────────────────────────────────────────
// SessionDB
// ─────────────────────────────────────────────────────────

export class SessionDB extends SQLiteBase {
  /**
   * Cached prepared statements. Stored in a Map to avoid the JS private-field
   * inheritance issue where `#field` declarations in a subclass are not
   * accessible during base-class constructor calls.
   *
   * `declare` ensures TypeScript does NOT emit a field initializer at runtime.
   * Without `declare`, even `stmts!: Map<...>` emits `this.stmts = undefined`
   * after super() returns, wiping what prepareStatements() stored. The Map
   * is created inside prepareStatements() instead.
   */
  private declare stmts: Map<string, PreparedStatement>;

  constructor(opts?: { dbPath?: string }) {
    super(opts?.dbPath ?? defaultDBPath("session"));
  }

  /** Shorthand to retrieve a cached statement. */
  private stmt(key: string): PreparedStatement {
    return this.stmts.get(key)!;
  }

  // ── Schema ──

  protected initSchema(): void {
    // ── Migration: fix data_hash generated column from older schema ──
    // Old schema had data_hash as GENERATED ALWAYS AS — new schema uses explicit INSERT.
    // Detect and recreate table if needed (session data is ephemeral, safe to drop).
    try {
      const colInfo = this.db.pragma("table_xinfo(session_events)") as Array<{ name: string; hidden: number }>;
      const hashCol = colInfo.find((c) => c.name === "data_hash");
      if (hashCol && hashCol.hidden !== 0) {
        // hidden != 0 means generated column — must recreate
        this.db.exec("DROP TABLE session_events");
      }
    } catch { /* table doesn't exist yet — fine */ }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
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

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    `);

    // Migration: add per-event attribution columns for existing DBs.
    try {
      const colInfo = this.db.pragma("table_xinfo(session_events)") as Array<{ name: string }>;
      const cols = new Set(colInfo.map((c) => c.name));
      if (!cols.has("project_dir")) {
        this.db.exec("ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''");
      }
      if (!cols.has("attribution_source")) {
        this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'");
      }
      if (!cols.has("attribution_confidence")) {
        this.db.exec("ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0");
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)");
    } catch {
      // best-effort migration only
    }

  }

  protected prepareStatements(): void {
    this.stmts = new Map<string, PreparedStatement>();

    const p = (key: string, sql: string) => {
      this.stmts.set(key, this.db.prepare(sql) as PreparedStatement);
    };

    // ── Events ──
    p(S.insertEvent,
      `INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    p(S.getEvents,
      `SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`);

    p(S.getEventsByType,
      `SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`);

    p(S.getEventsByPriority,
      `SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`);

    p(S.getEventsByTypeAndPriority,
      `SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`);

    p(S.getEventCount,
      `SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?`);

    p(S.getLatestAttributedProject,
      `SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`);

    p(S.checkDuplicate,
      `SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`);

    p(S.evictLowestPriority,
      `DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`);

    p(S.updateMetaLastEvent,
      `UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`);

    // ── Meta ──
    p(S.ensureSession,
      `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)`);

    p(S.getSessionStats,
      `SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`);

    p(S.incrementCompactCount,
      `UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?`);

    // ── Resume ──
    p(S.upsertResume,
      `INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`);

    p(S.getResume,
      `SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?`);

    p(S.markResumeConsumed,
      `UPDATE session_resume SET consumed = 1 WHERE session_id = ?`);

    // Atomic "pick newest unconsumed snapshot AND mark it consumed in one
    // statement". Required for race-safe cross-session resume injection
    // (Mickey / PR #376) — two parallel chat-turn hooks must not both read
    // the same row before either one writes consumed=1.
    //
    // The `session_id != ?` clause prevents self-injection (v1.0.106): when
    // Session B compacts mid-flight and produces its own row, B's next chat
    // turn must NOT claim that row back into its own prompt — that's wasted
    // tokens and steals the snapshot meant for the next fresh session.
    p(S.claimLatestUnconsumedResume,
      `UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`);

    // ── Delete ──
    p(S.deleteEvents, `DELETE FROM session_events WHERE session_id = ?`);
    p(S.deleteMeta, `DELETE FROM session_meta WHERE session_id = ?`);
    p(S.deleteResume, `DELETE FROM session_resume WHERE session_id = ?`);

    // ── Search ──
    p(S.searchEvents,
      `SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE project_dir = ?
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`);

    // ── Cleanup ──
    p(S.getOldSessions,
      `SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')`);

    // ── Tool calls (persistent counter) ──
    p(S.incrementToolCall,
      `INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`);

    p(S.getToolCallTotals,
      `SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`);

    p(S.getToolCallByTool,
      `SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`);
  }

  // ═══════════════════════════════════════════
  // Events
  // ═══════════════════════════════════════════

  /**
   * Insert a session event with deduplication and FIFO eviction.
   *
   * Deduplication: skips if the same type + data_hash appears in the
   * last DEDUP_WINDOW events for this session.
   *
   * Eviction: if session exceeds MAX_EVENTS_PER_SESSION, evicts the
   * lowest-priority (then oldest) event.
   */
  insertEvent(
    sessionId: string,
    event: Omit<SessionEvent, "data_hash"> & { data_hash?: string },
    sourceHook: string = "PostToolUse",
    attribution?: Partial<ProjectAttribution>,
  ): void {
    // SHA256-based dedup hash (first 16 hex chars = 8 bytes of entropy)
    const dataHash = createHash("sha256")
      .update(event.data)
      .digest("hex")
      .slice(0, 16)
      .toUpperCase();
    const projectDir = String(
      attribution?.projectDir
      ?? event.project_dir
      ?? "",
    ).trim();
    const attributionSource = String(
      attribution?.source
      ?? event.attribution_source
      ?? "unknown",
    );
    const rawConfidence = Number(
      attribution?.confidence
      ?? event.attribution_confidence
      ?? 0,
    );
    const attributionConfidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0;

    // Atomic: dedup check + eviction + insert in a single transaction
    // to prevent race conditions from concurrent hook calls.
    const transaction = this.db.transaction(() => {
      // Deduplication check: same type + data_hash in last N events
      const dup = this.stmt(S.checkDuplicate).get(sessionId, DEDUP_WINDOW, event.type, dataHash);
      if (dup) return;

      // Enforce max events with FIFO eviction of lowest priority
      const countRow = this.stmt(S.getEventCount).get(sessionId) as { cnt: number };
      if (countRow.cnt >= MAX_EVENTS_PER_SESSION) {
        this.stmt(S.evictLowestPriority).run(sessionId);
      }

      // Insert the event
      this.stmt(S.insertEvent).run(
        sessionId,
        event.type,
        event.category,
        event.priority,
        event.data,
        projectDir,
        attributionSource,
        attributionConfidence,
        sourceHook,
        dataHash,
      );

      // Update meta if session exists
      this.stmt(S.updateMetaLastEvent).run(sessionId);
    });

    this.withRetry(() => transaction());
  }

  /**
   * Bulk-insert N events in a SINGLE transaction.
   *
   * PostToolUse hooks emit 5–15 events per tool call. Calling insertEvent()
   * in a loop runs N transactions = N WAL commits = N fsync candidates,
   * which is painful on Windows NTFS where commit latency dominates.
   * One transaction = one commit, dedup/evict checks reuse cached statements.
   *
   * Cross-platform: uses the same WAL-mode transaction primitive as
   * insertEvent — behavior identical on macOS / Linux / Windows.
   */
  bulkInsertEvents(
    sessionId: string,
    events: SessionEvent[],
    sourceHook: string = "PostToolUse",
    attributions?: Array<Partial<ProjectAttribution> | undefined>,
  ): void {
    if (!events || events.length === 0) return;
    if (events.length === 1) {
      // Cheaper to fall through to insertEvent (its own dedicated transaction).
      this.insertEvent(sessionId, events[0], sourceHook, attributions?.[0]);
      return;
    }

    // Pre-compute hashes + normalized attribution outside the transaction
    // so the SQL transaction holds only DB work (shorter lock window).
    const prepared = events.map((event, i) => {
      const dataHash = createHash("sha256")
        .update(event.data)
        .digest("hex")
        .slice(0, 16)
        .toUpperCase();
      const attribution = attributions?.[i];
      const projectDir = String(
        attribution?.projectDir ?? event.project_dir ?? "",
      ).trim();
      const attributionSource = String(
        attribution?.source ?? event.attribution_source ?? "unknown",
      );
      const rawConfidence = Number(
        attribution?.confidence ?? event.attribution_confidence ?? 0,
      );
      const attributionConfidence = Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : 0;
      return { event, dataHash, projectDir, attributionSource, attributionConfidence };
    });

    const transaction = this.db.transaction(() => {
      let cnt = (this.stmt(S.getEventCount).get(sessionId) as { cnt: number }).cnt;
      for (const row of prepared) {
        const dup = this.stmt(S.checkDuplicate).get(
          sessionId, DEDUP_WINDOW, row.event.type, row.dataHash,
        );
        if (dup) continue;
        if (cnt >= MAX_EVENTS_PER_SESSION) {
          this.stmt(S.evictLowestPriority).run(sessionId);
        } else {
          cnt++;
        }
        this.stmt(S.insertEvent).run(
          sessionId,
          row.event.type,
          row.event.category,
          row.event.priority,
          row.event.data,
          row.projectDir,
          row.attributionSource,
          row.attributionConfidence,
          sourceHook,
          row.dataHash,
        );
      }
      this.stmt(S.updateMetaLastEvent).run(sessionId);
    });

    this.withRetry(() => transaction());
  }

  /**
   * Retrieve events for a session with optional filtering.
   */
  getEvents(
    sessionId: string,
    opts?: { type?: string; minPriority?: number; limit?: number },
  ): StoredEvent[] {
    const limit = opts?.limit ?? 1000;
    const type = opts?.type;
    const minPriority = opts?.minPriority;

    if (type && minPriority !== undefined) {
      return this.stmt(S.getEventsByTypeAndPriority).all(sessionId, type, minPriority, limit) as StoredEvent[];
    }
    if (type) {
      return this.stmt(S.getEventsByType).all(sessionId, type, limit) as StoredEvent[];
    }
    if (minPriority !== undefined) {
      return this.stmt(S.getEventsByPriority).all(sessionId, minPriority, limit) as StoredEvent[];
    }
    return this.stmt(S.getEvents).all(sessionId, limit) as StoredEvent[];
  }

  /**
   * Get the total event count for a session.
   */
  getEventCount(sessionId: string): number {
    const row = this.stmt(S.getEventCount).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Return the most recently attributed project dir for a session.
   */
  getLatestAttributedProjectDir(sessionId: string): string | null {
    const row = this.stmt(S.getLatestAttributedProject).get(sessionId) as { project_dir: string } | undefined;
    return row?.project_dir || null;
  }

  /**
   * Search events by text query scoped to a project directory.
   *
   * Performs a case-insensitive LIKE search across the `data` and `category`
   * columns. An optional `source` parameter filters by exact category match.
   * Returns results ordered by monotonic id (chronological).
   *
   * Best-effort: returns empty array on any error.
   */
  searchEvents(
    query: string,
    limit: number,
    projectDir: string,
    source?: string,
  ): Array<{
    id: number;
    session_id: string;
    category: string;
    type: string;
    data: string;
    created_at: string;
  }> {
    try {
      const escapedQuery = query.replace(/[%_]/g, (char) => "\\" + char);
      const sourceParam = source ?? null;
      return this.stmt(S.searchEvents).all(
        projectDir,
        escapedQuery,
        escapedQuery,
        sourceParam,
        sourceParam,
        limit,
      ) as Array<{
        id: number;
        session_id: string;
        category: string;
        type: string;
        data: string;
        created_at: string;
      }>;
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════
  // Meta
  // ═══════════════════════════════════════════

  /**
   * Ensure a session metadata entry exists. Idempotent (INSERT OR IGNORE).
   * `projectDir` is the session origin directory, not per-event attribution.
   */
  ensureSession(sessionId: string, projectDir: string): void {
    this.stmt(S.ensureSession).run(sessionId, projectDir);
  }

  /**
   * Get session statistics/metadata.
   */
  getSessionStats(sessionId: string): SessionMeta | null {
    const row = this.stmt(S.getSessionStats).get(sessionId) as SessionMeta | undefined;
    return row ?? null;
  }

  /**
   * Increment the compact_count for a session (tracks snapshot rebuilds).
   */
  incrementCompactCount(sessionId: string): void {
    this.stmt(S.incrementCompactCount).run(sessionId);
  }

  // ═══════════════════════════════════════════
  // Resume
  // ═══════════════════════════════════════════

  /**
   * Upsert a resume snapshot for a session. Resets consumed flag on update.
   */
  upsertResume(sessionId: string, snapshot: string, eventCount?: number): void {
    this.stmt(S.upsertResume).run(sessionId, snapshot, eventCount ?? 0);
  }

  /**
   * Retrieve the resume snapshot for a session.
   */
  getResume(sessionId: string): ResumeRow | null {
    const row = this.stmt(S.getResume).get(sessionId) as ResumeRow | undefined;
    return row ?? null;
  }

  /**
   * Mark the resume snapshot as consumed (already injected into conversation).
   */
  markResumeConsumed(sessionId: string): void {
    this.stmt(S.markResumeConsumed).run(sessionId);
  }

  /**
   * Atomically claim the most recent unconsumed resume snapshot in this DB,
   * EXCLUDING any row that belongs to `currentSessionId`.
   *
   * `SessionDB` is sharded per project (see `getSessionDBPath` — SHA-256 of
   * project dir), so "this DB" already implies "this project". The atomic
   * `UPDATE … RETURNING` ensures concurrent processes for the same project
   * cannot both inject the same snapshot (Mickey / PR #376 race).
   *
   * The `currentSessionId` parameter prevents self-injection: when a session
   * compacts mid-flight and produces its own row, that session's next chat
   * turn must NOT claim that row back (wasted tokens AND it would consume
   * the snapshot meant for the next fresh session).
   *
   * Pass an empty string to allow self-claim (legacy behaviour, only useful
   * in tests or one-off harnesses).
   *
   * Returns null when no unconsumed snapshot exists for any other session.
   */
  claimLatestUnconsumedResume(
    currentSessionId: string,
  ): { sessionId: string; snapshot: string } | null {
    const row = this.stmt(S.claimLatestUnconsumedResume).get(currentSessionId) as
      | { session_id: string; snapshot: string }
      | undefined;
    if (!row) return null;
    return { sessionId: row.session_id, snapshot: row.snapshot };
  }

  /**
   * Return the most recent session_id from session_meta, or null if none.
   * Used by the runtime to attach persistent counters to the right session
   * after a process restart.
   */
  getLatestSessionId(): string | null {
    try {
      const row = this.db.prepare(
        "SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1",
      ).get() as { session_id?: string } | undefined;
      return row?.session_id ?? null;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // Tool call counters (Bug #1 + #2 — survive restart, --continue, upgrade)
  // ═══════════════════════════════════════════

  /**
   * Increment the persistent tool-call counter for `tool` in `sessionId`.
   * Adds `bytesReturned` to the cumulative total. Idempotent across
   * SessionDB instances — counters survive process restart.
   */
  incrementToolCall(sessionId: string, tool: string, bytesReturned: number = 0): void {
    const safeBytes = Number.isFinite(bytesReturned) && bytesReturned > 0 ? Math.round(bytesReturned) : 0;
    try {
      this.stmt(S.incrementToolCall).run(sessionId, tool, safeBytes);
    } catch {
      // best-effort: counter must never throw and break the parent call
    }
  }

  /**
   * Get aggregated tool-call stats for `sessionId`. Returns zero-stats
   * when the session has no recorded calls.
   */
  getToolCallStats(sessionId: string): ToolCallStats {
    try {
      const totals = this.stmt(S.getToolCallTotals).get(sessionId) as
        | { calls: number; bytes_returned: number }
        | undefined;
      const rows = this.stmt(S.getToolCallByTool).all(sessionId) as Array<{
        tool: string;
        calls: number;
        bytes_returned: number;
      }>;

      const byTool: ToolCallStats["byTool"] = {};
      for (const row of rows) {
        byTool[row.tool] = {
          calls: row.calls,
          bytesReturned: row.bytes_returned,
        };
      }

      return {
        totalCalls: totals?.calls ?? 0,
        totalBytesReturned: totals?.bytes_returned ?? 0,
        byTool,
      };
    } catch {
      return { totalCalls: 0, totalBytesReturned: 0, byTool: {} };
    }
  }

  // ═══════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════

  /**
   * Delete all data for a session (events, meta, resume).
   */
  deleteSession(sessionId: string): void {
    this.db.transaction(() => {
      this.stmt(S.deleteEvents).run(sessionId);
      this.stmt(S.deleteResume).run(sessionId);
      this.stmt(S.deleteMeta).run(sessionId);
    })();
  }

  /**
   * Remove sessions older than maxAgeDays. Returns the count of deleted sessions.
   */
  cleanupOldSessions(maxAgeDays: number = 7): number {
    const negDays = `-${maxAgeDays}`;
    const oldSessions = this.stmt(S.getOldSessions).all(negDays) as Array<{ session_id: string }>;

    for (const { session_id } of oldSessions) {
      this.deleteSession(session_id);
    }

    return oldSessions.length;
  }
}
