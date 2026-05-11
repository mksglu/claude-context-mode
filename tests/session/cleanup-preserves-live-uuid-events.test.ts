/**
 * Regression: SessionStart cleanup must NOT wipe live UUID-format session_id
 * events that don't yet have a session_meta row.
 *
 * Reported by Mert after a power-outage restart on 2026-05-09:
 *   DB `60303a5b5b31fb98__60303a5b.db` had 1000 events for UUID
 *   `b5833e08-...` (6 days of real Claude Code work). session_meta had
 *   NO row for that UUID. Original cleanup logic was:
 *
 *     DELETE FROM session_events
 *      WHERE session_id NOT IN (SELECT session_id FROM session_meta)
 *
 *   That unconditional DELETE wiped all 1000 events on the next fresh
 *   startup (no `--continue`).
 *
 * The fix protects UUID-format session_ids unless they are already older
 * than the cleanup horizon (default 7 days). pid-XXX detection probes are
 * still cleaned aggressively because they're noise, not real work.
 *
 * Test strategy: drive the EXACT cleanup statement from sessionstart.mjs
 * against a seeded DB. Re-running this against the unfixed code MUST fail
 * (proves the bug). Re-running against the fixed code MUST pass.
 */

import { afterAll, describe, expect, test } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { SessionDB } from "../../src/session/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "..", "hooks", "sessionstart.mjs");

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function createTestDB(): SessionDB {
  const dbPath = join(tmpdir(), `cleanup-uuid-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return db;
}

/**
 * Pull the cleanup SQL out of the live hook source so this test stays in
 * lockstep with hooks/sessionstart.mjs. If the hook gets refactored, the
 * test still exercises whatever DELETE statement ships.
 */
function loadCleanupSql(): string {
  const src = readFileSync(HOOK_PATH, "utf-8");
  // Match the full template literal passed to db.db.exec(`...DELETE FROM session_events...`)
  // The hook may use a single-line or multi-line backtick string.
  const match = src.match(/db\.db\.exec\(`([^`]*DELETE FROM session_events[^`]*)`\)/);
  if (!match) {
    throw new Error("Could not find cleanup DELETE statement in hooks/sessionstart.mjs");
  }
  return match[1];
}

function runCleanup(db: SessionDB): void {
  // Mirror what sessionstart.mjs does on a fresh startup (source === "startup").
  db.cleanupOldSessions(7);
  db.db.exec(loadCleanupSql());
}

function eventCount(db: SessionDB, sessionId: string): number {
  const row = db.db
    .prepare("SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?")
    .get(sessionId) as { cnt: number };
  return row.cnt;
}

describe("SessionStart cleanup — UUID-format orphan event protection", () => {
  // Slice 1: reproduce Mert's data loss
  test("preserves live UUID-format session events with no session_meta row (Mert bug)", () => {
    const db = createTestDB();
    const liveUuid = "aaaa1234-bbbb-5678-cccc-901234567890";

    // Seed events for a UUID-format session_id with NO matching session_meta
    // row. This mirrors the timing window observed on Mert's machine:
    // PostToolUse insertEvent fired but ensureSession had not yet upserted
    // the meta row (or a different code path bypassed meta entirely).
    for (let i = 0; i < 25; i++) {
      db.insertEvent(liveUuid, {
        type: "tool_use",
        category: "tool",
        priority: 1,
        data: `live-event-${i}`,
      }, "PostToolUse");
    }
    expect(eventCount(db, liveUuid)).toBe(25);

    // Sanity: no session_meta for this UUID.
    const metaRow = db.db
      .prepare("SELECT session_id FROM session_meta WHERE session_id = ?")
      .get(liveUuid);
    expect(metaRow).toBeUndefined();

    // Run cleanup the way sessionstart.mjs does on a fresh startup.
    runCleanup(db);

    // The events MUST survive. Pre-fix this fails (count drops to 0).
    expect(eventCount(db, liveUuid)).toBe(25);
  });

  // Slice 2: pid-XXX probes still get cleaned
  test("still deletes pid-XXX detection probe orphans", () => {
    const db = createTestDB();
    const pidProbe = "pid-12345";

    db.insertEvent(pidProbe, {
      type: "probe",
      category: "system",
      priority: 1,
      data: "detection-probe-noise",
    }, "PostToolUse");
    expect(eventCount(db, pidProbe)).toBe(1);

    runCleanup(db);

    // Probes are noise — must still be wiped.
    expect(eventCount(db, pidProbe)).toBe(0);
  });

  // Slice 3: truly abandoned UUID orphans (>7 days) get cleaned
  test("deletes UUID-format orphan events older than 7 days", () => {
    const db = createTestDB();
    const oldUuid = "11111111-2222-3333-4444-555555555555";

    db.insertEvent(oldUuid, {
      type: "tool_use",
      category: "tool",
      priority: 1,
      data: "ancient-event",
    }, "PostToolUse");
    // Backdate to 30 days ago.
    db.db
      .prepare("UPDATE session_events SET created_at = datetime('now', '-30 day') WHERE session_id = ?")
      .run(oldUuid);
    expect(eventCount(db, oldUuid)).toBe(1);

    runCleanup(db);

    // Truly abandoned UUID with no meta and no recent activity — clean it.
    expect(eventCount(db, oldUuid)).toBe(0);
  });

  // Slice 4: recent UUID orphans preserved (the bug fix proper)
  test("preserves UUID orphan events created within the last 7 days", () => {
    const db = createTestDB();
    const recentUuid = "deadbeef-feed-cafe-babe-1234567890ab";

    db.insertEvent(recentUuid, {
      type: "tool_use",
      category: "tool",
      priority: 1,
      data: "recent-event",
    }, "PostToolUse");
    // Backdate to 2 days ago — well inside the 7-day horizon.
    db.db
      .prepare("UPDATE session_events SET created_at = datetime('now', '-2 day') WHERE session_id = ?")
      .run(recentUuid);
    expect(eventCount(db, recentUuid)).toBe(1);

    runCleanup(db);

    // Inside the protection window — must survive.
    expect(eventCount(db, recentUuid)).toBe(1);
  });

  // Defense in depth: events that DO have a meta row are never touched.
  test("preserves events that have a matching session_meta row (control)", () => {
    const db = createTestDB();
    const sid = "ccccdddd-eeee-ffff-1111-222233334444";

    db.ensureSession(sid, "/project");
    db.insertEvent(sid, {
      type: "tool_use",
      category: "tool",
      priority: 1,
      data: "with-meta",
    }, "PostToolUse");

    runCleanup(db);

    expect(eventCount(db, sid)).toBe(1);
  });
});
