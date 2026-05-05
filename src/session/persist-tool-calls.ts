/**
 * persist-tool-calls — runtime glue between MCP server's in-memory
 * `sessionStats` and the on-disk `tool_calls` SessionDB table.
 *
 * Why this module exists
 * ──────────────────────
 * Commit 4742160 (May 2 16:58) added the SessionDB write path so the
 * statusline counters survived `npm update -g context-mode` and
 * `claude --continue`. Commit b392c2f (May 2 21:43) — the concurrency
 * refactor — silently dropped that wiring as collateral. Same-session
 * `/ctx-upgrade` flips the statusline back to `0 calls / $0.00`
 * because the new PID starts with an empty `sessionStats` and never
 * looks at the table the old PID was writing to.
 *
 * This module re-introduces the write path AND adds the read-side
 * restore that 4742160 never shipped — both pure helpers so the
 * server.ts wiring is a one-liner and the unit tests don't need to
 * boot the MCP server.
 */

import { existsSync } from "node:fs";
import { SessionDB } from "./db.js";

/**
 * Shape returned by {@link restoreSessionStats}. Subset of the in-memory
 * `sessionStats` object the MCP server keeps — only the fields that can
 * be recovered from SessionDB.
 */
export interface RestoredSessionStats {
  /** Per-tool call counts. */
  calls: Record<string, number>;
  /** Per-tool returned bytes. */
  bytesReturned: Record<string, number>;
  /**
   * Epoch-ms for `session_meta.started_at` of the latest session, so the
   * statusline `uptime_ms` reflects the original session start instead of
   * resetting to `Date.now()` on every PID change.
   */
  sessionStart: number;
}

/**
 * Increment the persistent tool-call counter for `toolName` under whatever
 * session_id `session_meta` currently treats as the most recent. This is
 * called from {@link trackResponse} on every tool response and must be
 * cheap, non-throwing, and best-effort — a stats failure must never break
 * the MCP tool call.
 */
export function persistToolCallCounter(
  sessionDbPath: string,
  toolName: string,
  bytes: number,
): void {
  try {
    if (!existsSync(sessionDbPath)) return;
    const sdb = new SessionDB({ dbPath: sessionDbPath });
    try {
      const sid = sdb.getLatestSessionId();
      if (!sid) return;
      sdb.incrementToolCall(sid, toolName, bytes);
    } finally {
      sdb.close();
    }
  } catch {
    // Best-effort: counter must never throw and break the parent tool call.
  }
}

/**
 * Read the latest session's tool-call totals back out of SessionDB so the
 * MCP server can hydrate its in-memory `sessionStats` on startup. Returns
 * `null` when the DB is missing or empty so the caller can keep the
 * default zero-state without branching twice.
 *
 * Used during MCP server boot (BEFORE the heartbeat fires) so the
 * statusline doesn't briefly flash `0 calls / $0.00` after upgrade.
 */
export function restoreSessionStats(
  sessionDbPath: string,
): RestoredSessionStats | null {
  try {
    if (!existsSync(sessionDbPath)) return null;
    const sdb = new SessionDB({ dbPath: sessionDbPath });
    try {
      const sid = sdb.getLatestSessionId();
      if (!sid) return null;

      const stats = sdb.getToolCallStats(sid);
      const calls: Record<string, number> = {};
      const bytesReturned: Record<string, number> = {};
      for (const [tool, row] of Object.entries(stats.byTool)) {
        calls[tool] = row.calls;
        bytesReturned[tool] = row.bytesReturned;
      }

      // started_at is "YYYY-MM-DD HH:MM:SS" in UTC (SQLite datetime() default);
      // append "Z" so Date.parse interprets it as UTC, matching how the
      // session was actually persisted.
      let sessionStart = Date.now();
      try {
        const meta = sdb.getSessionStats(sid);
        if (meta?.started_at) {
          const parsed = Date.parse(`${meta.started_at}Z`);
          if (Number.isFinite(parsed) && parsed > 0) sessionStart = parsed;
        }
      } catch {
        // best-effort — keep `Date.now()` fallback
      }

      // Skip empty restores so callers can `if (restored)` and not stomp
      // their already-zero default with another zero.
      if (
        Object.keys(calls).length === 0 &&
        Object.keys(bytesReturned).length === 0
      ) {
        // Still useful to return sessionStart so uptime_ms doesn't reset
        // even when no tool calls were made — but only if we found a session.
        return { calls, bytesReturned, sessionStart };
      }

      return { calls, bytesReturned, sessionStart };
    } finally {
      sdb.close();
    }
  } catch {
    return null;
  }
}
