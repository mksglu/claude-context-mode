/**
 * Session Continuity Tests
 *
 * Consolidated from:
 * - tests/sessionstart-integration.test.ts (SessionStart Hook)
 * - tests/snapshot-task-state.test.ts (renderTaskState)
 * - tests/session-directive-tasks.test.ts (buildSessionDirective + writeSessionEventsFile)
 */

import { describe, test, it, expect, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { renderTaskState, type StoredEvent } from "../../src/session/snapshot.js";
import { buildSessionDirective, writeSessionEventsFile, groupEvents } from "../../hooks/session-directive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, "..", "..", "hooks", "sessionstart.mjs");

// ── Helpers ──────────────────────────────────────────────────────────

function runHook(input: Record<string, unknown>) {
  const result = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function makeTaskEvent(data: string): StoredEvent {
  return { type: "task", category: "task", data, priority: 1 };
}

function makeEvent(category: string, data: string, type: string = category) {
  return { type, category, data, priority: 1, created_at: new Date().toISOString() };
}

// ── SessionStart Hook ────────────────────────────────────────────────

describe("SessionStart Hook", () => {
  test("SessionStart: outputs additionalContext with XML routing block", () => {
    const result = runHook({});
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
    assert.ok(result.stdout.length > 0, "Expected non-empty stdout");
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput, "Expected hookSpecificOutput");
    assert.equal(
      parsed.hookSpecificOutput.hookEventName,
      "SessionStart",
      "Expected hookEventName to be SessionStart",
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext,
      "Expected additionalContext in hookSpecificOutput",
    );
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes("<context_window_protection>"),
      "Expected <context_window_protection> opening tag",
    );
    assert.ok(
      ctx.includes("</context_window_protection>"),
      "Expected </context_window_protection> closing tag",
    );
    assert.ok(
      ctx.includes("<tool_selection_hierarchy>"),
      "Expected <tool_selection_hierarchy> tag",
    );
    assert.ok(
      ctx.includes("<forbidden_actions>"),
      "Expected <forbidden_actions> tag",
    );
    assert.ok(
      ctx.includes("<output_constraints>"),
      "Expected <output_constraints> tag",
    );
    assert.ok(
      ctx.includes("batch_execute"),
      "Expected batch_execute mentioned in routing block",
    );
  });

  test("SessionStart: routing block contains tool selection hierarchy", () => {
    const result = runHook({});
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("GATHER"), "Expected GATHER step");
    assert.ok(ctx.includes("FOLLOW-UP"), "Expected FOLLOW-UP step");
    assert.ok(ctx.includes("PROCESSING"), "Expected PROCESSING step");
  });

  test("SessionStart: routing block contains output constraints", () => {
    const result = runHook({});
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("500 words"), "Expected 500-word limit");
    assert.ok(
      ctx.includes("Write artifacts"),
      "Expected artifact policy",
    );
  });
});

// ── renderTaskState — task completion filtering ──────────────────────

describe("renderTaskState — task completion filtering", () => {
  it("returns empty for no events", () => {
    expect(renderTaskState([])).toBe("");
  });

  it("renders pending tasks (no updates)", () => {
    const events = [
      makeTaskEvent(JSON.stringify({ subject: "Fix auth bug" })),
      makeTaskEvent(JSON.stringify({ subject: "Add tests" })),
    ];
    const result = renderTaskState(events);
    expect(result).toContain("Fix auth bug");
    expect(result).toContain("Add tests");
    expect(result).toContain("<task_state>");
  });

  it("filters out completed tasks", () => {
    const events = [
      makeTaskEvent(JSON.stringify({ subject: "Fix auth bug" })),
      makeTaskEvent(JSON.stringify({ subject: "Add tests" })),
      makeTaskEvent(JSON.stringify({ taskId: "1", status: "completed" })),
      makeTaskEvent(JSON.stringify({ taskId: "2", status: "completed" })),
    ];
    const result = renderTaskState(events);
    expect(result).toBe("");
  });

  it("keeps in-progress tasks, filters completed", () => {
    const events = [
      makeTaskEvent(JSON.stringify({ subject: "Fix auth bug" })),
      makeTaskEvent(JSON.stringify({ subject: "Add tests" })),
      makeTaskEvent(JSON.stringify({ subject: "Update docs" })),
      makeTaskEvent(JSON.stringify({ taskId: "1", status: "completed" })),
      makeTaskEvent(JSON.stringify({ taskId: "2", status: "in_progress" })),
    ];
    const result = renderTaskState(events);
    expect(result).not.toContain("Fix auth bug");
    expect(result).toContain("Add tests");
    expect(result).toContain("Update docs");
  });

  it("handles mixed create/update event order", () => {
    const events = [
      makeTaskEvent(JSON.stringify({ subject: "Task A" })),
      makeTaskEvent(JSON.stringify({ taskId: "1", status: "in_progress" })),
      makeTaskEvent(JSON.stringify({ subject: "Task B" })),
      makeTaskEvent(JSON.stringify({ taskId: "1", status: "completed" })),
      makeTaskEvent(JSON.stringify({ taskId: "2", status: "in_progress" })),
    ];
    const result = renderTaskState(events);
    expect(result).not.toContain("Task A");
    expect(result).toContain("Task B");
  });

  it("uses last status when task is updated multiple times", () => {
    const events = [
      makeTaskEvent(JSON.stringify({ subject: "Deploy fix" })),
      makeTaskEvent(JSON.stringify({ taskId: "1", status: "in_progress" })),
      makeTaskEvent(JSON.stringify({ taskId: "1", status: "completed" })),
    ];
    const result = renderTaskState(events);
    expect(result).toBe("");
  });

  it("handles non-JSON task data gracefully", () => {
    const events = [
      makeTaskEvent("some plain text task"),
      makeTaskEvent(JSON.stringify({ subject: "Real task" })),
    ];
    const result = renderTaskState(events);
    expect(result).toContain("Real task");
  });

  it("renders only creates with no matching updates as pending", () => {
    const events = [
      makeTaskEvent(JSON.stringify({ subject: "Task 1" })),
      makeTaskEvent(JSON.stringify({ subject: "Task 2" })),
      makeTaskEvent(JSON.stringify({ subject: "Task 3" })),
    ];
    const result = renderTaskState(events);
    expect(result).toContain("Task 1");
    expect(result).toContain("Task 2");
    expect(result).toContain("Task 3");
  });
});

