/**
 * Analytics Metrics — Tests for AnalyticsEngine
 *
 * Tests runtime metric computation (static helpers) and queryAll()
 * against an in-memory SessionDB.
 *
 * Schema: session_events, session_meta, session_resume
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { AnalyticsEngine } from "../../src/session/analytics.js";

// ─────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────

/** Schema matching src/session/db.ts */
function createSchema(db: Database.Database): void {
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

interface InsertEventParams {
  session_id: string;
  type: string;
  category: string;
  priority?: number;
  data: string;
  source_hook?: string;
  created_at?: string;
  data_hash?: string;
}

function insertEvent(db: Database.Database, params: InsertEventParams): void {
  db.prepare(`
    INSERT INTO session_events (session_id, type, category, priority, data, source_hook, created_at, data_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.session_id,
    params.type,
    params.category,
    params.priority ?? 2,
    params.data,
    params.source_hook ?? "PostToolUse",
    params.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
    params.data_hash ?? "",
  );
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  projectDir: string,
  startedAt: string,
  lastEventAt: string | null = null,
  eventCount: number = 0,
  compactCount: number = 0,
): void {
  db.prepare(`
    INSERT INTO session_meta (session_id, project_dir, started_at, last_event_at, event_count, compact_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, projectDir, startedAt, lastEventAt, eventCount, compactCount);
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe("Analytics Metrics", () => {
  let db: Database.Database;
  let engine: AnalyticsEngine;
  const SESSION_ID = "test-session-001";
  const PROJECT_DIR = "/Users/dev/my-project";

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    engine = new AnalyticsEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Runtime Metrics (static helpers) ──────────────────

  describe("Runtime Metrics", () => {
    it("#1 Context savings — computes saved bytes and percentage", () => {
      const savings = AnalyticsEngine.contextSavingsTotal(847_000, 3_600);

      expect(savings.rawBytes).toBe(847_000);
      expect(savings.contextBytes).toBe(3_600);
      expect(savings.savedBytes).toBe(843_400);
      expect(savings.savedPercent).toBe(99.6);
    });

    it("#1 Context savings — 0% when no raw bytes", () => {
      const savings = AnalyticsEngine.contextSavingsTotal(0, 0);
      expect(savings.savedPercent).toBe(0);
      expect(savings.savedBytes).toBe(0);
    });

    it("#1 Context savings — handles edge case where context > raw", () => {
      // This shouldn't happen in practice, but defensive
      const savings = AnalyticsEngine.contextSavingsTotal(100, 200);
      expect(savings.savedBytes).toBe(-100);
      expect(savings.savedPercent).toBe(-100);
    });

    it("#2 Think in Code comparison — computes file-to-output ratio", () => {
      const comparison = AnalyticsEngine.thinkInCodeComparison(50_000, 2_000);

      expect(comparison.fileBytes).toBe(50_000);
      expect(comparison.outputBytes).toBe(2_000);
      expect(comparison.ratio).toBe(25); // 50K/2K = 25x
    });

    it("#2 Think in Code — handles zero output", () => {
      const comparison = AnalyticsEngine.thinkInCodeComparison(10_000, 0);
      expect(comparison.ratio).toBe(0);
    });

    it("#3 Tool-based savings — per-tool breakdown", () => {
      const tools = [
        { tool: "batch_execute", rawBytes: 500_000, contextBytes: 2_000 },
        { tool: "execute", rawBytes: 200_000, contextBytes: 1_000 },
        { tool: "search", rawBytes: 100_000, contextBytes: 500 },
      ];

      const savings = AnalyticsEngine.toolSavings(tools);
      expect(savings).toHaveLength(3);

      expect(savings[0].tool).toBe("batch_execute");
      expect(savings[0].savedBytes).toBe(498_000);

      expect(savings[1].tool).toBe("execute");
      expect(savings[1].savedBytes).toBe(199_000);

      expect(savings[2].tool).toBe("search");
      expect(savings[2].savedBytes).toBe(99_500);
    });

    it("#3 Tool-based savings — empty array when no tools", () => {
      expect(AnalyticsEngine.toolSavings([])).toHaveLength(0);
    });

    it("#19 Sandbox I/O — tracks input and output bytes", () => {
      const io = AnalyticsEngine.sandboxIO(847_000, 3_600);

      expect(io.inputBytes).toBe(847_000);
      expect(io.outputBytes).toBe(3_600);
    });

    it("#19 Sandbox I/O — zero values for unused sandbox", () => {
      const io = AnalyticsEngine.sandboxIO(0, 0);
      expect(io.inputBytes).toBe(0);
      expect(io.outputBytes).toBe(0);
    });
  });

  // ─── queryAll — unified report ─────────────────────────

  describe("queryAll", () => {
    const runtimeStats = {
      bytesReturned: { ctx_execute: 1024, ctx_search: 512 },
      bytesIndexed: 50_000,
      bytesSandboxed: 100_000,
      calls: { ctx_execute: 5, ctx_search: 3 },
      sessionStart: Date.now() - 60_000 * 10, // 10 min ago
      cacheHits: 0,
      cacheBytesSaved: 0,
    };

    it("returns savings from runtime stats", () => {
      const report = engine.queryAll(runtimeStats);

      expect(report.savings.total_calls).toBe(8);
      expect(report.savings.kept_out).toBe(150_000);
      expect(report.savings.total_bytes_returned).toBe(1536);
      expect(report.savings.by_tool).toHaveLength(2);
    });

    it("returns session with uptime_min", () => {
      const report = engine.queryAll(runtimeStats);
      expect(report.session.uptime_min).toBeDefined();
      expect(parseFloat(report.session.uptime_min)).toBeGreaterThan(0);
    });

    it("returns continuity data from DB", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", null, 0, 2);
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/app.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit" });

      const report = engine.queryAll(runtimeStats);
      expect(report.continuity.total_events).toBe(2);
      expect(report.continuity.compact_count).toBe(2);
      expect(report.continuity.by_category).toHaveLength(2);
    });

    it("includes cache when cache stats are present", () => {
      const statsWithCache = {
        ...runtimeStats,
        cacheHits: 3,
        cacheBytesSaved: 25_000,
      };
      const report = engine.queryAll(statsWithCache);
      expect(report.cache).toBeDefined();
      expect(report.cache!.hits).toBe(3);
      expect(report.cache!.bytes_saved).toBe(25_000);
    });

    it("omits cache when no cache activity", () => {
      const report = engine.queryAll(runtimeStats);
      expect(report.cache).toBeUndefined();
    });

    it("works with empty DB", () => {
      const report = engine.queryAll(runtimeStats);
      expect(report.session.id).toBe("");
      expect(report.continuity.total_events).toBe(0);
      expect(report.continuity.compact_count).toBe(0);
    });
  });
});
