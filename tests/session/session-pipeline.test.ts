import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, test } from "vitest";
import { extractEvents, extractUserEvents, resetErrorResolutionState, resetIterationLoopState } from "../../src/session/extract.js";
import { SessionDB } from "../../src/session/db.js";
import { buildResumeSnapshot } from "../../src/session/snapshot.js";

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

/** Create a temporary SessionDB that auto-registers for cleanup. */
function createTestDB(): SessionDB {
  const dbPath = join(tmpdir(), `test-pipeline-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  cleanups.push(() => db.cleanup());
  return db;
}

// ════════════════════════════════════════════
// TEST 1: Full pipeline -- Edit + Git + CLAUDE.md -> Snapshot -> Resume injection
// ════════════════════════════════════════════

describe("1. Full Pipeline: Edit + Git + CLAUDE.md", () => {
  test("full pipeline: extract -> store -> snapshot -> resume lifecycle", () => {
    const db = createTestDB();
    const sid = `pipeline-${randomUUID()}`;
    db.ensureSession(sid, "/project");

    // Step 1: Extract events from multiple tool calls
    const editEvents = extractEvents({
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/server.ts",
        old_string: 'const VERSION = "0.9.21"',
        new_string: 'const VERSION = "0.9.22"',
      },
      tool_response: "File edited successfully",
    });

    const gitEvents = extractEvents({
      tool_name: "Bash",
      tool_input: { command: "git checkout -b feature/session-continuity" },
      tool_response: "Switched to a new branch 'feature/session-continuity'",
    });

    const claudeMdEvents = extractEvents({
      tool_name: "Read",
      tool_input: { file_path: "/project/CLAUDE.md" },
      tool_response: "# Rules\n- Never push without approval\n- Always use TypeScript",
    });

    // Verify extraction produced events
    assert.ok(editEvents.length >= 1, "Edit should produce at least 1 event");
    assert.ok(gitEvents.length >= 1, "Git checkout should produce at least 1 event");
    assert.ok(claudeMdEvents.length >= 2, "CLAUDE.md read should produce rule + file_read events");

    // Step 2: Insert all events into DB
    for (const ev of editEvents) db.insertEvent(sid, ev, "PostToolUse");
    for (const ev of gitEvents) db.insertEvent(sid, ev, "PostToolUse");
    for (const ev of claudeMdEvents) db.insertEvent(sid, ev, "PostToolUse");

    // Step 3: Build snapshot from stored events
    const storedEvents = db.getEvents(sid);
    const snapshot = buildResumeSnapshot(storedEvents);

    // Step 4: Upsert resume
    db.upsertResume(sid, snapshot, storedEvents.length);

    // Step 5: Verify resume XML structure
    assert.ok(snapshot.includes("<files"), "resume should contain <files section");
    assert.ok(snapshot.includes("<rules"), "resume should contain <rules section");
    assert.ok(snapshot.includes("<how_to_search>"), "resume should contain how_to_search block");

    // Step 6: Verify XML wrapper
    assert.ok(snapshot.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(snapshot.endsWith("</session_resume>"), "should end with </session_resume>");

    // Step 8: Verify resume consumed lifecycle
    const resume = db.getResume(sid);
    assert.ok(resume !== null, "resume should exist");
    assert.equal(resume!.consumed, 0, "resume should not be consumed yet");

    db.markResumeConsumed(sid);
    const consumed = db.getResume(sid);
    assert.equal(consumed!.consumed, 1, "resume should be consumed after marking");
  });
});

// ════════════════════════════════════════════
// TEST 2: User decisions preserved in resume
// ════════════════════════════════════════════

describe("2. User Decisions Preserved in Resume", () => {
  test("user decisions are preserved in resume snapshot", () => {
    const db = createTestDB();
    const sid = `decisions-${randomUUID()}`;
    db.ensureSession(sid, "/project");

    // Extract decision event from user message.
    // Universal-rule shape (issue #535): the message carries a clause
    // separator + non-question + corrective length → decision.
    const decisionEvents = extractUserEvents("never push to main, ask me first");
    assert.ok(decisionEvents.length >= 1, "should extract at least 1 decision event");

    const decisionEvent = decisionEvents.find(e => e.type === "decision");
    assert.ok(decisionEvent, "should have a decision event");

    // Insert the decision event
    db.insertEvent(sid, decisionEvent!, "UserPromptSubmit");

    // Build snapshot
    const storedEvents = db.getEvents(sid);
    const snapshot = buildResumeSnapshot(storedEvents);

    // Verify the snapshot contains the decision text or rules/decisions section
    const hasDecisions = snapshot.includes("<decisions") || snapshot.includes("<rules");
    assert.ok(hasDecisions, "snapshot should contain <decisions> or <rules> section");
    assert.ok(
      snapshot.includes("never push to main") || snapshot.includes("push to main"),
      "snapshot should contain the decision text",
    );
  });
});

// ════════════════════════════════════════════
// TEST 3: Deduplication works end-to-end
// ════════════════════════════════════════════

describe("3. Deduplication End-to-End", () => {
  test("deduplication: inserting same Edit event 5 times stores only 1", () => {
    const db = createTestDB();
    const sid = `dedup-${randomUUID()}`;
    db.ensureSession(sid, "/project");

    const editInput = {
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/store.ts",
        old_string: "const x = 1",
        new_string: "const x = 2",
      },
      tool_response: "File edited successfully",
    };

    // Reset cross-event stateful extractors so prior test state doesn't leak.
    resetErrorResolutionState();
    resetIterationLoopState();

    // Extract the same events 5 times and insert only file_edit events.
    // Stateful cross-event extractors (iteration-loop) may emit extra meta-events
    // on repeated identical input; filter those out to isolate the dedup test.
    for (let i = 0; i < 5; i++) {
      const events = extractEvents(editInput);
      for (const ev of events) {
        if (ev.type === "file_edit") {
          db.insertEvent(sid, ev, "PostToolUse");
        }
      }
    }

    // Should only have 1 event due to dedup
    const count = db.getEventCount(sid);
    assert.equal(count, 1, `expected 1 event after dedup, got ${count}`);

    // Build snapshot -- file should appear only once
    const storedEvents = db.getEvents(sid);
    const snapshot = buildResumeSnapshot(storedEvents);
    // New format uses <files count="N"> — count should be 1 for one unique file
    assert.ok(snapshot.includes('count="1"'), `expected count="1" for single file, got: ${snapshot}`);
  });
});

// ════════════════════════════════════════════
// TEST 4: SessionStart lifecycle: startup purges, compact injects, resume noops
// ════════════════════════════════════════════

describe("4. SessionStart Lifecycle", () => {
  test("lifecycle: old session data, new session creation, compact, resume", () => {
    const db = createTestDB();

    // --- Phase 1: Create an "old" session with events and resume ---
    const oldSid = "old-session";
    db.ensureSession(oldSid, "/project/old");
    db.insertEvent(oldSid, {
      type: "file",
      category: "file",
      data: "/project/old/legacy.ts",
      priority: 1,
    }, "PostToolUse");
    db.upsertResume(oldSid, "<session_resume>old data</session_resume>", 1);

    // Verify old session exists
    assert.ok(db.getSessionStats(oldSid) !== null, "old session should exist");
    assert.ok(db.getResume(oldSid) !== null, "old resume should exist");

    // --- Phase 2: Simulate startup cleanup (with generous age so fresh sessions survive) ---
    // Fresh sessions should NOT be cleaned up with maxAgeDays=7
    const deletedCount = db.cleanupOldSessions(7);
    assert.equal(deletedCount, 0, "fresh sessions should not be cleaned up");

    // Old session should still exist (it was just created)
    assert.ok(db.getSessionStats(oldSid) !== null, "old session should survive fresh cleanup");

    // --- Phase 3: Create a new "current" session ---
    const currentSid = "current-session";
    db.ensureSession(currentSid, "/project/current");

    db.insertEvent(currentSid, {
      type: "file",
      category: "file",
      data: "/project/current/app.ts",
      priority: 1,
    }, "PostToolUse");
    db.insertEvent(currentSid, {
      type: "cwd",
      category: "cwd",
      data: "/project/current",
      priority: 2,
    }, "PostToolUse");

    // --- Phase 4: Simulate compact -- build snapshot and upsert resume ---
    const currentEvents = db.getEvents(currentSid);
    const snapshot = buildResumeSnapshot(currentEvents);
    db.upsertResume(currentSid, snapshot, currentEvents.length);
    db.incrementCompactCount(currentSid);

    // Verify resume is retrievable
    const resume = db.getResume(currentSid);
    assert.ok(resume !== null, "current resume should exist after compact");
    assert.equal(resume!.consumed, 0, "current resume should not be consumed");
    assert.equal(resume!.event_count, currentEvents.length, "event count should match");

    // Verify compact count incremented
    const stats = db.getSessionStats(currentSid);
    assert.equal(stats!.compact_count, 1, "compact_count should be 1");

    // --- Phase 5: Simulate resume/continue -- consume the resume ---
    db.markResumeConsumed(currentSid);
    const consumedResume = db.getResume(currentSid);
    assert.equal(consumedResume!.consumed, 1, "resume should be consumed after SessionStart");

    // After consumption, a subsequent SessionStart should see consumed=1 (noop)
    const secondCheck = db.getResume(currentSid);
    assert.equal(secondCheck!.consumed, 1, "resume should still be consumed on re-check");
  });

  test("deleteSession fully removes old session data", () => {
    const db = createTestDB();
    const sid = "to-delete";
    db.ensureSession(sid, "/project");
    db.insertEvent(sid, {
      type: "file",
      category: "file",
      data: "/project/file.ts",
      priority: 1,
    }, "PostToolUse");
    db.upsertResume(sid, "<session_resume>snapshot</session_resume>", 1);

    // Delete it
    db.deleteSession(sid);

    // Verify all traces are gone
    assert.equal(db.getEventCount(sid), 0, "events should be gone");
    assert.equal(db.getSessionStats(sid), null, "meta should be gone");
    assert.equal(db.getResume(sid), null, "resume should be gone");
  });
});

// ════════════════════════════════════════════
// TEST 6: Empty session produces valid but empty snapshot
// ════════════════════════════════════════════

describe("6. Empty Session Snapshot", () => {
  test("empty session: 0 events produces valid XML with events_captured=0", () => {
    // Build snapshot with empty events array (no DB needed)
    const snapshot = buildResumeSnapshot([]);

    // Verify events="0"
    assert.ok(snapshot.includes('events="0"'), `expected events="0", got: ${snapshot}`);

    // Verify valid XML wrapper
    assert.ok(snapshot.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(snapshot.endsWith("</session_resume>"), "should end with </session_resume>");
  });

  test("empty session from DB: getEvents returns empty, snapshot still valid", () => {
    const db = createTestDB();
    const sid = `empty-${randomUUID()}`;
    db.ensureSession(sid, "/project");

    // No events inserted
    const storedEvents = db.getEvents(sid);
    assert.equal(storedEvents.length, 0, "should have 0 events");

    const snapshot = buildResumeSnapshot(storedEvents);

    assert.ok(snapshot.includes('events="0"'), "should have events_captured=0");
    assert.ok(snapshot.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(snapshot.endsWith("</session_resume>"), "should end with </session_resume>");

    // Even an empty snapshot can be upserted and consumed
    db.upsertResume(sid, snapshot, 0);
    const resume = db.getResume(sid);
    assert.ok(resume !== null, "empty resume should be stored");
    assert.equal(resume!.event_count, 0, "event_count should be 0");
  });
});
