/**
 * lifetime-stats — Bug #3 + #4
 *
 * Bug #3: Persistent memory totals (events across all sessions, not just
 * the current one) must be visible in ctx_stats so the user sees the
 * cumulative value of context-mode.
 *
 * Bug #4: Auto-memory captured by Claude Code under
 * ~/.claude/projects/<project>/memory/*.md is invisible today. ctx_stats
 * should surface the count and the projects involved.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { getLifetimeStats } from "../../src/session/analytics.js";

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function tmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tmpDbPath(dir: string, name: string): string {
  return join(dir, `${name}.db`);
}

function makeEvent(data: string) {
  return {
    type: "file",
    category: "file",
    data,
    priority: 2,
    data_hash: "",
  };
}

describe("getLifetimeStats — cross-session totals + auto-memory", () => {
  test("aggregates totalEvents and totalSessions across multiple SessionDBs", () => {
    const sessionsDir = tmpDir("sessions");

    const db1 = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "proj-a") });
    cleanups.push(() => db1.cleanup());
    db1.ensureSession("sess-a1", "/p/a");
    db1.insertEvent("sess-a1", makeEvent("/p/a/x.ts"), "PostToolUse");
    db1.ensureSession("sess-a2", "/p/a");
    db1.insertEvent("sess-a2", makeEvent("/p/a/y.ts"), "PostToolUse");
    db1.close();

    const db2 = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "proj-b") });
    cleanups.push(() => db2.cleanup());
    db2.ensureSession("sess-b1", "/p/b");
    db2.insertEvent("sess-b1", makeEvent("/p/b/m.ts"), "PostToolUse");
    db2.insertEvent("sess-b1", makeEvent("/p/b/n.ts"), "PostToolUse");
    db2.close();

    const memoryRoot = tmpDir("projects-empty");

    const stats = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(stats.totalEvents).toBe(4);
    expect(stats.totalSessions).toBe(3);
  });

  test("counts auto-memory files across project subdirs", () => {
    const sessionsDir = tmpDir("sessions-empty");
    const memoryRoot = tmpDir("projects-with-memory");

    // ~/.claude/projects/<project>/memory/<file>.md
    const projA = join(memoryRoot, "proj-a", "memory");
    const projB = join(memoryRoot, "proj-b", "memory");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    writeFileSync(join(projA, "user_identity.md"), "name: Mert");
    writeFileSync(join(projA, "feedback_push.md"), "always push to next");
    writeFileSync(join(projB, "project_notes.md"), "hello");
    // Non-md file should be ignored
    writeFileSync(join(projB, "ignore.txt"), "skip me");

    const stats = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(stats.autoMemoryCount).toBe(3);
    expect(stats.autoMemoryProjects).toBe(2);
  });

  test("returns zero stats when no DBs and no memory dirs exist", () => {
    const sessionsDir = tmpDir("none-sessions");
    const memoryRoot = tmpDir("none-memory");
    const stats = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(stats.totalEvents).toBe(0);
    expect(stats.totalSessions).toBe(0);
    expect(stats.autoMemoryCount).toBe(0);
    expect(stats.autoMemoryProjects).toBe(0);
  });

  // ── Cycle 2: aggregate per-category counts across every SessionDB ──
  test("aggregates categoryCounts across multiple SessionDBs", () => {
    const sessionsDir = tmpDir("sessions-cats");

    function eventOfCategory(cat: string, data: string) {
      return { type: cat, category: cat, data, priority: 2, data_hash: "" };
    }

    const db1 = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "proj-a") });
    cleanups.push(() => db1.cleanup());
    db1.ensureSession("sess-a1", "/p/a");
    db1.insertEvent("sess-a1", eventOfCategory("file", "/p/a/x.ts"), "PostToolUse");
    db1.insertEvent("sess-a1", eventOfCategory("file", "/p/a/y.ts"), "PostToolUse");
    db1.insertEvent("sess-a1", eventOfCategory("cwd", "/p/a"), "PostToolUse");
    db1.close();

    const db2 = new SessionDB({ dbPath: tmpDbPath(sessionsDir, "proj-b") });
    cleanups.push(() => db2.cleanup());
    db2.ensureSession("sess-b1", "/p/b");
    db2.insertEvent("sess-b1", eventOfCategory("file", "/p/b/m.ts"), "PostToolUse");
    db2.insertEvent("sess-b1", eventOfCategory("rule", "AGENTS.md"), "PostToolUse");
    db2.close();

    const memoryRoot = tmpDir("projects-empty-cats");
    const stats = getLifetimeStats({ sessionsDir, memoryRoot });
    expect(stats.categoryCounts).toBeDefined();
    expect(stats.categoryCounts.file).toBe(3); // 2 from a + 1 from b
    expect(stats.categoryCounts.cwd).toBe(1);
    expect(stats.categoryCounts.rule).toBe(1);
  });
});
