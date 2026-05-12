/**
 * Behavioral tests for the SessionDB-backed statusline pipeline.
 *
 * Until v1.0.111 the statusline read per-PID `stats-pid-*.json` sidecars
 * written by `persistStats()` (src/server.ts:546). Sidecars are
 * eventually-consistent (500ms+30s throttles), PID-scoped (multiple Claude
 * sessions collide on shared shell ppid), and don't carry the multi-adapter
 * aggregation `ctx_stats` already exposes.
 *
 * These tests pin the new contract: statusline reads directly from the
 * same SessionDB (`session_events` + `session_resume`) that powers the
 * `ctx_stats` MCP handler at src/server.ts:2807-2891. This means:
 *   - statusline reflects the current state, no sidecar lag
 *   - multiple sessions don't collide
 *   - multi-adapter aggregation works for cross-tool users
 *
 * Strategy: seed a real SessionDB fixture (no mocks of the analytics
 * layer — that would couple tests to implementation). Drive the statusline
 * end-to-end via spawnSync and assert on its public output.
 */

import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

import { buildIsolatedEnvObject } from "./util/isolated-env.js";


const _hashCanonical = (p: string) => createHash("sha256").update(
  (process.platform === "darwin" || process.platform === "win32") ? p.toLowerCase() : p
).digest("hex").slice(0, 16);

const STATUSLINE = resolve(process.cwd(), "bin", "statusline.mjs");

// Statusline subprocess on windows-latest runner walks git worktrees and reads
// SessionDB analytics with a 1000-row seed; observed p99 ≈ 265s under runner
// load. Mac/Linux finish in <2s — keep the budget tight off-Windows so real
// regressions still trip the test.
const STATUSLINE_SQLITE_TIMEOUT_MS =
  process.platform === "win32" ? 300_000 : 30_000;

// Isolate the spawned statusline's env so getMultiAdapterLifetimeStats()
// (and OpenCode's APPDATA/XDG_CONFIG_HOME paths on Windows) cannot leak data
// from concurrently-running tests or the developer's real adapter dirs into
// render decisions. Multi-adapter tests below explicitly pass their own
// HOME/USERPROFILE in `env` to override this isolation (last spread wins).
// On Windows, scoping HOME/USERPROFILE alone is insufficient —
// APPDATA/LOCALAPPDATA/XDG_* must also be redirected, which was PR #515's
// BRAND_NEW failure mode.
function isolatedHomeEnv(): Record<string, string> {
  return buildIsolatedEnvObject().env;
}

