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
 * - Coalesces rapid events per SessionDB path before opening SQLite, so busy
 *   tool loops do not create an open/write/close storm.
 */

import { existsSync } from "node:fs";
import { enqueueDbWrite } from "../db-write-queue.js";
import { SessionDB, type EventBytes } from "./db.js";
import type { SessionEvent } from "../types.js";

export const SESSION_EVENT_FLUSH_DELAY_MS = 100;

interface PendingSessionEvent {
  event: Omit<SessionEvent, "data_hash"> & { data_hash?: string };
  bytes?: EventBytes;
}

const pendingByPath = new Map<string, PendingSessionEvent[]>();
let flushTimer: NodeJS.Timeout | undefined;

/**
 * Open the SessionDB at `dbPath`, find the latest session_id, and insert all
 * queued events in one transaction. Wraps everything in try/catch so callers
 * stay fire-and-forget.
 */
function flushPath(dbPath: string, pending: PendingSessionEvent[]): void {
  try {
    if (!existsSync(dbPath)) return;
    const sdb = new SessionDB({ dbPath });
    try {
      const sid = sdb.getLatestSessionId();
      if (!sid) return;
      sdb.bulkInsertEvents(
        sid,
        pending.map((p) => p.event),
        "ctx-server",
        undefined,
        pending.map((p) => p.bytes),
      );
    } finally {
      try { sdb.close(); } catch { /* ignore */ }
    }
  } catch {
    // Best-effort: never break the parent MCP tool call.
  }
}

function takePending(): Array<[string, PendingSessionEvent[]]> {
  const batches = Array.from(pendingByPath.entries());
  pendingByPath.clear();
  return batches;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushSessionEvents();
  }, SESSION_EVENT_FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

function enqueueSessionEvent(sessionDbPath: string, event: PendingSessionEvent): void {
  const pending = pendingByPath.get(sessionDbPath) ?? [];
  pending.push(event);
  pendingByPath.set(sessionDbPath, pending);
  scheduleFlush();
}

export async function flushSessionEvents(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const batches = takePending();
  await Promise.all(batches.map(([dbPath, pending]) => (
    enqueueDbWrite(dbPath, () => flushPath(dbPath, pending))
  )));
}

export function flushSessionEventsSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  for (const [dbPath, pending] of takePending()) {
    flushPath(dbPath, pending);
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
  enqueueSessionEvent(opts.sessionDbPath, {
    event: {
        type: "sandbox-execute",
        category: "sandbox",
        priority: 1,
        data: opts.toolName,
        project_dir: "",
        attribution_source: "server",
        attribution_confidence: 1,
      },
    bytes: { bytesReturned: opts.bytesReturned },
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
  enqueueSessionEvent(opts.sessionDbPath, {
    event: {
        type: "index-write",
        category: "sandbox",
        priority: 1,
        data: opts.source,
        project_dir: "",
        attribution_source: "server",
        attribution_confidence: 1,
      },
    bytes: { bytesAvoided: opts.bytesAvoided },
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
  enqueueSessionEvent(opts.sessionDbPath, {
    event: {
        type: "cache-hit",
        category: "cache",
        priority: 1,
        data: opts.source,
        project_dir: "",
        attribution_source: "server",
        attribution_confidence: 1,
      },
    bytes: { bytesAvoided: opts.bytesAvoided },
  });
}
