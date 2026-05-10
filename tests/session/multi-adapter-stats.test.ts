/**
 * multi-adapter-stats — B3a (PRD-stats-multi-adapter)
 *
 * Today `getLifetimeStats` and `getRealBytesStats` scan ONE sessionsDir
 * (~/.claude/context-mode/sessions/ by default). The marketing line
 * promises "your work everywhere on this machine across all AI tools" —
 * code MUST aggregate across every adapter dir.
 *
 * This file tests the additive multi-adapter API. Existing single-dir
 * behaviour is covered by `lifetime-stats.test.ts` and
 * `real-bytes-stats.test.ts` and must keep passing untouched.
 *
 * Cited code:
 *   src/session/analytics.ts:592-731  — current getLifetimeStats (single-dir)
 *   src/session/analytics.ts:887-989  — current getRealBytesStats (single-dir)
 *   src/adapters/detect.ts:92-111     — getSessionDirSegments map (15 platforms)
 *
 * Filter (decided in /diagnose conversation, B3a PRD):
 *   real = eventCount >= 100
 *       && distinctProjects >= 5
 *       && lastActivityWithin(30 days)
 *       && avgEventBytes >= 50
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import {
  enumerateAdapterDirs,
  getMultiAdapterLifetimeStats,
  getMultiAdapterRealBytesStats,
  getLifetimeStats,
} from "../../src/session/analytics.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "multi-adapter-home-"));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

function dbPathFor(sessionsDir: string, hash: string): string {
  return join(sessionsDir, `${hash}__suffix.db`);
}

function seed(
  dbPath: string,
  sessionId: string,
  events: Array<{ type: string; category: string; data: string; bytesAvoided?: number; bytesReturned?: number; projectDir?: string }>,
  snapshots?: Array<{ snapshot: string }>,
): void {
  const sdb = new SessionDB({ dbPath });
  try {
    sdb.ensureSession(sessionId, events[0]?.projectDir ?? "/tmp/proj");
    let i = 0;
    for (const e of events) {
      sdb.insertEvent(
        sessionId,
        {
          type: e.type,
          category: e.category,
          priority: 1,
          data: `${e.data}#${i++}`,
          project_dir: e.projectDir ?? "",
          attribution_source: "test",
          attribution_confidence: 1,
        },
        "test",
        undefined,
        { bytesAvoided: e.bytesAvoided, bytesReturned: e.bytesReturned },
      );
    }
    if (snapshots) {
      for (const s of snapshots) sdb.upsertResume(sessionId, s.snapshot, events.length);
    }
  } finally {
    sdb.close();
  }
}

// ─────────────────────────────────────────────────────────
// Slice 2.1 — adapter dir enumeration
// ─────────────────────────────────────────────────────────

describe("Slice 2.1 — enumerateAdapterDirs()", () => {
  test("returns one entry for each of the 15 known adapters", () => {
    const dirs = enumerateAdapterDirs({ home: "/HOME" });
    const names = dirs.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        "antigravity",
        "claude-code",
        "codex",
        "cursor",
        "gemini-cli",
        "jetbrains-copilot",
        "kilo",
        "kiro",
        "omp",
        "opencode",
        "openclaw",
        "pi",
        "qwen-code",
        "vscode-copilot",
        "zed",
      ].sort(),
    );
  });

  test("each entry exposes sessionsDir and contentDir under <home>/<segments>/context-mode/", () => {
    const home = "/HOME";
    const dirs = enumerateAdapterDirs({ home });
    // Use path.join() so the expected prefix/suffix match the platform's
    // separator. enumerateAdapterDirs uses node:path.join under the hood,
    // which emits backslashes on Windows AND converts the leading "/" of
    // "/HOME" to "\\". Normalize the home prefix through join() too — a
    // raw "/HOME" + sep would compare against an apple-and-orange first
    // character on Windows ("/HOME\\..." vs actual "\\HOME\\...").
    const expectedHomePrefix = join(home) + sep;
    const expectedSessionsSuffix = sep + join("context-mode", "sessions");
    const expectedContentSuffix = sep + join("context-mode", "content");
    for (const d of dirs) {
      expect(d.sessionsDir.startsWith(expectedHomePrefix)).toBe(true);
      expect(d.contentDir.startsWith(expectedHomePrefix)).toBe(true);
      expect(d.sessionsDir.endsWith(expectedSessionsSuffix)).toBe(true);
      expect(d.contentDir.endsWith(expectedContentSuffix)).toBe(true);
    }
  });

  test("uses the same segment map as src/adapters/detect.ts:92-111 (claude-code under .claude, kilo under .config/kilo, pi under .pi)", () => {
    const home = "/HOME";
    const dirs = enumerateAdapterDirs({ home });
    const byName = Object.fromEntries(dirs.map((d) => [d.name, d]));
    // Build expectations through path.join so backslashes on Windows match.
    expect(byName["claude-code"].sessionsDir).toBe(join(home, ".claude", "context-mode", "sessions"));
    expect(byName["kilo"].sessionsDir).toBe(join(home, ".config", "kilo", "context-mode", "sessions"));
    expect(byName["pi"].sessionsDir).toBe(join(home, ".pi", "context-mode", "sessions"));
    expect(byName["antigravity"].sessionsDir).toBe(join(home, ".gemini", "context-mode", "sessions"));
    expect(byName["jetbrains-copilot"].sessionsDir).toBe(join(home, ".config", "JetBrains", "context-mode", "sessions"));
  });

  test("defaults to os.homedir() when no override passed", () => {
    const dirs = enumerateAdapterDirs();
    expect(dirs.length).toBe(15);
    const expectedSuffix = sep + join("context-mode", "sessions");
    expect(dirs.every((d) => d.sessionsDir.includes(expectedSuffix))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.2 — multi-adapter scan with per-source breakdown
// ─────────────────────────────────────────────────────────

describe("Slice 2.2 — getMultiAdapterLifetimeStats()", () => {
  test("aggregates totals across two adapter dirs and returns per-adapter breakdown", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));

    seed(dbPathFor(claudeSessions, "aaaaaaaaaaaaaaaa"), `cc-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "src/a.ts", projectDir: "/p/cc" },
      { type: "tool_use", category: "file", data: "src/b.ts", projectDir: "/p/cc" },
    ]);
    seed(dbPathFor(codexSessions, "bbbbbbbbbbbbbbbb"), `cdx-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "src/c.ts", projectDir: "/p/cdx" },
    ]);

    const r = getMultiAdapterLifetimeStats({ home });

    expect(r.totalEvents).toBe(3);
    expect(r.totalSessions).toBe(2);
    expect(typeof r.totalBytes).toBe("number");
    expect(r.totalBytes).toBeGreaterThan(0);

    expect(Array.isArray(r.perAdapter)).toBe(true);
    const byName = Object.fromEntries(r.perAdapter.map((a) => [a.name, a]));
    expect(byName["claude-code"]).toBeDefined();
    expect(byName["claude-code"].eventCount).toBe(2);
    expect(byName["claude-code"].projectDirs).toContain("/p/cc");
    expect(byName["codex"]).toBeDefined();
    expect(byName["codex"].eventCount).toBe(1);
    expect(byName["codex"].projectDirs).toContain("/p/cdx");
  });

  test("each perAdapter entry exposes eventCount, dataBytes, rescueBytes, contentBytes, uuidConvs, projectDirs, firstMs, isReal", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    seed(dbPathFor(claudeSessions, "1111111111111111"), `s-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "x", projectDir: "/p/x" },
    ], [{ snapshot: "Z".repeat(2_000) }]);

    const r = getMultiAdapterLifetimeStats({ home });
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc).toBeDefined();
    expect(typeof cc.eventCount).toBe("number");
    expect(typeof cc.dataBytes).toBe("number");
    expect(typeof cc.rescueBytes).toBe("number");
    expect(typeof cc.contentBytes).toBe("number");
    expect(typeof cc.uuidConvs).toBe("number");
    expect(Array.isArray(cc.projectDirs)).toBe(true);
    expect(typeof cc.firstMs).toBe("number");
    expect(typeof cc.isReal).toBe("boolean");
  });

  test("skips adapter dirs that don't exist on disk (no throw, just absent from perAdapter)", () => {
    const home = tmpHome(); // empty home — no adapter dirs created
    const r = getMultiAdapterLifetimeStats({ home });
    expect(r.totalEvents).toBe(0);
    expect(r.totalSessions).toBe(0);
    expect(r.perAdapter).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.3 — real-usage filter
// ─────────────────────────────────────────────────────────

describe("Slice 2.3 — isReal filter (eventCount>=100 && distinctProjects>=5 && within 30 days && avgBytes>=50)", () => {
  test("flags adapter with only test fixtures (low event count, low projects) as isReal=false", () => {
    const home = tmpHome();
    const sessionsDir = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    // 5 events, 1 project — fails both eventCount>=100 and distinctProjects>=5
    seed(dbPathFor(sessionsDir, "fixtxtxfixtxfixt"), `fx-${randomUUID()}`, [
      { type: "t", category: "file", data: "a", projectDir: "/p" },
      { type: "t", category: "file", data: "b", projectDir: "/p" },
      { type: "t", category: "file", data: "c", projectDir: "/p" },
      { type: "t", category: "file", data: "d", projectDir: "/p" },
      { type: "t", category: "file", data: "e", projectDir: "/p" },
    ]);
    const r = getMultiAdapterLifetimeStats({ home });
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc.isReal).toBe(false);
  });

  test("flags adapter with avgBytes<50 as isReal=false even with many events and projects", () => {
    const home = tmpHome();
    const sessionsDir = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    // 120 tiny events across 6 projects — passes count + projects + recency,
    // but each row data is "x#N" so average bytes < 50.
    const events = [];
    for (let i = 0; i < 120; i++) {
      events.push({ type: "t", category: "file", data: "x", projectDir: `/p/${i % 6}` });
    }
    seed(dbPathFor(sessionsDir, "tinyrowstinyrows"), `tiny-${randomUUID()}`, events);
    const r = getMultiAdapterLifetimeStats({ home });
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc.eventCount).toBeGreaterThanOrEqual(100);
    expect(cc.isReal).toBe(false); // avgBytes too low
  });

  test("flags adapter passing all four thresholds as isReal=true", () => {
    const home = tmpHome();
    const sessionsDir = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    // 120 fat events across 6 projects, all very recent. data is 200 bytes each.
    const fat = "y".repeat(200);
    const events = [];
    for (let i = 0; i < 120; i++) {
      events.push({ type: "t", category: "file", data: fat, projectDir: `/p/${i % 6}` });
    }
    seed(dbPathFor(sessionsDir, "realdatasrealdat"), `real-${randomUUID()}`, events);
    const r = getMultiAdapterLifetimeStats({ home });
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc.eventCount).toBeGreaterThanOrEqual(100);
    expect(cc.projectDirs.length).toBeGreaterThanOrEqual(5);
    expect(cc.isReal).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.4 — real-bytes multi-adapter variant
// ─────────────────────────────────────────────────────────

describe("Slice 2.4 — getMultiAdapterRealBytesStats()", () => {
  test("aggregates real bytes from all adapter dirs (lifetime tier)", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));

    seed(dbPathFor(claudeSessions, "1111111111111111"), `a-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "p", bytesAvoided: 2_000, bytesReturned: 1_000 },
    ]);
    seed(dbPathFor(codexSessions, "2222222222222222"), `b-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "q", bytesAvoided: 3_000 },
    ]);

    const r = getMultiAdapterRealBytesStats({ home });
    expect(r.bytesAvoided).toBe(5_000);
    expect(r.bytesReturned).toBe(1_000);
    expect(r.totalSavedTokens).toBeGreaterThan(0);
    // perAdapter shows split
    expect(r.perAdapter.length).toBeGreaterThanOrEqual(2);
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    const cdx = r.perAdapter.find((a) => a.name === "codex")!;
    expect(cc.bytesAvoided).toBe(2_000);
    expect(cdx.bytesAvoided).toBe(3_000);
  });

  test("sessionId filter narrows to one session across all adapter dirs", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));

    const target = `target-${randomUUID()}`;
    seed(dbPathFor(claudeSessions, "1111111111111111"), target, [
      { type: "x", category: "sandbox", data: "p", bytesAvoided: 7_000 },
    ]);
    seed(dbPathFor(codexSessions, "2222222222222222"), `other-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "q", bytesAvoided: 9_999 },
    ]);

    const r = getMultiAdapterRealBytesStats({ home, sessionId: target });
    expect(r.bytesAvoided).toBe(7_000); // ONLY the matching session_id
  });

  test("worktreeHash filter applies to filename prefix in every adapter dir", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));

    seed(dbPathFor(claudeSessions, "60303a5b5b31fb98"), `a-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "p", bytesReturned: 7_000 },
    ]);
    seed(dbPathFor(codexSessions, "60303a5b5b31fb98"), `b-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "q", bytesReturned: 4_000 },
    ]);
    seed(dbPathFor(claudeSessions, "ffffffffffffffff"), `c-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "r", bytesReturned: 99_999 },
    ]);

    const r = getMultiAdapterRealBytesStats({ home, worktreeHash: "60303a5b5b31fb98" });
    expect(r.bytesReturned).toBe(11_000); // 7_000 + 4_000, NOT 99_999
  });

  test("returns zeroes when no adapter dir exists", () => {
    const home = tmpHome();
    const r = getMultiAdapterRealBytesStats({ home });
    expect(r.eventDataBytes).toBe(0);
    expect(r.bytesAvoided).toBe(0);
    expect(r.bytesReturned).toBe(0);
    expect(r.snapshotBytes).toBe(0);
    expect(r.totalSavedTokens).toBe(0);
    expect(r.perAdapter).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.5 — backward compat (sanity guard inside this file too)
// ─────────────────────────────────────────────────────────

describe("Slice 2.5 — backward compat", () => {
  test("getLifetimeStats and getRealBytesStats are still exported and accept sessionsDir", async () => {
    const m = await import("../../src/session/analytics.js");
    expect(typeof m.getLifetimeStats).toBe("function");
    expect(typeof m.getRealBytesStats).toBe("function");
    expect(typeof m.enumerateAdapterDirs).toBe("function");
    expect(typeof m.getMultiAdapterLifetimeStats).toBe("function");
    expect(typeof m.getMultiAdapterRealBytesStats).toBe("function");
  });

  test("multi-adapter helpers do NOT mutate single-dir behaviour: getLifetimeStats({sessionsDir}) only sees that one dir", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));
    seed(dbPathFor(claudeSessions, "1111111111111111"), `a-${randomUUID()}`, [
      { type: "t", category: "file", data: "x", projectDir: "/p/cc" },
    ]);
    seed(dbPathFor(codexSessions, "2222222222222222"), `b-${randomUUID()}`, [
      { type: "t", category: "file", data: "y", projectDir: "/p/cdx" },
    ]);

    const memoryRoot = ensureDir(join(home, "memory"));
    const single = getLifetimeStats({ sessionsDir: claudeSessions, memoryRoot });
    expect(single.totalEvents).toBe(1); // ONLY claude — not 2
  });
});
