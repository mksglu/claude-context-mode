/**
 * event-emit — Phase 5+7 of D2 PRD (stats-event-driven-architecture)
 *
 * Server-side helpers that record sandbox / index / cache work into
 * `session_events` with the new `bytes_avoided` / `bytes_returned`
 * columns so the renderer can compute the real $ saved instead of the
 * conservative `events × 256` token estimate.
 *
 * Design notes
 * ────────────
 * - Uses the public `SessionDB.insertEvent(... , bytes)` API the schema
 *   engineer extended in this branch — same dedup + FIFO eviction +
 *   transaction wrapping you'd get from any other event source.
 * - Best-effort error swallowing matches `persistToolCallCounter` in
 *   `persist-tool-calls.ts`. A stats-side failure must NEVER break the
 *   parent MCP tool call.
 * - Resolves the latest `session_id` from `session_meta` so the wiring
 *   in `server.ts` is `setImmediate(() => emit*({...}))` — no need to
 *   plumb session ids through every handler.
 */

import { existsSync } from "node:fs";
import { SessionDB } from "./db.js";

/**
 * Open the SessionDB at `dbPath`, find the latest session_id, and run
 * `fn` with both. Wraps everything in try/catch so callers stay
 * fire-and-forget.
 */
function withLatestSession(
  dbPath: string,
  fn: (db: SessionDB, sessionId: string) => void,
): void {
  try {
    if (!existsSync(dbPath)) return;
    const sdb = new SessionDB({ dbPath });
    try {
      const sid = sdb.getLatestSessionId();
      if (!sid) return;
      fn(sdb, sid);
    } finally {
      try { sdb.close(); } catch { /* ignore */ }
    }
  } catch {
    // Best-effort: never break the parent MCP tool call.
  }
}

/**
 * Record a `ctx_execute` / `ctx_execute_file` / `ctx_batch_execute` run.
 * `bytesReturned` is the size of the stdout text the user actually saw —
 * the rest of the sandbox output stayed out of context.
 */
export function emitSandboxExecuteEvent(opts: {
  sessionDbPath: string;
  toolName: string;
  bytesReturned: number;
}): void {
  withLatestSession(opts.sessionDbPath, (sdb, sid) => {
    sdb.insertEvent(
      sid,
      {
        type: "sandbox-execute",
        category: "sandbox",
        priority: 1,
        data: opts.toolName,
        project_dir: "",
        attribution_source: "server",
        attribution_confidence: 1,
      },
      "ctx-server",
      undefined,
      { bytesReturned: opts.bytesReturned },
    );
  });
}

/**
 * Record a `ctx_index` / `trackIndexed` write — content kept out of
 * context by being chunked into FTS5 instead of returned inline.
 */
export function emitIndexWriteEvent(opts: {
  sessionDbPath: string;
  source: string;
  bytesAvoided: number;
}): void {
  withLatestSession(opts.sessionDbPath, (sdb, sid) => {
    sdb.insertEvent(
      sid,
      {
        type: "index-write",
        category: "sandbox",
        priority: 1,
        data: opts.source,
        project_dir: "",
        attribution_source: "server",
        attribution_confidence: 1,
      },
      "ctx-server",
      undefined,
      { bytesAvoided: opts.bytesAvoided },
    );
  });
}

/**
 * Record a `ctx_fetch_and_index` TTL cache hit — bytes the user would
 * have spent re-fetching the same URL within the 24h cache window.
 */
export function emitCacheHitEvent(opts: {
  sessionDbPath: string;
  source: string;
  bytesAvoided: number;
}): void {
  withLatestSession(opts.sessionDbPath, (sdb, sid) => {
    sdb.insertEvent(
      sid,
      {
        type: "cache-hit",
        category: "cache",
        priority: 1,
        data: opts.source,
        project_dir: "",
        attribution_source: "server",
        attribution_confidence: 1,
      },
      "ctx-server",
      undefined,
      { bytesAvoided: opts.bytesAvoided },
    );
  });
}