function runStatusline(env: Record<string, string>) {
  const result = spawnSync("node", [STATUSLINE], {
    input: "{}",
    env: { ...process.env, NO_COLOR: "1", ...isolatedHomeEnv(), ...env },
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

/**
 * Create a SessionDB sidecar matching the schema used by src/session/db.ts:273.
 * `worktreeHash` defaults to a deterministic dummy — the statusline doesn't
 * filter by worktree, so any 16-hex value works.
 */
function seedSessionDb(opts: {
  dir: string;
  worktreeHash?: string;
  events: Array<{
    sessionId?: string;
    type?: string;
    category?: string;
    data?: string;
    bytesAvoided?: number;
    bytesReturned?: number;
  }>;
  resume?: { sessionId: string; snapshotBytes: number; eventCount?: number };
}): string {
  const hash = opts.worktreeHash ?? "a".repeat(16);
  const dbPath = join(opts.dir, `${hash}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2,
      data TEXT NOT NULL,
      project_dir TEXT NOT NULL DEFAULT '',
      attribution_source TEXT NOT NULL DEFAULT 'unknown',
      attribution_confidence REAL NOT NULL DEFAULT 0,
      bytes_avoided INTEGER NOT NULL DEFAULT 0,
      bytes_returned INTEGER NOT NULL DEFAULT 0,
      source_hook TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      data_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_event_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      compact_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_resume (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      snapshot TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare(
    `INSERT INTO session_events
     (session_id, type, category, data, bytes_avoided, bytes_returned, source_hook)
     VALUES (?, ?, ?, ?, ?, ?, '')`
  );
  const seenSessions = new Set<string>();
  for (const ev of opts.events) {
    const sid = ev.sessionId ?? "default-session";
    insert.run(
      sid,
      ev.type ?? "tool_use",
      ev.category ?? "tool",
      ev.data ?? "x".repeat(256),
      ev.bytesAvoided ?? 0,
      ev.bytesReturned ?? 0,
    );
    seenSessions.add(sid);
  }
  const insertMeta = db.prepare(
    `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, '/tmp/test')`
  );
  for (const sid of seenSessions) insertMeta.run(sid);
  if (opts.resume) {
    db.prepare(
      `INSERT INTO session_resume (session_id, snapshot, event_count) VALUES (?, ?, ?)`
    ).run(
      opts.resume.sessionId,
      "x".repeat(opts.resume.snapshotBytes),
      opts.resume.eventCount ?? 1,
    );
  }
  db.close();
  return dbPath;
}

describe("statusline.mjs — SessionDB-backed reads", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-statusline-sqlite-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // SLICE 1: lifetime $ comes from SessionDB, not from sidecar JSON.
  // Seed a SessionDB with substantial event data → statusline must render
  // a lifetime $ derived from those bytes (NOT $0.00, NOT a stale sidecar).
  // Per-platform timeout via STATUSLINE_SQLITE_TIMEOUT_MS — Windows runner is
  // ~130× slower than mac/linux on this fork+exec+SQLite-seed pipeline.
  test("renders lifetime $ from SessionDB session_events bytes", { timeout: STATUSLINE_SQLITE_TIMEOUT_MS }, () => {
    // 1000 events × ~256 bytes data = ~256KB → ~64K tokens → ~$0.96
    // Use bytes_avoided so it counts as keptOut savings.
    const events = Array.from({ length: 1000 }, () => ({
      bytesAvoided: 1024, // 1KB avoided per event
      data: "x".repeat(64),
    }));
    seedSessionDb({ dir, events });

    const { stdout } = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "any-session-id",
    });

    assert.match(stdout, /context-mode/, "brand visible");
    // Post-v1.0.118: statusline is byte-based (no $). 1MB avoided over
    // ~100 events seeds a non-trivial kb()-formatted block — proving
    // SessionDB rows were read and aggregated.
    assert.match(
      stdout,
      /\d+(\.\d+)?\s*(B|KB|MB|GB)/,
      "non-zero byte total derived from SessionDB rows",
    );
    assert.match(
      stdout,
      /(this chat|kept out|lifetime)/,
      "byte-based render template is in effect",
    );
    assert.doesNotMatch(stdout, /NaN/);
  });

  // SLICE 1 cont: no SessionDB → headline fallback (substantiated, no $).
  test("empty sessionsDir falls back to substantiated headline", () => {
    // dir exists but has no .db files
    const { stdout } = runStatusline({
      CONTEXT_MODE_SESSION_DIR: dir,
      CLAUDE_SESSION_ID: "any-session-id",
    });
    assert.match(stdout, /context-mode/);
    assert.match(stdout, /saves ~98% of context window/);
    assert.doesNotMatch(stdout, /\$\d+\/dev\/month/);
  });
});

// ── Slice 2: multi-adapter aggregation ───────────────────────────────────
// When 2+ real adapters are detected on disk, the statusline shows the
// multi-adapter total instead of just the active adapter's $. This mirrors
// the `multiAdapter` block ctx_stats already renders (src/server.ts:2840).
//
// `getMultiAdapterLifetimeStats({ home })` walks every adapter dir under
// `home`. We seed two adapter dirs with enough events to cross the
// `isReal` threshold (>=100 events, >=5 distinct projects, recent,
// avg bytes >= 50 — see DEFAULT_REAL_USAGE_FILTER at analytics.ts:1162).
describe("statusline.mjs — multi-adapter aggregation", () => {
  let home: string;
  let claudeSessionsDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ctx-statusline-multi-"));
    // Mirror real adapter layout: ~/.claude/context-mode/sessions for
    // claude-code, ~/.gemini/context-mode/sessions for gemini-cli, etc.
    claudeSessionsDir = join(home, ".claude", "context-mode", "sessions");
    mkdirSync(claudeSessionsDir, { recursive: true });
    mkdirSync(join(home, ".gemini", "context-mode", "sessions"), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function seedRealAdapter(sessionsDir: string, projectSeed: string) {
    // 200 events across 6 distinct project_dirs, recent created_at, avg bytes ~256.
    // Crosses the isReal filter at analytics.ts:1300-1304.
    const dbPath = join(sessionsDir, `${_hashCanonical(projectSeed)}.db`);
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
        bytes_avoided INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        source_hook TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );
    `);
    const ins = db.prepare(
      `INSERT INTO session_events (session_id, type, category, data, project_dir, bytes_avoided, source_hook)
       VALUES (?, 'tool_use', 'tool', ?, ?, 1024, '')`,
    );
    const meta = db.prepare(
      `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)`,
    );
    for (let i = 0; i < 200; i++) {
      const proj = `/p/${projectSeed}/${i % 6}`;
      ins.run(`sid-${projectSeed}-${i}`, "x".repeat(256), proj);
      meta.run(`sid-${projectSeed}-${i}`, proj);
    }
    db.close();
  }

  // Slice 2 RED: with TWO real adapters seeded under HOME, the statusline
  // surfaces the cross-tool aggregate. Counts adapters via "across N tools".
  // 60s timeout for the same reason as the slice 1 test above — Windows is
  // slow at fork+exec and the multi-adapter walk multiplies the cost.
  test("renders 'across N tools' when 2+ real adapters detected", { timeout: 60_000 }, () => {
    seedRealAdapter(join(home, ".claude", "context-mode", "sessions"), "claude");
    seedRealAdapter(join(home, ".gemini", "context-mode", "sessions"), "gemini");

    const { stdout } = runStatusline({
      // statusline must use HOME for multi-adapter walk
      HOME: home,
      USERPROFILE: home,
      // active adapter dir is the claude one (matches getSessionDir() default)
      CONTEXT_MODE_SESSION_DIR: claudeSessionsDir,
      CLAUDE_SESSION_ID: "any-session-id",
    });

    assert.match(stdout, /context-mode/);
    assert.match(
      stdout,
      /across\s+\d+\s+tools?/i,
      "shows multi-adapter aggregate when 2+ real adapters",
    );
  });

  // Slice 2 cont: with only ONE real adapter, do NOT show "across N tools".
  test("single real adapter: no 'across N tools' suffix", () => {
    seedRealAdapter(join(home, ".claude", "context-mode", "sessions"), "claude");

    const { stdout } = runStatusline({
      HOME: home,
      USERPROFILE: home,
      CONTEXT_MODE_SESSION_DIR: claudeSessionsDir,
      CLAUDE_SESSION_ID: "any-session-id",
    });

    assert.match(stdout, /context-mode/);
    assert.doesNotMatch(
      stdout,
      /across\s+\d+\s+tools?/i,
      "single adapter must not advertise multi-tool",
    );
  });
});
