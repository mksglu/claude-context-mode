/**
 * Regression test for cross-session bleed (#398).
 *
 * Bug: the `resume` branch of every SessionStart adapter was calling
 * getLatestSessionEvents(db) — which returns events from whichever
 * session has the most recent session_meta.started_at, regardless of
 * which session is actually being resumed. When a parallel session
 * (worktree, second IDE, different repo) started after the resumed
 * one, its events leaked into the resumed session's
 * <session_knowledge> block — wrong cwd, wrong files, wrong errors.
 *
 * Fix (PR #398, commit 46f3d74): all 6 SessionStart adapters now read
 * the resuming session's id from the hook input and pass it to
 * getSessionEvents(db, sessionId). On unknown sessionId, [] is
 * returned rather than falling back to global most-recent.
 *
 * These tests pin the underlying contract that the fix relies on:
 *   1. getSessionEvents(db, sid) returns ONLY events for `sid`.
 *   2. getSessionEvents(db, "unknown") returns [] — no fallback.
 *
 * If either contract regresses, all 6 SessionStart adapters silently
 * leak again. These tests fail loudly instead.
 */
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
// @ts-expect-error — .mjs has no .d.ts; functions are tested via runtime contract.
import { getSessionEvents, getLatestSessionEvents } from "../../hooks/session-directive.mjs";

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      // ignore cleanup errors
    }
  }
});

function createTestDB(): SessionDB {
  const dbPath = join(tmpdir(), `test-bleed-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return db;
}

describe("cross-session bleed regression (#398)", () => {
  test("getSessionEvents filters by sessionId — resuming A does not leak B's events", () => {
    const db = createTestDB();

    // Session A — older, in repo X.
    const sidA = `A-${randomUUID()}`;
    db.ensureSession(sidA, "/repo/x");
    db.insertEvent(sidA, {
      type: "file_read",
      category: "file",
      data: "/repo/x/main.ts",
      priority: 1,
    }, "PostToolUse");
    db.insertEvent(sidA, {
      type: "git_branch",
      category: "git",
      data: "feature/x",
      priority: 2,
    }, "PostToolUse");

    // Session B — newer, in repo Y. Started AFTER A — would win in
    // getLatestSessionEvents() and therefore leak into A's resume.
    const sidB = `B-${randomUUID()}`;
    db.ensureSession(sidB, "/repo/y");
    db.insertEvent(sidB, {
      type: "file_read",
      category: "file",
      data: "/repo/y/lib.ts",
      priority: 1,
    }, "PostToolUse");
    db.insertEvent(sidB, {
      type: "error_tool",
      category: "error",
      data: "tsc failed in /repo/y",
      priority: 2,
    }, "PostToolUse");

    // Resume session A — must get ONLY A's events.
    const aEvents: Array<{ session_id: string; data: string }> =
      getSessionEvents(db, sidA);

    assert.equal(aEvents.length, 2, "A should have exactly 2 events");
    assert.ok(
      aEvents.every((e) => e.session_id === sidA),
      "every returned event must be tagged session A",
    );
    assert.ok(
      aEvents.some((e) => e.data === "/repo/x/main.ts"),
      "A's file_read event should be present",
    );
    assert.ok(
      !aEvents.some((e) => e.data === "/repo/y/lib.ts"),
      "B's file_read event must NOT bleed into A",
    );
    assert.ok(
      !aEvents.some((e) => e.data === "tsc failed in /repo/y"),
      "B's error event must NOT bleed into A",
    );

    // Sanity check the inverse — B unaffected too.
    const bEvents: Array<{ session_id: string }> = getSessionEvents(db, sidB);
    assert.equal(bEvents.length, 2, "B should have exactly 2 events");
    assert.ok(
      bEvents.every((e) => e.session_id === sidB),
      "every B event must be tagged session B",
    );
  });

  test("getSessionEvents returns [] for unknown sessionId — no fallback to latest", () => {
    const db = createTestDB();

    // Indexed events exist for some other session.
    const sidOther = `other-${randomUUID()}`;
    db.ensureSession(sidOther, "/repo");
    db.insertEvent(sidOther, {
      type: "file_read",
      category: "file",
      data: "/repo/main.ts",
      priority: 1,
    }, "PostToolUse");

    // Query for a sessionId that does not exist.
    const events: unknown[] = getSessionEvents(db, "non-existent-session-id");
    assert.equal(
      events.length,
      0,
      "unknown sessionId must return [], not fall back to latest",
    );
  });

  test("getLatestSessionEvents demonstrates the original bug — would return B's events when resuming A", () => {
    // This test pins the *behavior* that PR #398 explicitly avoided in
    // the resume branch. getLatestSessionEvents is still exported
    // (per PR notes — kept intact as part of the public surface) and
    // its implementation MUST continue to globally pick the most
    // recent session, so any future caller that uses it is choosing
    // that behavior consciously. If this changes silently the bug's
    // root cause has shifted and PR #398's reasoning needs revisiting.
    const db = createTestDB();

    const sidA = `A-${randomUUID()}`;
    db.ensureSession(sidA, "/repo/x");
    db.insertEvent(sidA, {
      type: "file_read",
      category: "file",
      data: "/repo/x/main.ts",
      priority: 1,
    }, "PostToolUse");

    // Force B's started_at to be later than A's by a measurable amount.
    // ensureSession defaults started_at = datetime('now'); the next call
    // picks up the same second, so we update explicitly to avoid flake.
    const sidB = `B-${randomUUID()}`;
    db.ensureSession(sidB, "/repo/y");
    // bump B's started_at one second forward
    (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE session_meta SET started_at = datetime('now', '+1 second') WHERE session_id = ?")
      .run(sidB);
    db.insertEvent(sidB, {
      type: "file_read",
      category: "file",
      data: "/repo/y/lib.ts",
      priority: 1,
    }, "PostToolUse");

    const latest: Array<{ session_id: string }> = getLatestSessionEvents(db);
    assert.ok(
      latest.every((e) => e.session_id === sidB),
      "getLatestSessionEvents picks the globally most recent session — by design",
    );
    assert.ok(
      latest.length > 0,
      "getLatestSessionEvents must return events when any session has them",
    );
  });
});
