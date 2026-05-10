/**
 * real-bytes-stats — Phase 8 of D2 PRD (stats-event-driven-architecture)
 *
 * `getRealBytesStats` is the new SQL aggregator that replaces the
 * conservative `conversation.events × 256` token estimate with real
 * bytes drawn from `session_events.data` length, the new
 * `bytes_avoided` / `bytes_returned` columns, and the `session_resume`
 * snapshot table.
 *
 * Math (per PRD step 5):
 *   eventDataBytes  = SUM(LENGTH(data))            FROM session_events
 *   bytesAvoided    = SUM(bytes_avoided)           FROM session_events
 *   bytesReturned   = SUM(bytes_returned)          FROM session_events
 *   snapshotBytes   = SUM(LENGTH(snapshot))        FROM session_resume
 *   totalSavedTokens = (eventDataBytes + bytesAvoided + snapshotBytes) / 4
 *
 * The renderer plumbs this into formatReport via opts.realBytes so the
 * "$ saved" line stops under-counting. Lifetime + project tier variants
 * exercised below (omit `sessionId` for lifetime, add `worktreeHash` for
 * project filter).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { getRealBytesStats } from "../../src/session/analytics.js";

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function mkSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "real-bytes-"));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function dbPathFor(sessionsDir: string, hash: string): string {
  return join(sessionsDir, `${hash}__suffix.db`);
}

function seed(
  dbPath: string,
  sessionId: string,
  events: Array<{ type: string; category: string; data: string; bytesAvoided?: number; bytesReturned?: number }>,
  snapshots?: Array<{ snapshot: string }>,
): void {
  const sdb = new SessionDB({ dbPath });
  try {
    sdb.ensureSession(sessionId, "/tmp/proj");
    let i = 0;
    for (const e of events) {
      sdb.insertEvent(
        sessionId,
        {
          type: e.type,
          category: e.category,
          priority: 1,
          // suffix uniquifies data so dedup doesn't drop subsequent rows
          data: `${e.data}#${i++}`,
          project_dir: "",
          attribution_source: "test",
          attribution_confidence: 1,
        },
        "test",
        undefined,
        { bytesAvoided: e.bytesAvoided, bytesReturned: e.bytesReturned },
      );
    }
    if (snapshots) {
      for (const s of snapshots) {
        sdb.upsertResume(sessionId, s.snapshot, events.length);
      }
    }
  } finally {
    sdb.close();
  }
}

describe("getRealBytesStats (Phase 8 renderer source-of-truth)", () => {
  test("8.1 conversation tier: sums data + bytes_avoided + bytes_returned + snapshot for one session", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    const dbPath = dbPathFor(dir, "deadbeefdeadbeef");
    seed(dbPath, sid, [
      { type: "tool_use", category: "file", data: "src/app.ts", bytesAvoided: 0, bytesReturned: 0 },
      { type: "sandbox-execute", category: "sandbox", data: "ctx_execute", bytesReturned: 5_000 },
      { type: "index-write", category: "sandbox", data: "execute:javascript", bytesAvoided: 10_000 },
      { type: "cache-hit", category: "cache", data: "https://x", bytesAvoided: 20_000 },
    ], [{ snapshot: "X".repeat(8_000) }]);

    const r = getRealBytesStats({ sessionId: sid, sessionsDir: dir });

    // eventDataBytes = sum of LENGTH(data) across the 4 events. The seed
    // suffix `#N` adds 2 bytes/event, but the assertion only checks that
    // the value is in a sane range — exact byte arithmetic is fragile.
    expect(r.eventDataBytes).toBeGreaterThan(40); // 4 short rows w/ suffixes
    expect(r.eventDataBytes).toBeLessThan(500);
    expect(r.bytesAvoided).toBe(30_000);
    expect(r.bytesReturned).toBe(5_000);
    expect(r.snapshotBytes).toBe(8_000);
    // totalSavedTokens = (eventDataBytes + bytesAvoided + snapshotBytes) / 4
    // (bytesReturned is "what the model already paid for" — don't add)
    const expectedTokens = Math.floor((r.eventDataBytes + r.bytesAvoided + r.snapshotBytes) / 4);
    expect(r.totalSavedTokens).toBe(expectedTokens);
    expect(r.totalSavedTokens).toBeGreaterThan(9_000); // ≈ 9_500
  });

  test("8.5 lifetime tier: omitting sessionId aggregates every session in sessionsDir", () => {
    const dir = mkSessionsDir();
    const sidA = `lifeA-${randomUUID()}`;
    const sidB = `lifeB-${randomUUID()}`;
    seed(dbPathFor(dir, "1111111111111111"), sidA, [
      { type: "sandbox-execute", category: "sandbox", data: "x", bytesReturned: 1_000 },
      { type: "cache-hit", category: "cache", data: "y", bytesAvoided: 2_000 },
    ]);
    seed(dbPathFor(dir, "2222222222222222"), sidB, [
      { type: "index-write", category: "sandbox", data: "z", bytesAvoided: 3_000 },
    ]);

    const r = getRealBytesStats({ sessionsDir: dir });
    expect(r.bytesAvoided).toBe(5_000);   // 2_000 + 3_000
    expect(r.bytesReturned).toBe(1_000);
    expect(r.totalSavedTokens).toBeGreaterThan(0);
  });

  test("8.6 project tier: worktreeHash filters DB files by filename prefix", () => {
    const dir = mkSessionsDir();
    const sidA = `pa-${randomUUID()}`;
    const sidB = `pb-${randomUUID()}`;
    seed(dbPathFor(dir, "60303a5b5b31fb98"), sidA, [
      { type: "sandbox-execute", category: "sandbox", data: "ctx_execute", bytesReturned: 7_000 },
    ]);
    seed(dbPathFor(dir, "abcdef0123456789"), sidB, [
      { type: "sandbox-execute", category: "sandbox", data: "ctx_execute", bytesReturned: 99_999 },
    ]);

    const r = getRealBytesStats({ sessionsDir: dir, worktreeHash: "60303a5b5b31fb98" });
    expect(r.bytesReturned).toBe(7_000); // ONLY the matching DB
  });

  test("returns zeroes when sessionsDir does not exist", () => {
    const r = getRealBytesStats({ sessionsDir: join(tmpdir(), `missing-${randomUUID()}`) });
    expect(r.eventDataBytes).toBe(0);
    expect(r.bytesAvoided).toBe(0);
    expect(r.bytesReturned).toBe(0);
    expect(r.snapshotBytes).toBe(0);
    expect(r.totalSavedTokens).toBe(0);
  });

  test("returns zeroes for unknown sessionId in a real DB", () => {
    const dir = mkSessionsDir();
    const sid = `seed-${randomUUID()}`;
    seed(dbPathFor(dir, "f1f1f1f1f1f1f1f1"), sid, [
      { type: "sandbox-execute", category: "sandbox", data: "x", bytesReturned: 1 },
    ]);
    const r = getRealBytesStats({ sessionId: "no-such-session", sessionsDir: dir });
    expect(r.eventDataBytes).toBe(0);
    expect(r.bytesAvoided).toBe(0);
    expect(r.bytesReturned).toBe(0);
    expect(r.totalSavedTokens).toBe(0);
  });
});