// ── buildSessionDirective — task completion filtering ────────────────

describe("buildSessionDirective — task completion filtering", () => {
  it("excludes completed tasks from session guide", () => {
    const events = [
      makeEvent("prompt", "Fix the auth bug"),
      makeEvent("task", JSON.stringify({ subject: "Fix auth bug" })),
      makeEvent("task", JSON.stringify({ subject: "Add tests" })),
      makeEvent("task", JSON.stringify({ taskId: "1", status: "completed" })),
      makeEvent("task", JSON.stringify({ taskId: "2", status: "completed" })),
    ];
    const { grouped, lastPrompt, fileNames } = groupEvents(events);
    const result = buildSessionDirective("compact", { grouped, lastPrompt, fileNames });

    expect(result).not.toContain("## Pending Tasks");
    expect(result).not.toContain("Fix auth bug");
    expect(result).not.toContain("Add tests");
  });

  it("shows only pending/in-progress tasks", () => {
    const events = [
      makeEvent("task", JSON.stringify({ subject: "Task A" })),
      makeEvent("task", JSON.stringify({ subject: "Task B" })),
      makeEvent("task", JSON.stringify({ subject: "Task C" })),
      makeEvent("task", JSON.stringify({ taskId: "1", status: "completed" })),
      makeEvent("task", JSON.stringify({ taskId: "2", status: "in_progress" })),
    ];
    const { grouped, lastPrompt, fileNames } = groupEvents(events);
    const result = buildSessionDirective("compact", { grouped, lastPrompt, fileNames });

    expect(result).toContain("## Pending Tasks");
    expect(result).not.toContain("Task A");
    expect(result).toContain("Task B");
    expect(result).toContain("Task C");
  });

  it("uses heading 'Pending Tasks' not 'Tasks'", () => {
    const events = [
      makeEvent("task", JSON.stringify({ subject: "Incomplete task" })),
    ];
    const { grouped, lastPrompt, fileNames } = groupEvents(events);
    const result = buildSessionDirective("compact", { grouped, lastPrompt, fileNames });

    expect(result).toContain("## Pending Tasks");
    expect(result).not.toMatch(/## Tasks\n/);
  });

  it("handles all tasks completed — no task section", () => {
    const events = [
      makeEvent("task", JSON.stringify({ subject: "Done task" })),
      makeEvent("task", JSON.stringify({ taskId: "1", status: "completed" })),
    ];
    const { grouped, lastPrompt, fileNames } = groupEvents(events);
    const result = buildSessionDirective("compact", { grouped, lastPrompt, fileNames });

    expect(result).not.toContain("Pending Tasks");
    expect(result).not.toContain("Done task");
  });
});

// ── writeSessionEventsFile — status-aware task sections ──────────────

describe("writeSessionEventsFile — status-aware task sections", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("splits tasks into In Progress and Completed sections", () => {
    const events = [
      makeEvent("task", JSON.stringify({ subject: "Pending task" })),
      makeEvent("task", JSON.stringify({ subject: "Done task" })),
      makeEvent("task", JSON.stringify({ taskId: "1", status: "in_progress" })),
      makeEvent("task", JSON.stringify({ taskId: "2", status: "completed" })),
    ];
    const eventsPath = join(tmpDir, "events.md");
    writeSessionEventsFile(events, eventsPath);
    const content = readFileSync(eventsPath, "utf-8");

    expect(content).toContain("## Tasks In Progress");
    expect(content).toContain("- Pending task");
    expect(content).toContain("## Tasks Completed");
    expect(content).toContain("- Done task");
  });

  it("only shows In Progress section when no tasks completed", () => {
    const events = [
      makeEvent("task", JSON.stringify({ subject: "Task A" })),
      makeEvent("task", JSON.stringify({ subject: "Task B" })),
    ];
    const eventsPath = join(tmpDir, "events.md");
    writeSessionEventsFile(events, eventsPath);
    const content = readFileSync(eventsPath, "utf-8");

    expect(content).toContain("## Tasks In Progress");
    expect(content).not.toContain("## Tasks Completed");
  });

  it("only shows Completed section when all tasks done", () => {
    const events = [
      makeEvent("task", JSON.stringify({ subject: "Task A" })),
      makeEvent("task", JSON.stringify({ taskId: "1", status: "completed" })),
    ];
    const eventsPath = join(tmpDir, "events.md");
    writeSessionEventsFile(events, eventsPath);
    const content = readFileSync(eventsPath, "utf-8");

    expect(content).not.toContain("## Tasks In Progress");
    expect(content).toContain("## Tasks Completed");
    expect(content).toContain("- Task A");
  });
});
